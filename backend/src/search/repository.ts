/**
 * The only place in the codebase that writes pg_search SQL.
 *
 * Kysely cannot express the `@@@` operator or the paradedb query-builder
 * functions, so these are raw `sql` templates. They are confined to this file so
 * the unsafe surface is one reviewable module, and every user-supplied value goes
 * through a bound parameter — `sql.lit` is used only for numeric boosts that
 * originate in config.ts and are validated below.
 *
 * Verified against pg_search 0.23.1:
 *   paradedb.boolean(must => ARRAY[...], should => ARRAY[...], must_not => ARRAY[...])
 *   paradedb.match(field, text)      tokenised, multi-term OR
 *   paradedb.boost(factor, query)
 *   paradedb.term(field, value)      exact, for raw-tokenised fields
 *   paradedb.range(field, range)
 *   pdb.score(id)
 */
import { sql, type RawBuilder } from 'kysely'
import { db } from '../db/index.js'
import { CANDIDATE_LIMIT, EXPANSION_BOOST, FIELD_BOOSTS, MIN_SCORE } from './config.js'

export interface Candidate {
  id: number
  brand: string
  name: string
  name_variant: string | null
  price_cents: number | null
  material_clean: string | null
  primary_fiber: string | null
  natural_ratio: number | null
  category: string | null
  subcategory: string | null
  silhouette: string | null
  neckline: string | null
  sleeve_length: string | null
  length: string | null
  rise: string | null
  fit: string | null
  pattern: string | null
  colors: string[]
  details: string[]
  occasion: string[]
  v_rise: string | null
  v_waist_position: string | null
  v_hem_break: string | null
  v_shoulder_treatment: string | null
  v_neckline_width: string | null
  v_volume: string | null
  v_vertical_line: string | null
  v_waist_definition: string | null
  v_drape: string | null
  v_structure: string | null
  product_url: string
  image_hashes: string[]
  description_clean: string | null
  size_range: string[]
  bm25_score: number
}

export interface Bm25Params {
  /** The user's words, verbatim. Always weighted above expansion. */
  query: string
  /** Synonyms from the expander, searched as a discounted second clause group. */
  expanded?: string | null
  /** Include only these brands. Empty or undefined means all. */
  brands?: string[]
  /** Hard exclusions from user settings. The one hard preference filter. */
  excludeBrands?: string[]
  priceMinCents?: number | null
  priceMaxCents?: number | null
  limit?: number
}

/** Guard against a boost from a bad config edit reaching sql.lit. */
function boost(n: number): number {
  if (!Number.isFinite(n) || n <= 0 || n > 100) {
    throw new Error(`Invalid boost factor: ${n}`)
  }
  return Math.round(n * 1000) / 1000
}

/** One boosted per-field match clause. */
function fieldClause(field: string, text: string, factor: number): RawBuilder<unknown> {
  return sql`paradedb.boost(${sql.lit(boost(factor))}, paradedb.match(${sql.lit(field)}, ${text}))`
}

function clauseGroup(text: string, scale: number): RawBuilder<unknown>[] {
  return [
    fieldClause('search_title', text, FIELD_BOOSTS.title * scale),
    fieldClause('search_attrs', text, FIELD_BOOSTS.attrs * scale),
    fieldClause('search_material', text, FIELD_BOOSTS.material * scale),
    fieldClause('search_body', text, FIELD_BOOSTS.body * scale),
  ]
}

const SELECTED_COLUMNS = sql`
  id, brand, name, name_variant, price_cents, material_clean, primary_fiber,
  natural_ratio, category, subcategory, silhouette, neckline, sleeve_length,
  length, rise, fit, pattern, colors, details, occasion,
  v_rise, v_waist_position, v_hem_break, v_shoulder_treatment, v_neckline_width,
  v_volume, v_vertical_line, v_waist_definition, v_drape, v_structure,
  product_url, image_hashes, description_clean, size_range
`

