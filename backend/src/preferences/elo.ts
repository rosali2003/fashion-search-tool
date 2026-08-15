/**
 * ELO-style preference learning from A/B comparisons.
 *
 * Scores live in `user_preferences` but are a *derived projection* of the
 * append-only `ab_comparisons` log. That split is the point: the product plan
 * wants K validated against real behaviour, and 20 comparisons per beta user is
 * expensive to collect twice. Keeping the raw events means a badly chosen K can be
 * re-simulated from history with `replay`, not re-gathered from users.
 */

/**
 * Update magnitude. Conservative by design — the plan's pre-build lock specifies
 * 0.1 with validation against beta users before shipping a larger value.
 *
 * At K=0.1 a dimension moves from the 0.5 neutral start to roughly 0.83 after 10
 * consistent wins, so a profile stabilises around the 20 comparisons the product
 * plan targets.
 */
export const K_FACTOR = 0.1

/** Onboarding priors, per the pre-build locks. */
export const SELECTED_BRAND_PRIOR = 0.7
export const UNSELECTED_BRAND_PRIOR = 0.5
export const NEUTRAL = 0.5

const clamp = (v: number): number => Math.min(1, Math.max(0, v))

export interface Dimensions {
  brand_scores: Record<string, number>
  material_pref: Record<string, number>
  silhouette_pref: Record<string, number>
}

/** The attributes of one side of a comparison. */
export interface ComparisonSide {
  brand: string
  primary_fiber: string | null
  silhouette: string | null
}

/**
 * Apply one comparison.
 *
 * Pure and total: takes the current dimensions, returns new ones. Nothing is
 * mutated, which is what makes `replay` trivially correct.
 *
 * A dimension where both sides agree is skipped entirely. Rewarding and punishing
 * the same value in one step is a no-op at best, and for brand it is actively
 * misleading — a same-brand pair carries no brand signal, which is why the pair
 * selector prefers cross-brand comparisons.
 */
export function applyComparison(
  dims: Dimensions,
  winner: ComparisonSide,
  loser: ComparisonSide,
  k = K_FACTOR,
): Dimensions {
  const next: Dimensions = {
    brand_scores: { ...dims.brand_scores },
    material_pref: { ...dims.material_pref },
    silhouette_pref: { ...dims.silhouette_pref },
  }

  const bump = (
    dict: Record<string, number>,
    winKey: string | null,
    loseKey: string | null,
  ): void => {
    if (!winKey || !loseKey) {
      // One side has no value for this dimension. Reward the side that does,
      // rather than skipping: a comparison where only one garment has a known
      // silhouette still says something about that silhouette.
      if (winKey) {
        const cur = dict[winKey] ?? NEUTRAL
        dict[winKey] = clamp(cur + k * (1 - cur))
      }
      if (loseKey) {
        const cur = dict[loseKey] ?? NEUTRAL
        dict[loseKey] = clamp(cur - k * cur)
      }
      return
    }
    if (winKey === loseKey) return // no signal

    const w = dict[winKey] ?? NEUTRAL
    const l = dict[loseKey] ?? NEUTRAL
    dict[winKey] = clamp(w + k * (1 - w))
    dict[loseKey] = clamp(l - k * l)
  }

  bump(next.brand_scores, winner.brand, loser.brand)
  bump(next.material_pref, winner.primary_fiber, loser.primary_fiber)
  bump(next.silhouette_pref, winner.silhouette, loser.silhouette)

  return next
}

/**
 * Rebuild dimensions from a comparison history.
 *
 * This is what makes the K-factor a tunable rather than a commitment: run it over
 * the same log at K=0.2 and compare the resulting profiles without asking anyone
 * to click anything again.
 */
export function replay(
  history: { winner: ComparisonSide; loser: ComparisonSide }[],
  initial: Dimensions,
  k = K_FACTOR,
): Dimensions {
  return history.reduce((dims, h) => applyComparison(dims, h.winner, h.loser, k), initial)
}

/** Brand priors from the onboarding brand multi-select. */
export function initialBrandScores(
  allBrands: readonly string[],
  selected: readonly string[],
): Record<string, number> {
  const sel = new Set(selected.map((b) => b.toLowerCase()))
  return Object.fromEntries(
    allBrands.map((b) => [
      b.toLowerCase(),
      sel.has(b.toLowerCase()) ? SELECTED_BRAND_PRIOR : UNSELECTED_BRAND_PRIOR,
    ]),
  )
}

/**
 * The product plan surfaces "your profile is built" at 20 comparisons. Exposed
 * here so the copy and the threshold cannot drift apart.
 */
export const STABLE_AFTER_COMPARISONS = 20

export function isProfileStable(comparisonsCount: number): boolean {
  return comparisonsCount >= STABLE_AFTER_COMPARISONS
}
