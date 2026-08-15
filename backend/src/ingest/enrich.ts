/**
 * LLM enrichment: text attributes and vision geometry.
 *
 *   pnpm --filter backend enrich                 both passes, only stale rows
 *   pnpm --filter backend enrich -- --text       text attributes only
 *   pnpm --filter backend enrich -- --vision     vision geometry only
 *   pnpm --filter backend enrich -- --limit 20   cap the number of products
 *   pnpm --filter backend enrich -- --dry-run    report what it would cost, spend nothing
 *
 * Separate from `ingest` on purpose. Ingest is deterministic and offline, so the
 * catalog is searchable before an API key exists; this is the paid path.
 *
 * Both passes are driven by a DATABASE PREDICATE rather than an in-memory cursor
 * (`attributes_version < CURRENT`, `vision_image_set_hash <> last extracted`), so
 * killing this mid-run and restarting resumes exactly where it stopped. That
 * matters for the daily cron, where a partial run must not mean a wasted one.
 */
import { sql } from 'kysely'
import { db } from '../db/index.js'
import { llmAvailable, addUsage, costUsd, emptyUsage, describeLlm, missingKeyHint, type Usage } from '../llm/client.js'
import { modelForStage } from '../llm/models.js'
import { EXTRACTION_VERSION, extractBatch, type ExtractionInput } from '../llm/extract.js'
import { VISION_VERSION, extractVision } from '../llm/vision.js'
import { resolveAttributes, renderSearchFields, type TextAttributes, type VisionAttributes } from '../normalize/render.js'

const TEXT_BATCH = 8

/**
 * Vision pacing.
 *
 * Images are expensive in tokens — measured at ~3,600 per image on gpt-5-nano, so
 * ~25-29k for a product with the full 8-image gallery. OpenAI's default limit is
 * 200k tokens per minute, which four concurrent calls exhaust in seconds:
 *
 *   429 Rate limit reached ... on tokens per min (TPM):
 *       Limit 200000, Used 197987, Requested 6406
 *
 * So the throttle is token-aware rather than a fixed concurrency or sleep. It
 * tracks spend in a rolling 60s window and waits only when the next call would
 * breach the budget. Concurrency drops to 2 because a single call is already a
 * large fraction of the per-minute allowance.
 */
const VISION_CONCURRENCY = 2
/** Leave headroom: the text pass and any other client share the same quota. */
const TPM_BUDGET = Number(process.env.INK_TPM_BUDGET ?? 180_000)
/** Conservative per-call estimate used before the real usage is known. */
const EST_TOKENS_PER_CALL = 30_000

const spend: { at: number; tokens: number }[] = []

function recordSpend(tokens: number): void {
  spend.push({ at: Date.now(), tokens })
}

/** Block until `estimate` more tokens fit inside the rolling minute. */
async function awaitBudget(estimate: number): Promise<void> {
  for (;;) {
    const cutoff = Date.now() - 60_000
    while (spend.length > 0 && spend[0].at < cutoff) spend.shift()
    const used = spend.reduce((n, s) => n + s.tokens, 0)
    if (used + estimate <= TPM_BUDGET) return

    // Wait until the oldest entry ages out of the window, plus a small margin.
    const waitMs = Math.max(1_000, spend[0].at + 60_000 - Date.now() + 250)
    await new Promise((r) => setTimeout(r, waitMs))
  }
}

interface Args {
  text: boolean
  vision: boolean
  limit: number | null
  dryRun: boolean
  reextract: boolean
}

function parseArgs(argv: string[]): Args {
  const has = (f: string) => argv.includes(f)
  const val = (f: string) => {
    const i = argv.indexOf(f)
    return i === -1 ? null : argv[i + 1]
  }
  const only = has('--text') || has('--vision')
  const limit = val('--limit')
  return {
    text: has('--text') || !only,
    vision: has('--vision') || !only,
    limit: limit ? Number(limit) : null,
    dryRun: has('--dry-run'),
    reextract: has('--reextract'),
  }
}

