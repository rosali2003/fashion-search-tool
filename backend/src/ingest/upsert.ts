import { sql } from 'kysely'
import { db } from '../db/index.js'
import { NORMALIZER_VERSION, type ProductRow } from './normalize.js'

export interface UpsertStats {
  seen: number
  inserted: number
  updated: number
  skippedUnchanged: number
  deactivated: number
  deactivationSkipped: boolean
  /** When the crawl ran, from the scraped records. What recordRun stamps on the brand. */
  crawledAt: Date
}

/**
 * Fraction of a brand's currently-active products that must be present in a new
 * run before absent products are deactivated.
 *
 * This guard exists because the refresh runs unattended from cron. Aritzia
 * already sticky-blocks scrapers and needs a fresh browser context per product;
 * a half-blocked overnight run would otherwise soft-delete most of the catalog
 * and the first anyone would know is an empty search page in the morning.
 */
const DEACTIVATION_FLOOR = 0.5

/**
 * Consecutive days a product must go unseen before it is deactivated — the floor
 * of the window. The window actually applied is the larger of this and two of
 * the brand's `refresh_frequency` intervals, see upsertBrand.
 *
 * Absence from one crawl is not evidence a product is gone. The scrapers cap at
 * MAX_PRODUCTS (50 for Aritzia and Gap) across a handful of listing pages, so
 * each run samples a different subset as listing order shifts — the catalog is a
 * sample, not a census. Two Aritzia crawls one day apart shared only part of
 * their assortment, and deactivating on first absence removed 8 products that
 * are almost certainly still for sale, including every halter top the golden set
 * referenced.
 *
 * A staleness window is robust to that: a product genuinely delisted stops
 * appearing in every run and ages out; one that merely fell out of today's
 * sample is seen again tomorrow and its last_seen_at refreshes.
 *
 * "Seen again tomorrow" assumed a daily crawl. Now that brands are crawled on
 * their own cadence, a fixed 7-day window would deactivate every product outside
 * the sample of a fortnightly brand's run, since by then everything is older
 * than the window — the sample-not-census protection would be gone. Scaling the
 * window to two crawl intervals keeps the original meaning: a product has to be
 * missing from consecutive runs, not just from one.
 */
const STALE_AFTER_DAYS = Number(process.env.INK_STALE_AFTER_DAYS ?? 7)

/**
 * Columns the enrichment pass owns. Ingest must never write these on update, or
 * a daily re-ingest wipes extraction work and the cron re-pays for all of it.
 *
 * Listed explicitly rather than matched by prefix. A prefix rule on
 * `attributes_` also caught `attributes_version`, which is the *normaliser*
 * marker that ingest owns and that the skip-unchanged check compares against —
 * so it never advanced, every row looked stale, and ingest stopped skipping
 * anything ("updated 298, unchanged 0"). The two concerns share a prefix but not
 * an owner.
 */
const ENRICHMENT_OWNED = new Set([
  // Written at ingest as [] (there is no vision pass yet to disagree with) and
  // again by enrich with the real disagreements. Without it here, every ingest
  // erased the enrichment-time log while leaving the v_* columns intact, so the
  // rate enrich prints only ever covered products enriched since the last
  // ingest. Production read "0 conflicts / 295 vision-done" — not zero
  // disagreements, just no surviving evidence of them — which makes the
  // day-over-day comparison enrich.ts calls "the cheapest available signal that
  // an extractor regressed" unable to signal anything.
  'attribute_conflicts',
  'attributes_source',
  'attributes_model',
  'attributes_at',
  'vision_version',
  'vision_model',
  'vision_at',
  'vision_image_set_hash',
])

/**
 * Upsert one brand's products, keyed on product_url.
 *
 * `product_url` is the only stable natural key the scrapers emit: there is no id
 * or SKU field, and 13 (brand, name) pairs collide in the corpus.
 *
 * Rows whose source bytes and normaliser version are both unchanged are skipped
 * outright — the mechanism that makes a daily refresh nearly free.
 */
