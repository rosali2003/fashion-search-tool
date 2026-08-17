/**
 * Garment-type gate.
 *
 * BM25 here is disjunctive by construction — every field clause is a `should`,
 * because promoting any one of them to a `must` is how a good query returns
 * nothing (see repository.ts). The cost of that choice is that a query's *type*
 * word carries no more authority than its adjectives. "high rise wide leg jeans"
 * matches a high-rise bikini bottom on two of four terms, in the title field, at
 * boost 4.0 — measured score 46.4 against a 2.0 floor.
 *
 * Nothing downstream corrected for it. The reranker curates roughly the first
 * ten results and the remainder ships in raw BM25 order, and because
 * RESULT_LIMIT equals CANDIDATE_LIMIT the response is always padded out to 120
 * rows whether or not 120 relevant garments exist. Measured on this corpus for
 * "high rise wide leg jeans": 22 jeans in the catalog, 120 rows returned, 47 of
 * them from a different category entirely — bikini bottoms, t-shirts, bra tops,
 * sweaters.
 *
 * So the gate is a filter, not a reordering. Demoting an off-category product to
 * rank 60 still puts a bikini bottom on the shopper's second page.
 *
 * Two constraints were learned by measuring against the golden set, and both are
 * load-bearing. Removing either one regressed nDCG@10 from 0.593 to 0.523:
 *
 *   1. It filters and never reorders. An earlier version promoted exact
 *      subcategory matches above the rest, which let a *guessed* subcategory
 *      rewrite the top ten: "beach vacation dress" expands to `maxi-dress`, and
 *      hoisting every maxi above the judged-relevant midis took that case from
 *      nDCG 0.82 to 0.04. Ranking is BM25's job and the reranker's. This module
 *      only decides who is eligible.
 *
 *   2. It fires only on a type the shopper actually typed. "something cozy for
 *      the weekend" expands to `top`/`hoodie`, which is a reasonable guess and a
 *      terrible filter — it dropped three judged-relevant products, because
 *      "cozy" legitimately includes joggers. A type the model inferred is a
 *      ranking hint; only a type the shopper wrote down is a constraint.
 */
import type { Candidate } from './repository.js'
import { OFF_TYPE_FLOOR } from './config.js'

/** The type facets from the expansion. Both optional; both may be absent. */
export interface TypeIntent {
  category?: string | null
  subcategory?: string | null
}

export interface TypeGateResult {
  kept: Candidate[]
  /** Off-type candidates removed. Zero when the gate declined to fire. */
  dropped: number
  /** True only when the gate actually filtered. */
  applied: boolean
}

/**
 * Surface forms for garment types, used *only* to decide whether the shopper
 * named the type themselves.
 *
 * Deliberately separate from normalize/synonyms.ts, which has no subcategory
 * entries and must not grow them: that map is emitted into `search_attrs` at
 * ingest, so adding "jean -> jeans" there would change every document in the
 * index. This map is read-only query-side grounding and changes nothing about
 * what is stored.
 *
 * Singulars matter more than they look. Brands name garments in the singular
 * ("The Ultimate Wide-Leg Jean") and shoppers type the plural.
 */
