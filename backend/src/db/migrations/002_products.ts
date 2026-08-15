import { sql, type Kysely } from 'kysely'

/**
 * The catalog table.
 *
 * Columns fall into three tiers with different lifecycles:
 *
 *   raw_*        verbatim scraper output. Never edited. The audit trail for when
 *                a normalisation rule misfires — without it you cannot re-derive.
 *   (clean)      deterministic derivation: name, description_clean, fibers, etc.
 *                Rewritten wholesale whenever NORMALIZER_VERSION bumps.
 *   search_*     denormalised, synonym-expanded text that exists only to be
 *                BM25-indexed and is never displayed.
 *
 * The search tier is not redundant. Tantivy hardcodes BM25's b (length
 * normalisation) at 0.75 with no override, so the only way to stop one brand's
 * verbose copy from being penalised is to put the signal in short, length-uniform
 * fields. search_attrs is rendered from a controlled vocabulary and is therefore
 * near-identical in length across brands, whether the source description was 308
 * characters (Aritzia mean) or 1,956 (Uniqlo max).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('products')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())

    // --- identity and provenance -------------------------------------------
    // product_url is the only stable natural key the scrapers emit: there is no
    // id or SKU field, and 13 (brand, name) pairs collide in the current corpus
    // (Uniqlo colourways, Gap re-listings), so name must never be a key.
    .addColumn('product_url', 'text', (c) => c.notNull().unique())
    .addColumn('brand', 'text', (c) => c.notNull())
    .addColumn('vendor_sku', 'text')
    .addColumn('content_hash', 'text', (c) => c.notNull())
    .addColumn('source_run', 'text', (c) => c.notNull())
    .addColumn('scraped_at', 'timestamptz')
    .addColumn('first_seen_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    // Soft delete. Products absent from a new crawl are deactivated, never
    // deleted, because the eval golden set references product_url and must stay
    // resolvable for metrics to remain comparable across runs.
    .addColumn('is_active', 'boolean', (c) => c.notNull().defaultTo(true))

    // --- tier 1: raw --------------------------------------------------------
    .addColumn('raw_name', 'text', (c) => c.notNull())
    .addColumn('raw_description', 'text')
    .addColumn('raw_material', 'text')
    .addColumn('price_cents', 'integer')
    .addColumn('image_urls', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    // Content-addressed: the scrapers hash image bytes so a daily re-crawl does
    // not re-download or re-store 348 MB. Absolute paths are never persisted —
    // the ones baked into the scraped JSON break the moment the repo moves.
    .addColumn('image_hashes', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))

    // --- tier 2: clean ------------------------------------------------------
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('name_variant', 'text')
    .addColumn('description_clean', 'text')
    .addColumn('material_clean', 'text')
    .addColumn('fibers', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('fiber_names', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    // Natural share of the main component, 0..1. The column the fibre
    // preference ranks on. Null when unknowable rather than defaulted to 0 —
    // "no data" and "fully synthetic" must not collapse into the same value.
    .addColumn('natural_ratio', 'numeric')
    .addColumn('primary_fiber', 'text')
    .addColumn('fibers_incomplete', 'boolean', (c) => c.notNull().defaultTo(false))
    // Construction (chiffon, jersey), kept strictly apart from fibre content.
    .addColumn('fabric', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))

    // --- facets -------------------------------------------------------------
    .addColumn('category', 'text')
    .addColumn('subcategory', 'text')
    .addColumn('silhouette', 'text')
    .addColumn('neckline', 'text')
    .addColumn('sleeve_length', 'text')
    .addColumn('length', 'text')
    .addColumn('rise', 'text')
    .addColumn('fit', 'text')
    .addColumn('pattern', 'text')
    .addColumn('colors', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('details', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('occasion', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('season', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))

    // --- fit data (scraper extension) --------------------------------------
    .addColumn('size_range', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('model_height_cm', 'integer')
    .addColumn('model_size', 'text')
    .addColumn('fit_notes', 'text')

    .addColumn('attributes_source', 'text')
    .addColumn('attributes_version', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('attributes_at', 'timestamptz')

    // --- vision-derived garment geometry -----------------------------------
    // Separate v_* columns rather than overwriting the text-derived facets, so
    // either extractor can be re-run independently and disagreements stay
    // visible. Precedence is applied at render time, not at write time.
    .addColumn('v_category', 'text')
    .addColumn('v_silhouette', 'text')
    .addColumn('v_neckline', 'text')
    .addColumn('v_sleeve_length', 'text')
    .addColumn('v_length', 'text')
    .addColumn('v_pattern', 'text')
    .addColumn('v_colors', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('v_details', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    // These have no text equivalent anywhere in the corpus. They exist so the
    // styling rules have something objective to key on.
    .addColumn('v_rise', 'text')
    .addColumn('v_waist_position', 'text')
    .addColumn('v_hem_break', 'text')
    .addColumn('v_shoulder_treatment', 'text')
    .addColumn('v_neckline_width', 'text')
    .addColumn('v_volume', 'text')
    .addColumn('v_vertical_line', 'text')
    .addColumn('v_waist_definition', 'text')
    .addColumn('v_drape', 'text')
    .addColumn('v_structure', 'text')
    .addColumn('v_finish_cues', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('v_confidence', 'numeric')
    // Cache key: sha256 of the sorted image hashes. A daily crawl re-extracts
    // only products whose image set actually changed. Without this, daily vision
    // would be ~668k calls/year instead of a one-time backfill.
    .addColumn('vision_image_set_hash', 'text')
    .addColumn('vision_version', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('vision_at', 'timestamptz')
    // Logged, never silently resolved: a conflict rate that jumps day over day
    // is the cheapest signal that an extractor regressed.
    .addColumn('attribute_conflicts', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))

    // --- tier 3: search payload --------------------------------------------
    .addColumn('search_title', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('search_attrs', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('search_material', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('search_body', 'text', (c) => c.notNull().defaultTo(''))
    .execute()

  await db.schema.createIndex('products_brand_idx').on('products').column('brand').execute()
  await db.schema.createIndex('products_active_idx').on('products').column('is_active').execute()
  // Second net against Gap's fragile ?pid= URLs: tracking-param drift would
  // otherwise create duplicate rows for one product.
  await sql`
    CREATE UNIQUE INDEX products_brand_sku_idx ON products (brand, vendor_sku)
    WHERE vendor_sku IS NOT NULL
  `.execute(db)

  // Query expansion is the same for every user, so it is cached globally rather
  // than recomputed per request.
  await db.schema
    .createTable('expansion_cache')
    .addColumn('query_hash', 'text', (c) => c.primaryKey())
    .addColumn('query_text', 'text', (c) => c.notNull())
    .addColumn('expansion', 'jsonb', (c) => c.notNull())
    .addColumn('model', 'text', (c) => c.notNull())
    .addColumn('hits', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()

  // One row per brand per refresh. This is the daily cron's observability: a
  // cost_usd or vision_calls jump means the cache stopped working.
  await db.schema
    .createTable('ingest_runs')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('run_dir', 'text', (c) => c.notNull())
    .addColumn('brand', 'text', (c) => c.notNull())
    .addColumn('seen', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('inserted', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('updated', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('deactivated', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('skipped_unchanged', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('llm_calls', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('vision_calls', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('cost_usd', 'numeric', (c) => c.notNull().defaultTo(0))
    .addColumn('duration_ms', 'integer')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('ingest_runs').ifExists().execute()
  await db.schema.dropTable('expansion_cache').ifExists().execute()
  await db.schema.dropTable('products').ifExists().execute()
}
