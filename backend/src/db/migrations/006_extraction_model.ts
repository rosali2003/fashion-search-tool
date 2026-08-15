import { sql, type Kysely } from 'kysely'

/**
 * Record which model produced each extraction.
 *
 * Without this, mixed-model data is undetectable. It happened: a vision backfill
 * spanning a change to per-stage model routing left 299 rows where some came from
 * gpt-5-nano and some from gpt-5-mini, and the only way to tell them apart was to
 * infer it from the output — nano emits 13-29 "details" per garment at confidence
 * ~0.2, mini emits ~3 at ~0.75. Guessing the provenance of your own data from its
 * quality signature is not a position to be in.
 *
 * `vision_version` alone cannot express this: it tracks the prompt, not the model,
 * so switching models leaves it unchanged and the cache declines to re-extract.
 * With the model recorded, the re-extraction predicate becomes exact —
 * `vision_model IS DISTINCT FROM <current>` — instead of all-or-nothing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('products').addColumn('vision_model', 'text').execute()
  // attributes_model was declared in the plan but never added to 002.
  await sql`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS attributes_model text
  `.execute(db)

  await db.schema
    .createIndex('products_vision_model_idx')
    .on('products')
    .column('vision_model')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('products_vision_model_idx').ifExists().execute()
  await db.schema.alterTable('products').dropColumn('attributes_model').execute()
  await db.schema.alterTable('products').dropColumn('vision_model').execute()
}
