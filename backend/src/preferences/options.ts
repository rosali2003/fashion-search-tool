/**
 * Onboarding answer vocabularies.
 *
 * Shared by the route validator, the styling rules' `when` clauses, and the
 * frontend (via GET /api/users/options) so the three cannot drift. A body_type
 * the questionnaire can produce but no rule matches is a silently dead question,
 * which is exactly the failure mode this file exists to prevent.
 *
 * Every value here is referenced by at least one rule in stylingRules.ts.
 */

export const BODY_TYPES = ['petite', 'tall', 'straight', 'curvy', 'athletic'] as const
export const SHOULDERS = ['narrow', 'average', 'wide'] as const
export const TORSO = ['short', 'average', 'long'] as const
export const WAIST = ['defined', 'average', 'undefined'] as const

/**
 * Quality tier is a *declared heuristic*, not a measurement. The catalog has no
 * construction data — no stitch density, no country of origin beyond "Imported" —
 * so this can only ever be inferred from fibre composition, price band, and the
 * finish cues vision can see. Label it as a heuristic wherever it is shown.
 */
export const QUALITY_TIERS = ['value', 'mid', 'premium'] as const

/**
 * Q1, Q2 and Q5 from the product plan's style questionnaire.
 *
 * These three seed the taste profile *before* any A/B comparison happens, which
 * is the plan's stated cold-start fix. Q1 and Q2 write directly into the
 * `silhouette_pref` and `material_pref` dictionaries that ELO later updates, so
 * an onboarding answer and a learned preference are the same kind of thing and
 * decay into each other naturally.
 */
export const SILHOUETTE_PREFS = ['relaxed', 'oversized', 'fitted', 'structured'] as const
export const MATERIAL_PREFS = ['cotton', 'linen', 'silk', 'wool', 'other'] as const
export const AESTHETICS = ['minimal', 'classic', 'casual', 'eclectic'] as const

/**
 * Seed strength for a chosen questionnaire answer.
 *
 * Deliberately below the 0.7 brand prior. Brand selection is a statement about
 * shops the user actually buys from; a silhouette tapped from a four-up grid is a
 * far weaker signal, and ELO should be able to talk the profile out of it within
 * a handful of comparisons.
 */
export const QUESTIONNAIRE_PRIOR = 0.65

/**
 * The questionnaire's vocabulary is NOT the catalog's vocabulary, and the gap is
 * the whole reason these maps exist.
 *
 * `dictFit` in affinity.ts looks up the raw `silhouette` column, so seeding
 * `{ fitted: 0.65 }` would never match anything — the catalog has no product
 * whose silhouette is the string "fitted". It has `slim`, `sheath` and `mermaid`.
 * Storing the user-facing word would produce a question that looks answered and
 * changes nothing, which is exactly the failure this file exists to prevent.
 *
 * Weights within a group are relative confidence that the catalog value really
 * expresses the chosen aesthetic, scaled by QUESTIONNAIRE_PRIOR at seed time.
 *
 * Measured coverage, so the limits are visible rather than discovered later:
 * `silhouette` is null on 200 of 355 active products, so Q1 discriminates on
 * roughly 44% of the catalog and returns neutral elsewhere.
 */
export const SILHOUETTE_TO_CATALOG: Record<string, Record<string, number>> = {
  relaxed: { relaxed: 1.0, 'wide-leg': 0.8, boxy: 0.75 },
  oversized: { oversized: 1.0, boxy: 0.85, bubble: 0.75, relaxed: 0.7 },
  fitted: { slim: 1.0, sheath: 0.9, mermaid: 0.85 },
  structured: { shift: 0.95, 'a-line': 0.85, sheath: 0.8, boxy: 0.75 },
}

/**
 * Q2 onto `primary_fiber`.
 *
 * `wool` covers cashmere because a shopper choosing wool is expressing a
 * preference for animal-fibre warmth, not for a specific goat. Note the catalog
 * makes several of these nearly inert: linen 8 products, cashmere 4, silk 2,
 * wool 1, against cotton 148 and polyester 120. The answers are still honest
 * soft boosts, they simply have little to grip on until the catalog grows.
 */
export const MATERIAL_TO_CATALOG: Record<string, Record<string, number>> = {
  cotton: { cotton: 1.0 },
  linen: { linen: 1.0 },
  silk: { silk: 1.0 },
  wool: { wool: 1.0, cashmere: 0.95 },
  other: {
    polyester: 1.0, nylon: 1.0, acrylic: 1.0, acetate: 1.0,
    viscose: 0.9, lyocell: 0.9, modal: 0.9,
  },
}

/**
 * Expand questionnaire answers into a catalog-keyed preference dictionary.
 *
 * Overlapping answers take the maximum rather than summing: picking both
 * `relaxed` and `oversized` should not push `boxy` above the prior ceiling and
 * make it outrank a directly-chosen value.
 */
export function seedPreferenceDict(
  answers: readonly string[],
  map: Record<string, Record<string, number>>,
  prior = QUESTIONNAIRE_PRIOR,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const answer of answers) {
    for (const [catalogValue, confidence] of Object.entries(map[answer] ?? {})) {
      out[catalogValue] = Math.max(out[catalogValue] ?? 0, prior * confidence)
    }
  }
  return out
}

export type BodyType = (typeof BODY_TYPES)[number]
export type Shoulders = (typeof SHOULDERS)[number]
export type Torso = (typeof TORSO)[number]
export type Waist = (typeof WAIST)[number]
export type QualityTier = (typeof QUALITY_TIERS)[number]
export type SilhouettePref = (typeof SILHOUETTE_PREFS)[number]
export type MaterialPref = (typeof MATERIAL_PREFS)[number]
export type Aesthetic = (typeof AESTHETICS)[number]
