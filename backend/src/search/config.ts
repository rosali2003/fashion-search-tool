/**
 * Retrieval tuning constants.
 *
 * Everything here is swept by `pnpm --filter backend eval sweep`, which grids the
 * field boosts and re-measures recall@120 and nDCG@10 over the golden set. The
 * numbers below are starting points, not conclusions — replace them with the
 * sweep winner and record the baseline it beat.
 */

/**
 * Per-field weights, applied at *query* time via paradedb.boost().
 *
 * Deliberately not baked into the index: the sweep tries ~160 combinations, and
 * index-time weights would mean 160 index rebuilds instead of 160 queries.
 *
 * The ordering reflects signal density. search_attrs is rendered from a
 * controlled vocabulary plus synonyms, so a hit there is a hit on a real garment
 * attribute; search_body is marketing prose where a hit may be incidental.
 */
/*
 * Values below are the sweep winner (54 configurations, 26 golden cases):
 * recall@120 0.949, nDCG@10 0.733, 13/13 gates. Raising title from 3.0 to 4.0
 * moved recall@120 from 0.906 to 0.949 — the product name is the densest signal
 * in the corpus, because these brands name garments descriptively ("Black Square
 * Neck Sleeveless Button Midi Dress").
 *
 * The nDCG spread across the top dozen configurations was 0.726–0.746, well
 * inside the ±0.074 standard error at n=26, so nDCG did not distinguish them and
 * recall was used to choose. Do not re-tune on nDCG alone at this sample size.
 */
export const FIELD_BOOSTS = {
  title: 4.0,
  attrs: 2.5,
  material: 1.0,
  body: 1.0,
} as const

/**
 * Expanded synonyms are searched as a second clause group at this fraction of
 * the original weight.
 *
 * Without the discount, expansion drowns the literal query: a product matching
 * a generated synonym would outrank one matching the user's actual words. With
 * it, expansion adds recall without overriding intent.
 */
export const EXPANSION_BOOST = 0.6

/**
 * Candidates pulled from BM25 before reranking.
 *
 * Bounded by rerank cost, not by corpus size: 120 compacted candidates is
 * ~11k input tokens for Haiku. This number stays correct as the catalog grows.
 */
export const CANDIDATE_LIMIT = 120

/** Candidates actually sent to the reranker, after the diversity guard. */
export const RERANK_WINDOW = 60

/**
 * Maximum share of the rerank window any single brand may occupy.
 *
 * Measured need: on 7 generic queries Rihoas took 52 of 140 top-20 slots against
 * a 34% corpus share, while Aritzia took 13 against 16%. Sweeping BM25's `b`
 * moved that by only ~5 slots, so brand skew is corrected explicitly here rather
 * than pretending a scoring parameter fixes it.
 */
export const BRAND_CAP_RATIO = 0.4

/**
 * Results returned to the client.
 *
 * This was 10, matching a single screen of cards. It is now the whole ranked set
 * because the frontend pages through results client-side, 50 at a time, and the
 * alternative — a fresh request per page — would re-run the LLM rerank for every
 * page turn. That is the expensive stage (166ms and a paid call on the canary),
 * it is the one stage whose output is not deterministic, and re-running it per
 * page would let a product legitimately appear on both page 1 and page 2.
 *
 * One payload, ranked once, is therefore both cheaper and more correct. The size
 * is bounded by CANDIDATE_LIMIT above, so the response is at most ~120 compact
 * result objects — tens of kilobytes, not megabytes.
 *
 * Raising CANDIDATE_LIMIT is what widens the result set; this constant only caps
 * it. They are separate because the first is bounded by rerank cost and the
 * second by response size, and those two ceilings move for different reasons.
 */
export const RESULT_LIMIT = CANDIDATE_LIMIT

/**
 * Results per page in the UI.
 *
 * Lives here rather than in the frontend so the page size and the candidate
 * ceiling stay visible to each other: at 50 per page and a 120-candidate limit,
 * a query returns at most three pages, and the third is usually short.
 */
export const PAGE_SIZE = 50

/**
 * Minimum BM25 score for a candidate to be returned at all.
 *
 * Because the field clauses are `should` (disjunctive), a query whose terms are
 * entirely absent from the catalog still matches documents on stopword-ish
 * residue and returns a full page of confident-looking nonsense. Measured top
 * scores on this corpus:
 *
 *   "wool overcoat"                          0.15   <- nothing actually matched
 *   "black leather biker jacket"            32.49   <- "black" + "jacket" genuinely match
 *   "100% linen shirt"                      47.90
 *   "black square neck sleeveless midi dress" 70.97
 *
 * A floor of 2.0 sits far above the noise tier and far below any real partial
 * match, so it suppresses the former without touching the latter. It is
 * deliberately not a *relative* floor (e.g. 10% of top score): relative floors
 * collapse to nothing when every result is weak, which is exactly the case this
 * needs to catch.
 */
export const MIN_SCORE = 2.0

/**
 * How many on-type candidates the type gate needs before it gives up and keeps
 * everything. See search/typeGate.ts.
 *
 * Deliberately low, which is not where this started. The floor was originally 20
 * on the assumption that it was protecting recall. Swept over the golden set it
 * turned out to protect nothing: judged-relevant products lost and recall@120
 * are *identical* at every floor from 0 to 30, because the gate's other two
 * safeguards — it only fires on a type the shopper typed, and an exact
 * subcategory match is always eligible — already do that job.
 *
 * What the floor does change is leakage. Measured across 27 golden queries:
 *
 *   floor   fires   nDCG@10   off-type products shipped
 *   gate off   0     0.593      1499
 *   20        19     0.597       675
 *   10        20     0.597       565
 *   5         22     0.590       360
 *   0         23     0.586       312
 *
 * The nDCG column spans 0.011 against a ±0.077 standard error at n=27, so it
 * does not distinguish these and must not be used to choose between them. The
 * leakage column does, and it is the one the user actually sees: nDCG@10 grades
 * the first ten results, while the complaint that prompted this — a bikini
 * bottom under "high rise wide leg jeans" — was about rank 23 of 120. That
 * blind spot is why the defect survived a green eval.
 *
 * So 5, which halves the leakage that 20 allows. It is kept above 0 only to
 * cover a failure the golden set cannot exhibit: if category extraction broke
 * across the corpus, the gate should hand back an unfiltered page rather than a
 * near-empty one. A genuinely small answer is not that failure — when the
 * catalog holds six jackets, six jackets is the honest response to "biker
 * jacket", and padding it to 120 with jeans is the bug.
 */
export const OFF_TYPE_FLOOR = 5

/**
 * INERT. Tantivy hardcodes BM25's k1 and b as module-level constants
 * (K1 = 1.2, B = 0.75 in src/query/bm25.rs) and pg_search 0.23.1 exposes no
 * override, so these cannot be tuned — see
 * https://github.com/quickwit-oss/tantivy/issues/2924.
 *
 * Kept here, documented, so nobody spends an afternoon looking for the knob.
 * The substitute is field decomposition: signal in short, length-uniform fields
 * (search_attrs) and prose capped and down-weighted (search_body). If a future
 * release exposes them, the sweep grid gains two axes and nothing else changes.
 */
export const BM25_K1_INERT = 1.2
export const BM25_B_INERT = 0.75
