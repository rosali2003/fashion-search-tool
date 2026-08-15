import type { Candidate } from '../search/repository.js'
import { stylingFit, bestReason, type BodyProfile, type RuleMatch } from './stylingRules.js'
import { aestheticFit, aestheticReason } from './aestheticRules.js'

/**
 * Preference-weighted scoring.
 *
 * Every preference here is a SOFT boost. The only hard preference filter in the
 * system is `excluded_brands`, applied in the BM25 query.
 *
 * That is not squeamishness, it is a measured necessity. Natural-fibre content
 * correlates violently with brand in this catalog — Gap 86%, Uniqlo 83%, Aritzia
 * 54%, Rihoas 21% — so treating "prefers natural fibres" as a filter would delete
 * roughly 80% of Rihoas, a third of the catalog, without the shopper ever asking
 * to exclude a brand. The same argument applies to price bands and silhouettes.
 */

export interface UserPreferences {
  body: BodyProfile
  fiberPreference: number | null
  priceMinCents: number | null
  priceMaxCents: number | null
  brandScores: Record<string, number>
  materialPref: Record<string, number>
  silhouettePref: Record<string, number>
  /** Q5 of the style questionnaire. Null when skipped, which scores neutral. */
  styleCluster: string | null
  excludedBrands: string[]
}

/**
 * Component weights. Sum to 1.0; tuned against the eval persona.
 *
 * `aesthetic` was added when Q5 gained a ranking path. The 0.10 came out of
 * `styling` rather than being taken proportionally from everything, because the
 * two are the closest substitutes in the blend — both are declared-heuristic
 * rule sets keyed on garment facets — and diluting brand or fiber to make room
 * would have changed the meaning of a weight that had already been measured.
 *
 * Aesthetic is deliberately no heavier than styling. It is a single tap on a
 * four-up grid, and half the catalog is silent on `pattern`, so it should not be
 * able to outvote the four body questions combined.
 */
export const AFFINITY_WEIGHTS = {
  brand: 0.30,
  fiber: 0.20,
  material: 0.15,
  styling: 0.10,
  aesthetic: 0.10,
  silhouette: 0.10,
  price: 0.05,
} as const

/**
 * How much preference is allowed to move a result, 0..1.
 *
 * This replaced a multiplicative blend of the form
 * `relevance * (0.5 + 0.5 * affinity)`, which was measurably broken: it produced
 * ranking *identical* to the unpersonalised order for every query tested.
 *
 * The arithmetic, worked through on a real query ("cotton t-shirt", petite user
 * preferring natural fibres):
 *
 *   affinity of rank 1 (gap, 100% cotton, brand score 0.5)    0.605
 *   affinity of rank 2 (uniqlo, 70% cotton, brand score 0.7)  0.645
 *   achievable spread                                         0.040
 *   spread needed to overcome a single rank                    0.160
 *
 * The spread is small because on a cold profile most components are neutral by
 * construction — `material_pref` and `silhouette_pref` are empty until ELO has
 * learned something, and styling is neutral for any garment without extracted
 * geometry. So a multiplicative blend could compute preferences, attach them to
 * the response, and then silently ignore them.
 *
 * An additive blend of two *normalised* signals fixes this and is far easier to
 * reason about: this constant is directly "how much do preferences matter". At
 * 0.35 the best-matching candidate gains 0.35 while relevance can cost it up to
 * 0.65, so a preferred product climbs several places but nothing leaps from the
 * bottom of the window to the top.
 */
/*
 * NOTE ON STRENGTH. This constant's *effect* scales with the candidate window,
 * because the relevance ramp is spread across whatever window it is given.
 * Measured as "how far down the window a perfect-affinity product can be and
 * still overtake a zero-affinity product at rank 0":
 *
 *   10-item window (the old truncated behaviour)    5 places
 *   60-item window (the full window)               31 places
 *
 * Same weight, six times the reach. 0.35 was chosen when the reranker collapsed
 * the window to 10, so it is almost certainly too strong now. Lowering it to
 * ~0.15 restores roughly the previous reach. Left at 0.35 pending a measurement
 * against the eval persona rather than a guess.
 */
export const PREFERENCE_WEIGHT = 0.35

/**
 * Smallest window the relevance ramp is spread over.
 *
 * Relevance decays linearly from 1 at the top of the candidate list to 0 at the
 * bottom, so one rank is worth `1 / (windowSize - 1)`.
 *
 * This was a FIXED 10, which was correct only while the reranker truncated the
 * window to 10 items. Once the full 60-candidate window reaches this function, a
 * fixed scale gives every candidate from index 10 onward a relevance of exactly
 * zero — leaving fifty products ordered by preference alone, with the relevance
 * signal annihilated. The bug was invisible beforehand purely because the list
 * was never longer than the scale.
 *
 * The floor keeps short result sets sane: with two candidates a window-relative
 * ramp would score them 1 and 0, letting preference flip them on almost nothing.
 */
export const MIN_RANK_SCALE = 10

/** Ranks over which relevance decays, given the actual window. */
export const rankScaleFor = (windowSize: number): number =>
  Math.max(MIN_RANK_SCALE, windowSize - 1)

const NEUTRAL = 0.5

/** Unknown brands start at the mean of known scores, less a confidence penalty. */
function brandAffinity(brand: string, scores: Record<string, number>): number {
  const known = Object.values(scores)
  if (brand in scores) return scores[brand]
  if (known.length === 0) return NEUTRAL
  const mean = known.reduce((a, b) => a + b, 0) / known.length
  return Math.max(0, mean - 0.1)
}