const TYPE_FORMS: Record<string, readonly string[]> = {
  // Categories
  top: ['top', 'tops'],
  bottom: ['bottom', 'bottoms'],
  dress: ['dress', 'dresses'],
  outerwear: ['outerwear', 'coat', 'jacket'],
  // Not 'knit': "cotton knit top" is a fabric, not a request for knitwear.
  knitwear: ['knitwear'],
  swimwear: ['swimwear', 'swim', 'swimsuit', 'bathing suit'],
  intimates: ['intimates', 'lingerie', 'underwear'],
  jumpsuit: ['jumpsuit', 'jumpsuits', 'boilersuit'],
  accessory: ['accessory', 'accessories'],
  // Subcategories
  't-shirt': ['t-shirt', 't shirt', 'tshirt', 'tee', 'tees', 't-shirts'],
  tank: ['tank', 'tanks', 'tank top', 'vest top'],
  camisole: ['camisole', 'cami', 'camis'],
  blouse: ['blouse', 'blouses'],
  shirt: ['shirt', 'shirts'],
  polo: ['polo', 'polos'],
  bodysuit: ['bodysuit', 'bodysuits'],
  sweater: ['sweater', 'sweaters', 'jumper', 'jumpers', 'pullover'],
  cardigan: ['cardigan', 'cardigans', 'cardi'],
  hoodie: ['hoodie', 'hoodies', 'hooded'],
  sweatshirt: ['sweatshirt', 'sweatshirts', 'crewneck sweat'],
  vest: ['vest', 'vests', 'gilet'],
  jacket: ['jacket', 'jackets'],
  coat: ['coat', 'coats', 'overcoat', 'parka', 'trench'],
  blazer: ['blazer', 'blazers'],
  jeans: ['jeans', 'jean', 'denim'],
  trousers: ['trousers', 'trouser', 'pants', 'pant', 'slacks', 'chinos'],
  // Not 'short': it is an adjective ("short sleeve") far more often than a
  // garment, and grounding on it would gate a blouse query down to bottoms.
  shorts: ['shorts'],
  skirt: ['skirt', 'skirts'],
  leggings: ['leggings', 'legging'],
  joggers: ['joggers', 'jogger', 'sweatpants', 'sweatpant', 'track pants'],
  'mini-dress': ['mini dress', 'mini-dress'],
  'midi-dress': ['midi dress', 'midi-dress'],
  'maxi-dress': ['maxi dress', 'maxi-dress'],
  romper: ['romper', 'rompers', 'playsuit'],
  'bikini-top': ['bikini top', 'bikini'],
  'bikini-bottom': ['bikini bottom', 'bikini'],
  swimsuit: ['swimsuit', 'one piece', 'one-piece'],
  'bra-top': ['bra top', 'bralette', 'bra'],
}

/** Whole-word test, so "short" does not match inside "shorts" or "shortlist". */
function mentions(query: string, term: string): boolean {
  const forms = TYPE_FORMS[term] ?? [term.replace(/-/g, ' ')]
  return forms.some((f) => {
    const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i').test(query)
  })
}

/**
 * Is this type something the shopper wrote, or something the model inferred?
 *
 * Only a written type is treated as a constraint. See note 2 in the module
 * header for the case that forced this.
 */
function isGrounded(query: string, intent: TypeIntent): boolean {
  return Boolean(
    (intent.subcategory && mentions(query, intent.subcategory)) ||
      (intent.category && mentions(query, intent.category)),
  )
}

/**
 * Eligible means: the right category, or the exact subcategory regardless of
 * category, or not enriched enough to tell.
 *
 * The subcategory rescue exists because the expander and the corpus do not
 * always agree on where a garment sits — a sweater is `knitwear` to one and
 * `top` to the other — and an exact subcategory hit is the stronger signal of
 * the two. A candidate with no category and no subcategory is eligible too:
 * missing extraction is not evidence of a wrong garment, and punishing it would
 * let a gap in enrichment read as irrelevance.
 */
function isEligible(c: Candidate, intent: TypeIntent): boolean {
  if (intent.subcategory && c.subcategory === intent.subcategory) return true
  if (c.category === null && c.subcategory === null) return true
  if (intent.category) return c.category === intent.category
  return true
}

/**
 * Drop candidates whose garment type the shopper did not ask for.
 *
 * Fails open in three places, which is what makes it safe to apply to a facet a
 * language model produced: no type intent, a type the shopper never typed, or
 * too few eligible candidates left all return the input untouched. A wrong
 * expansion therefore costs nothing at all — not results, and not ordering.
 */
export function applyTypeGate(
  candidates: Candidate[],
  intent: TypeIntent,
  query: string,
  /** Overridable so the eval harness can sweep it. Production uses the config. */
  floor: number = OFF_TYPE_FLOOR,
): TypeGateResult {
  const unchanged = { kept: candidates, dropped: 0, applied: false }

  if (!intent.category && !intent.subcategory) return unchanged
  if (!isGrounded(query, intent)) return unchanged

  const kept = candidates.filter((c) => isEligible(c, intent))
  if (kept.length < floor) return unchanged

  return { kept, dropped: candidates.length - kept.length, applied: true }
}
