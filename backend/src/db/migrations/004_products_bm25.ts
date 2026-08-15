import { sql, type Kysely } from 'kysely'

/**
 * The BM25 index.
 *
 * Kept in its own migration so that changing the field configuration is a
 * drop-and-recreate that never touches data — instant at this catalog size.
 *
 * SYNTAX IS VERSION-SPECIFIC. Everything below was probed directly against the
 * pinned image paradedb/paradedb:0.23.1-pg17 (pg_search 0.23.1, Postgres 17.9):
 *
 *   - `USING bm25` is correct here. `USING paradedb`, which newer docs show,
 *     does not exist in 0.23.1 — it errors with "access method does not exist".
 *   - Field config goes in `WITH (text_fields=..., numeric_fields=...)` as JSON.
 *     The `::pdb.simple('stemmer=english')` cast form is a later-release API.
 *   - `pdb.score(id)` and `paradedb.score(id)` both work.
 *   - Operators: `|||` (disjunction), `&&&` (conjunction), `###` (phrase),
 *     `===` (exact term), `@@@` (query objects).
 *   - Query-time field boosting: `'term'::pdb.boost(3.0)`.
 *
 * THE STEMMER IS NOT OPTIONAL. The default tokenizer does no stemming: probed
 * against a row titled "Turtle Tie Shirt", a search for 'shirts' returned
 * nothing until an English stemmer was configured explicitly. Without this,
 * every plural/singular mismatch silently costs recall — "dresses" would not
 * match "dress" across a catalog where most queries are typed in plural.
 *
 * `record: 'position'` is required on the text fields so phrase queries (`###`)
 * work; position data is what lets "turtle neck" match as a phrase rather than
 * as two independent terms.
 *
 * Field weights are deliberately NOT baked in here. They are applied per query
 * via pdb.boost(), because the eval sweep tries ~160 boost combinations and
 * index-time weights would mean 160 index rebuilds instead of 160 queries.
 */

const TEXT_FIELD_CONFIG = {
  // The four search-tier fields. All stemmed, all position-indexed.
  search_title: { tokenizer: { type: 'default', stemmer: 'English' }, record: 'position' },
  search_attrs: { tokenizer: { type: 'default', stemmer: 'English' }, record: 'position' },
  search_material: { tokenizer: { type: 'default', stemmer: 'English' }, record: 'position' },
  search_body: { tokenizer: { type: 'default', stemmer: 'English' }, record: 'position' },
  // Filter fields use the raw tokenizer so `brand === 'gap'` is an exact term
  // match rather than a stemmed one, and `fast` so filtering doesn't need to
  // fetch the heap. These live inside the index specifically so brand and
  // category filters can be expressed within the @@@ expression — a SQL
  // `WHERE brand = ANY(...)` next to `ORDER BY score LIMIT n` risks the planner
  // truncating to n before filtering, silently shrinking the candidate window.
  brand: { tokenizer: { type: 'raw' }, fast: true },
  category: { tokenizer: { type: 'raw' }, fast: true },
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX products_bm25 ON products
    USING bm25 (
      id,
      search_title,
      search_attrs,
      search_material,
      search_body,
      brand,
      category,
      price_cents,
      is_active
    )
    WITH (
      key_field = 'id',
      text_fields = ${sql.lit(JSON.stringify(TEXT_FIELD_CONFIG))},
      numeric_fields = ${sql.lit(JSON.stringify({ price_cents: { fast: true } }))},
      boolean_fields = ${sql.lit(JSON.stringify({ is_active: { fast: true } }))}
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS products_bm25`.execute(db)
}