/**
 * How well a product's natural-fibre share matches the stated preference.
 *
 * `natural_ratio` is null when the material could not be parsed. That returns
 * neutral rather than 0: "unknown" and "fully synthetic" are different facts, and
 * conflating them would penalise the 4 products whose material strings are
 * unparseable.
 */
function fiberFit(naturalRatio: number | null, preference: number | null): number {
  if (preference === null || naturalRatio === null) return NEUTRAL
  return 1 - Math.abs(naturalRatio - preference)
}

function dictFit(value: string | null, prefs: Record<string, number>): number {
  if (!value || Object.keys(prefs).length === 0) return NEUTRAL
  return prefs[value] ?? NEUTRAL
}

/** 1.0 inside the stated band, decaying outside rather than cutting off. */
function priceFit(cents: number | null, min: number | null, max: number | null): number {
  if (cents === null || (min === null && max === null)) return NEUTRAL
  if (min !== null && cents < min) {
    // Cheaper than requested is only mildly wrong.
    return Math.max(0.4, 1 - (min - cents) / Math.max(min, 1))
  }
  if (max !== null && cents > max) {
    return Math.max(0, 1 - (cents - max) / Math.max(max, 1))
  }
  return 1
}

export interface ScoredCandidate {
  candidate: Candidate
  relevance: number
  affinity: number
  finalScore: number
  /** Rule matches, so the card can explain the fit. */
  stylingMatches: RuleMatch[]
  stylingReason: string | null
  /** Why the garment matches the declared aesthetic, when it does. */
  aestheticReason: string | null
}

/**
 * Blend relevance rank with preference affinity.
 *
 * Both signals are normalised to 0..1 across the candidate set before blending,
 * which is what makes the blend robust to the affinity spread being small: it is
 * the *relative* ordering by preference that matters, not the absolute value.
 *
 * Relevance is the upstream position rather than the raw BM25 score, because a
 * score is unbounded and one very high scorer would otherwise dominate regardless
 * of preference.
 */
export function scoreForUser(
  candidates: Candidate[],
  prefs: UserPreferences | null,
  relevanceOf: (c: Candidate, index: number) => number,
): ScoredCandidate[] {
  if (!prefs) {
    return candidates.map((c, i) => ({
      candidate: c,
      relevance: relevanceOf(c, i),
      affinity: NEUTRAL,
      finalScore: relevanceOf(c, i),
      stylingMatches: [],
      stylingReason: null,
      aestheticReason: null,
    }))
  }

  const raw = rawAffinities(candidates, prefs)

  // Min-max normalise. When every candidate scores the same — a query where no
  // preference discriminates — the spread is zero and every candidate gets the
  // neutral 0.5, so relevance order is preserved exactly rather than shuffled by
  // floating-point noise.
  const values = raw.map((r) => r.affinity)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const spread = hi - lo
  const normalise = (v: number): number => (spread < 1e-9 ? NEUTRAL : (v - lo) / spread)

  // Spread the ramp across the window actually given, with a floor. See
  // MIN_RANK_SCALE: a fixed scale zeroed the relevance of every candidate past
  // index 10 once the full window started arriving here.
  const scale = rankScaleFor(candidates.length)

  return raw.map((r, i) => {
    const relevance = relevanceOf(r.candidate, i)
    const relevanceNorm = Math.max(0, 1 - i / scale)
    return {
      candidate: r.candidate,
      relevance,
      affinity: r.affinity,
      finalScore:
        (1 - PREFERENCE_WEIGHT) * relevanceNorm + PREFERENCE_WEIGHT * normalise(r.affinity),
      stylingMatches: r.stylingMatches,
      stylingReason: r.stylingReason,
      aestheticReason: r.aestheticReason,
    }
  })
}

interface RawAffinity {
  candidate: Candidate
  affinity: number
  stylingMatches: RuleMatch[]
  stylingReason: string | null
  aestheticReason: string | null
}

function rawAffinities(candidates: Candidate[], prefs: UserPreferences): RawAffinity[] {
  const w = AFFINITY_WEIGHTS

  return candidates.map((c) => {
    const styling = stylingFit(prefs.body, {
      v_rise: c.v_rise,
      v_waist_position: c.v_waist_position,
      v_hem_break: c.v_hem_break,
      v_shoulder_treatment: c.v_shoulder_treatment,
      v_neckline_width: c.v_neckline_width,
      v_volume: c.v_volume,
      v_vertical_line: c.v_vertical_line,
      v_waist_definition: c.v_waist_definition,
      rise: c.rise,
      length: c.length,
      neckline: c.neckline,
      details: c.details,
      silhouette: c.silhouette,
    })

    const aesthetic = aestheticFit(prefs.styleCluster, {
      pattern: c.pattern,
      silhouette: c.silhouette,
      primary_fiber: c.primary_fiber,
      neckline: c.neckline,
      details: c.details,
    })

    const affinity =
      w.brand * brandAffinity(c.brand, prefs.brandScores) +
      w.styling * styling.score +
      w.aesthetic * aesthetic.score +
      w.fiber * fiberFit(c.natural_ratio, prefs.fiberPreference) +
      w.material * dictFit(c.primary_fiber, prefs.materialPref) +
      w.silhouette * dictFit(c.silhouette, prefs.silhouettePref) +
      w.price * priceFit(c.price_cents, prefs.priceMinCents, prefs.priceMaxCents)

    return {
      candidate: c,
      affinity,
      stylingMatches: styling.matches,
      stylingReason: bestReason(styling.matches),
      aestheticReason: aestheticReason(aesthetic.match),
    }
  })
}
