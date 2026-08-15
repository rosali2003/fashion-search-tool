import { sql, type Kysely } from 'kysely'

/**
 * Separate "what the images are now" from "what vision last looked at".
 *
 * Fixes a severe caching bug. `normalizeProduct` wrote `vision_version: 0` on
 * every upsert, and the daily refresh upserts every product — so the cron would
 * have re-extracted all 299 products every single day, at full cost, forever.
 * The caching that the entire cost model rests on was being reset by the step
 * immediately before it.
 *
 * One hash cannot serve both roles. With a single `vision_image_set_hash`,
 * ingest must either overwrite it (losing the record of what was actually
 * extracted) or preserve it (never noticing that the images changed). So:
 *
 *   image_set_hash         maintained by ingest. What the gallery is now.
 *   vision_image_set_hash  written by the vision pass. What it extracted from.
 *
 * Re-extract exactly when they disagree. Ingest no longer touches any
 * enrichment column, so re-running it is free.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('products').addColumn('image_set_hash', 'text').execute()

  // Backfill: existing rows were extracted from their current images, so seed
  // the two hashes equal rather than forcing a needless re-extraction of work
  // that has already been paid for.
  await sql`UPDATE products SET image_set_hash = vision_image_set_hash`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('products').dropColumn('image_set_hash').execute()
}