/** Re-resolve precedence and rebuild the search fields for one product. */
async function rewriteSearchFields(id: number): Promise<void> {
  const p = await db.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirst()
  if (!p) return

  const text: TextAttributes = {
    category: p.category, subcategory: p.subcategory, silhouette: p.silhouette,
    neckline: p.neckline, sleeve_length: p.sleeve_length, length: p.length,
    rise: p.rise, fit: p.fit, pattern: p.pattern,
    colors: p.colors, details: p.details, occasion: p.occasion, season: p.season,
  }
  const vision: VisionAttributes = {
    v_category: p.v_category, v_silhouette: p.v_silhouette, v_neckline: p.v_neckline,
    v_sleeve_length: p.v_sleeve_length, v_length: p.v_length, v_pattern: p.v_pattern,
    v_colors: p.v_colors, v_details: p.v_details, v_rise: p.v_rise,
    v_waist_position: p.v_waist_position, v_hem_break: p.v_hem_break,
    v_shoulder_treatment: p.v_shoulder_treatment, v_neckline_width: p.v_neckline_width,
    v_volume: p.v_volume, v_vertical_line: p.v_vertical_line,
    v_waist_definition: p.v_waist_definition, v_drape: p.v_drape,
    v_structure: p.v_structure, v_finish_cues: p.v_finish_cues,
  }

  const resolved = resolveAttributes(text, p.vision_version > 0 ? vision : null)
  const search = renderSearchFields({
    name: p.name, name_variant: p.name_variant, brand: p.brand,
    description_clean: p.description_clean, material_clean: p.material_clean,
    fiber_names: p.fiber_names, fabric: p.fabric,
    resolved, vision: p.vision_version > 0 ? vision : null,
    size_range: p.size_range, fit_notes: p.fit_notes,
  })

  // Write ONLY the rendered search fields and the conflict log.
  //
  // An earlier version also wrote the resolved facets back into the text columns,
  // which was destructive: resolution gives vision precedence for neckline, so
  // vision seeing "collared" on the canary target overwrote the name-derived
  // "turtleneck" — and turtleneck is what carries "high collar" through the
  // synonym map. The canary lost its match and corpus recall@120 fell from 0.957
  // to 0.904.
  //
  // The two sources are stored separately on purpose. Resolution decides what
  // goes into the search field and what the API returns; it must not destroy
  // either input, or the conflict log records a disagreement whose evidence has
  // already been overwritten.
  await db
    .updateTable('products')
    .set({
      attribute_conflicts: JSON.stringify(resolved.conflicts),
      ...search,
    })
    .where('id', '=', id)
    .execute()
}