/**
 * Retrieve BM25 candidates.
 *
 * All filters live *inside* the `@@@` expression rather than in a SQL `WHERE`.
 * That is deliberate: a `WHERE brand = ANY($1)` sitting beside
 * `ORDER BY score LIMIT 120` lets the planner choose to take the top 120 by score
 * and only then filter, which silently returns fewer than 120 candidates and
 * quietly caps recall. Expressing the filter as a `must` clause makes the index
 * itself responsible, so the limit applies to already-filtered rows.
 *
 * Expansion terms are `should` clauses only, never `must`. Recall is this stage's
 * job and precision is the reranker's; promoting a generated synonym to a
 * requirement is how a good query returns zero results.
 */
export async function bm25Search(params: Bm25Params): Promise<Candidate[]> {
  const q = params.query.trim()
  if (!q) return []

  const must: RawBuilder<unknown>[] = [sql`paradedb.term('is_active', true)`]
  const mustNot: RawBuilder<unknown>[] = []

  const brands = (params.brands ?? []).filter(Boolean)
  if (brands.length > 0) {
    const terms = brands.map((b) => sql`paradedb.term('brand', ${b.toLowerCase()})`)
    // A nested boolean with only `should` clauses means "at least one of these",
    // which is the ANY(...) semantics we want, expressed inside the index.
    must.push(sql`paradedb.boolean(should => ARRAY[${sql.join(terms, sql`, `)}])`)
  }

  for (const b of params.excludeBrands ?? []) {
    if (b) mustNot.push(sql`paradedb.term('brand', ${b.toLowerCase()})`)
  }

  const lo = params.priceMinCents
  const hi = params.priceMaxCents
  if (typeof lo === 'number' || typeof hi === 'number') {
    must.push(
      sql`paradedb.range('price_cents', int4range(${lo ?? null}, ${hi ?? null}, '[]'))`,
    )
  }

  const should = [...clauseGroup(q, 1)]
  const expanded = params.expanded?.trim()
  // Only add the discounted group when expansion actually contributed new words.
  if (expanded && expanded.toLowerCase() !== q.toLowerCase()) {
    should.push(...clauseGroup(expanded, EXPANSION_BOOST))
  }

  const parts: RawBuilder<unknown>[] = [
    sql`must => ARRAY[${sql.join(must, sql`, `)}]`,
    sql`should => ARRAY[${sql.join(should, sql`, `)}]`,
  ]
  if (mustNot.length > 0) {
    parts.push(sql`must_not => ARRAY[${sql.join(mustNot, sql`, `)}]`)
  }

  const limit = Math.max(1, Math.min(params.limit ?? CANDIDATE_LIMIT, 500))

  const result = await sql<Candidate>`
    SELECT * FROM (
      SELECT ${SELECTED_COLUMNS}, pdb.score(id)::float8 AS bm25_score
      FROM products
      WHERE id @@@ paradedb.boolean(${sql.join(parts, sql`, `)})
      ORDER BY pdb.score(id) DESC, id ASC
      LIMIT ${sql.lit(limit)}
    ) ranked
    -- Applied after ranking rather than as another @@@ clause: pdb.score() is
    -- only available where a paradedb operator is present, so it cannot be
    -- referenced in the same query's WHERE.
    WHERE bm25_score >= ${sql.lit(MIN_SCORE)}
  `.execute(db)

  return result.rows
}

/** Count active products matching only the filters, ignoring the query text. */
export async function countMatchingFilters(brands: string[]): Promise<number> {
  const q = db.selectFrom('products').select(({ fn }) => fn.countAll<number>().as('n')).where('is_active', '=', true)
  const withBrands = brands.length > 0 ? q.where('brand', 'in', brands.map((b) => b.toLowerCase())) : q
  const row = await withBrands.executeTakeFirst()
  return Number(row?.n ?? 0)
}