export async function upsertBrand(brand: string, rows: ProductRow[]): Promise<UpsertStats> {
  // products.brand is a foreign key to brands.slug. Checked up front so a new
  // scraper that was never registered fails with a sentence, not a constraint
  // name — and because the brand's cadence sizes the staleness window below.
  const registered = await db
    .selectFrom('brands')
    .select('refresh_frequency')
    .where('slug', '=', brand)
    .executeTakeFirst()
  if (!registered) {
    throw new Error(
      `${brand}: not in the brands table. Register it (slug, display_name, refresh_frequency) in a migration before ingesting.`,
    )
  }

  // When the crawl actually ran, taken from the scraped records themselves.
  const crawledAt =
    rows.reduce<Date | null>((max, r) => {
      const d = r.scraped_at instanceof Date ? r.scraped_at : null
      return d && (!max || d > max) ? d : max
    }, null) ?? new Date()

  const stats: UpsertStats = {
    seen: rows.length,
    inserted: 0,
    updated: 0,
    skippedUnchanged: 0,
    deactivated: 0,
    deactivationSkipped: false,
    crawledAt,
  }

  const existing = await db
    .selectFrom('products')
    .select(['product_url', 'content_hash', 'attributes_version'])
    .where('brand', '=', brand)
    .execute()

  const byUrl = new Map(existing.map((r) => [r.product_url, r]))
  const activeBefore = existing.length

  for (const row of rows) {
    const prev = byUrl.get(row.product_url as string)

    if (prev && prev.content_hash === row.content_hash && prev.attributes_version === NORMALIZER_VERSION) {
      // Source unchanged and normalisation current: touch liveness only.
      // last_seen_at is the CRAWL's timestamp, not the ingest's. Re-ingesting an
      // old run directory must not make six-week-old products look freshly seen —
      // doing so defeats the staleness window entirely, which is how a June
      // snapshot and an August one ended up active simultaneously.
      await db
        .updateTable('products')
        .set({ last_seen_at: crawledAt, source_run: row.source_run, is_active: true })
        .where('product_url', '=', row.product_url as string)
        .execute()
      stats.skippedUnchanged++
      continue
    }

    await db
      .insertInto('products')
      .values(row)
      .onConflict((oc) =>
        oc.column('product_url').doUpdateSet(({ ref }) => {
          // Everything except the immutable identity columns. first_seen_at is
          // deliberately preserved so "new arrival" stays meaningful across runs.
          //
          // Enrichment columns are excluded entirely. An earlier version wrote
          // the whole row, including vision_version: 0, which meant the daily
          // refresh reset every product's extraction state and the cron would
          // have re-paid for all 299 products every day. image_set_hash still
          // updates, so a genuine image change is still noticed — see
          // migration 007.
          const { product_url: _url, ...rest } = row as Record<string, unknown>
          for (const k of Object.keys(rest)) {
            if (ENRICHMENT_OWNED.has(k) || k.startsWith('v_')) delete rest[k]
          }
          return { ...rest, last_seen_at: crawledAt } as never
        }),
      )
      .execute()

    if (prev) stats.updated++
    else stats.inserted++
  }

  // --- soft delete --------------------------------------------------------
  const seenUrls = rows.map((r) => r.product_url as string)

  if (activeBefore > 0 && seenUrls.length < activeBefore * DEACTIVATION_FLOOR) {
    stats.deactivationSkipped = true
    return stats
  }

  if (seenUrls.length > 0) {
    // Never DELETE: the eval golden set references product_url and must stay
    // resolvable, or metrics silently stop being comparable across runs.
    //
    // And never deactivate on a single absence — only once a product has gone
    // unseen for STALE_AFTER_DAYS. `last_seen_at` is refreshed for everything in
    // this run above, so this only catches products that have been missing from
    // every run across the window.
    const res = await db
      .updateTable('products')
      .set({ is_active: false })
      .where('brand', '=', brand)
      .where('is_active', '=', true)
      .where('product_url', 'not in', seenUrls)
      .where(
        sql<boolean>`last_seen_at < now() - greatest(
          make_interval(days => ${STALE_AFTER_DAYS}),
          2 * ${registered.refresh_frequency}::interval
        )`,
      )
      .executeTakeFirst()
    stats.deactivated = Number(res.numUpdatedRows ?? 0)
  }

  return stats
}

export async function recordRun(
  runDir: string,
  brand: string,
  s: UpsertStats,
  extra: { llmCalls?: number; visionCalls?: number; costUsd?: number; durationMs?: number },
): Promise<void> {
  await db
    .insertInto('ingest_runs')
    .values({
      run_dir: runDir,
      brand,
      seen: s.seen,
      inserted: s.inserted,
      updated: s.updated,
      deactivated: s.deactivated,
      skipped_unchanged: s.skippedUnchanged,
      llm_calls: extra.llmCalls ?? 0,
      vision_calls: extra.visionCalls ?? 0,
      cost_usd: extra.costUsd ?? 0,
      duration_ms: extra.durationMs ?? null,
    })
    .execute()

  // The cadence clock. greatest() so re-ingesting an older run directory never
  // moves it backwards, and the crawl's timestamp so it never moves forward
  // without a real crawl.
  await db
    .updateTable('brands')
    .set({ last_scraped_at: sql`greatest(last_scraped_at, ${s.crawledAt}::timestamptz)` })
    .where('slug', '=', brand)
    .execute()
}

/** Coverage report over the whole active catalog. Drives the ingest checkpoints. */
export async function coverageReport(): Promise<Record<string, unknown>> {
  const row = await db
    .selectFrom('products')
    .select(({ fn, eb }) => [
      fn.countAll<number>().as('total'),
      fn.count<number>('category').as('category'),
      fn.count<number>('neckline').as('neckline'),
      fn.count<number>('silhouette').as('silhouette'),
      fn.count<number>('natural_ratio').as('natural_ratio'),
      fn.count<number>('material_clean').as('material_clean'),
      eb
        .case()
        .when(sql<boolean>`true`)
        .then(sql<number>`count(*) filter (where cardinality(fiber_names) > 0)`)
        .end()
        .as('fibers'),
      sql<number>`count(*) filter (where cardinality(details) > 0)`.as('details'),
      sql<number>`count(*) filter (where cardinality(image_hashes) > 0)`.as('images'),
      sql<number>`count(*) filter (where jsonb_array_length(attribute_conflicts) > 0)`.as('conflicts'),
      sql<number>`count(*) filter (where fibers_incomplete)`.as('fibers_incomplete'),
      sql<number>`count(*) filter (where vision_version > 0)`.as('vision_done'),
    ])
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow()

  return row as unknown as Record<string, unknown>
}