async function runTextPass(args: Args): Promise<{ usage: Usage; done: number; dropped: number }> {
  let q = db
    .selectFrom('products')
    .select([
      'id', 'brand', 'name', 'description_clean', 'material_clean',
      'category', 'subcategory', 'silhouette', 'neckline', 'sleeve_length',
      'length', 'rise', 'fit', 'pattern', 'details', 'occasion', 'season', 'colors',
    ])
    .where('is_active', '=', true)

  if (!args.reextract) {
    // Only products the rules left incomplete, and only those not already done at
    // the current version. Rihoas is excluded implicitly: its KV block fills the
    // facets, so it has nothing null to fill.
    q = q
      .where((eb) =>
        eb.or([
          eb('category', 'is', null),
          eb('silhouette', 'is', null),
          eb('neckline', 'is', null),
          sql<boolean>`cardinality(details) = 0`,
          sql<boolean>`cardinality(occasion) = 0`,
        ]),
      )
      .where('attributes_version', '<', EXTRACTION_VERSION + 1000)
      .where((eb) =>
        eb.or([eb('attributes_source', '<>', 'llm'), eb('attributes_source', 'is', null)]),
      )
  }
  if (args.limit) q = q.limit(args.limit)

  const rows = await q.execute()
  console.log(`  text: ${rows.length} products need attributes`)
  if (args.dryRun || rows.length === 0) {
    return { usage: emptyUsage(), done: rows.length, dropped: 0 }
  }

  let usage = emptyUsage()
  let dropped = 0
  let done = 0
  const model = modelForStage('extract')

  for (let i = 0; i < rows.length; i += TEXT_BATCH) {
    const slice = rows.slice(i, i + TEXT_BATCH)
    const inputs: ExtractionInput[] = slice.map((r, j) => ({
      index: j,
      brand: r.brand,
      name: r.name,
      description: r.description_clean,
      materialClean: r.material_clean,
      known: {
        category: r.category, subcategory: r.subcategory, silhouette: r.silhouette,
        neckline: r.neckline, sleeve_length: r.sleeve_length, length: r.length,
        rise: r.rise, fit: r.fit, pattern: r.pattern,
      },
    }))

    try {
      const res = await extractBatch(inputs)
      usage = addUsage(usage, res.usage)
      dropped += res.dropped

      for (const item of res.items) {
        const row = slice[item.index]
        if (!row) continue

        // Never overwrite a value the deterministic rules produced: the rules read
        // explicit statements ("Mini Dress", "High Rise") and are more reliable
        // than inference from prose.
        await db
          .updateTable('products')
          .set({
            category: row.category ?? item.category,
            subcategory: row.subcategory ?? item.subcategory,
            silhouette: row.silhouette ?? item.silhouette,
            neckline: row.neckline ?? item.neckline,
            sleeve_length: row.sleeve_length ?? item.sleeve_length,
            length: row.length ?? item.length,
            rise: row.rise ?? item.rise,
            fit: row.fit ?? item.fit,
            pattern: row.pattern ?? item.pattern,
            details: [...new Set([...row.details, ...item.details])],
            occasion: [...new Set([...row.occasion, ...item.occasion])],
            season: [...new Set([...row.season, ...item.season])],
            colors: [...new Set([...row.colors, ...item.colors])],
            attributes_source: 'llm',
            attributes_model: model,
            attributes_at: new Date(),
          })
          .where('id', '=', row.id)
          .execute()

        await rewriteSearchFields(row.id)
        done++
      }
      process.stdout.write(`\r  text: ${done}/${rows.length}`)
    } catch (err) {
      // A failed batch is skipped, not fatal: the predicate will pick these rows
      // up again on the next run.
      console.warn(`\n  text batch at ${i} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  process.stdout.write('\n')

  return { usage, done, dropped }
}

async function runVisionPass(args: Args): Promise<{ usage: Usage; done: number; skipped: number; dropped: number }> {
  let q = db
    .selectFrom('products')
    .select(['id', 'brand', 'name', 'material_clean', 'image_hashes', 'image_set_hash', 'vision_image_set_hash'])
    .where('is_active', '=', true)
    .where(sql<boolean>`cardinality(image_hashes) > 0`)

  if (!args.reextract) {
    // The cache: re-extract only when the image set changed or the prompt version
    // moved. This is what turns a daily vision pass from ~668k calls a year into a
    // one-time backfill plus new arrivals.
    // Also re-extract anything produced by a different model. vision_version
    // tracks the prompt; without this a model switch silently leaves old,
    // lower-quality rows in place because the cache sees them as current.
    const current = modelForStage('vision')
    q = q.where((eb) =>
      eb.or([
        eb('vision_version', '<', VISION_VERSION),
        eb('vision_at', 'is', null),
        eb('vision_model', 'is', null),
        eb('vision_model', '<>', current),
        // The images changed since the last extraction.
        sql<boolean>`vision_image_set_hash IS DISTINCT FROM image_set_hash`,
      ]),
    )
  }
  if (args.limit) q = q.limit(args.limit)

  const rows = await q.execute()
  console.log(`  vision: ${rows.length} products need extraction (1 call each, all images attached)`)
  if (args.dryRun || rows.length === 0) {
    return { usage: emptyUsage(), done: rows.length, skipped: 0, dropped: 0 }
  }

  let usage = emptyUsage()
  let done = 0
  let skipped = 0
  let dropped = 0
  const model = modelForStage('vision')

  for (let i = 0; i < rows.length; i += VISION_CONCURRENCY) {
    const slice = rows.slice(i, i + VISION_CONCURRENCY)
    await awaitBudget(EST_TOKENS_PER_CALL * slice.length)
    await Promise.all(
      slice.map(async (r) => {
        try {
          const res = await extractVision({
            name: r.name,
            brand: r.brand,
            materialClean: r.material_clean,
            imageHashes: r.image_hashes,
          })
          if (!res) {
            skipped++
            return
          }
          usage = addUsage(usage, res.usage)
          // Charge the real cost against the window, not the estimate.
          recordSpend(res.usage.inputTokens + res.usage.outputTokens)
          dropped += res.dropped

          await db
            .updateTable('products')
            .set({
              ...res.result,
              vision_version: VISION_VERSION,
              vision_model: model,
              // Record what this extraction actually saw, so a later image
              // change is detectable.
              vision_image_set_hash: r.image_set_hash,
              vision_at: new Date(),
            })
            .where('id', '=', r.id)
            .execute()

          await rewriteSearchFields(r.id)
          done++
        } catch (err) {
          console.warn(`\n  vision failed for ${r.name}: ${err instanceof Error ? err.message : err}`)
        }
      }),
    )
    const used = spend.reduce((n, x) => n + x.tokens, 0)
    process.stdout.write(
      `\r  vision: ${done}/${rows.length}  (${Math.round(used / 1000)}k tok in the last minute)   `,
    )
  }
  process.stdout.write('\n')

  return { usage, done, skipped, dropped }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!llmAvailable() && !args.dryRun) {
    console.error(
      `${missingKeyHint()}.\n` +
        'Search works without it — the catalog is already searchable from deterministic\n' +
        'extraction, and the LLM stages degrade rather than fail. Set the key to enrich,\n' +
        'or point INK_MODEL at a provider you do have a key for.',
    )
    process.exitCode = 1
    return
  }

  const perStage: Record<string, Usage> = { extract: emptyUsage(), vision: emptyUsage() }
  console.log(`enrich${args.dryRun ? ' [dry run — nothing will be spent]' : ''}`)
  console.log(`  ${describeLlm()}`)
  let usage = emptyUsage()

  if (args.text) {
    const r = await runTextPass(args)
    perStage.extract = r.usage
    usage = addUsage(usage, r.usage)
    if (r.dropped > 0) console.log(`  text: dropped ${r.dropped} out-of-vocabulary values`)
  }
  if (args.vision) {
    const r = await runVisionPass(args)
    perStage.vision = r.usage
    usage = addUsage(usage, r.usage)
    if (r.skipped > 0) console.log(`  vision: skipped ${r.skipped} products with no readable image`)
    if (r.dropped > 0) console.log(`  vision: dropped ${r.dropped} out-of-vocabulary values`)
  }

  const conflicts = await db
    .selectFrom('products')
    .select(({ fn }) => fn.countAll<number>().as('n'))
    .where(sql<boolean>`jsonb_array_length(attribute_conflicts) > 0`)
    .executeTakeFirst()

  // Priced per stage: vision and text can run different models, and charging
  // mini-priced calls at nano rates understated an earlier run by ~5x.
  let total = 0
  for (const [stage, u] of Object.entries(perStage)) {
    if (u.calls === 0) continue
    const m = modelForStage(stage as 'extract' | 'vision')
    const c = costUsd(u, m)
    total += c
    console.log(
      `\n  ${stage.padEnd(7)} ${m.padEnd(12)} ${u.calls} calls · ` +
        `${u.inputTokens} in / ${u.outputTokens} out · $${c.toFixed(4)}`,
    )
  }
  console.log(`  ${'total'.padEnd(20)} $${total.toFixed(4)}`)
  // A conflict rate that jumps day over day is the cheapest available signal that
  // an extractor regressed.
  console.log(`${Number(conflicts?.n ?? 0)} products have text/vision attribute conflicts`)
}

try {
  await main()
} finally {
  await db.destroy()
}
