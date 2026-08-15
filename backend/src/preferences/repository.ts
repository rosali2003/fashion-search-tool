import { db } from '../db/index.js'
import type { UserPreferences } from './affinity.js'
import { initialBrandScores, NEUTRAL, type ComparisonSide, type Dimensions, applyComparison, replay } from './elo.js'
import { seedPreferenceDict, SILHOUETTE_TO_CATALOG, MATERIAL_TO_CATALOG } from './options.js'

/** Brands currently in the catalog, for seeding brand priors. */
export async function knownBrands(): Promise<string[]> {
  const rows = await db
    .selectFrom('products')
    .select('brand')
    .distinct()
    .where('is_active', '=', true)
    .execute()
  return rows.map((r) => r.brand).sort()
}

export async function loadPreferences(userId: string): Promise<UserPreferences | null> {
  const row = await db
    .selectFrom('user_preferences')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst()
  if (!row) return null

  return {
    body: {
      height_cm: row.height_cm,
      body_type: row.body_type,
      shoulders: row.shoulders,
      torso: row.torso,
      waist: row.waist,
    },
    fiberPreference: row.fiber_preference,
    priceMinCents: row.price_min_cents,
    priceMaxCents: row.price_max_cents,
    brandScores: row.brand_scores as Record<string, number>,
    materialPref: row.material_pref as Record<string, number>,
    silhouettePref: row.silhouette_pref as Record<string, number>,
    styleCluster: row.style_cluster,
    excludedBrands: row.excluded_brands,
  }
}

export interface OnboardingInput {
  displayName?: string | null
  heightCm?: number | null
  bodyType?: string | null
  shoulders?: string | null
  torso?: string | null
  waist?: string | null
  fiberPreference?: number | null
  qualityTier?: string | null
  priceMinCents?: number | null
  priceMaxCents?: number | null
  /** Brands the user says they shop. Seeded at 0.7; everything else at 0.5. */
  selectedBrands?: string[]
  excludedBrands?: string[]
  /**
   * Q1 and Q2 of the style questionnaire, in the questionnaire's own vocabulary
   * ('fitted', 'wool'). Expanded to catalog values before storage — see
   * SILHOUETTE_TO_CATALOG in options.ts for why storing them raw would produce a
   * question that appears answered and changes nothing.
   */
  silhouettePrefs?: string[]
  materialPrefs?: string[]
  /** Q5. Declared, never learned. */
  styleCluster?: string | null
}

export async function createUser(input: OnboardingInput): Promise<{ userId: string }> {
  const brands = await knownBrands()

  const user = await db
    .insertInto('users')
    .values({ display_name: input.displayName ?? null })
    .returning('id')
    .executeTakeFirstOrThrow()

  await db
    .insertInto('user_preferences')
    .values({
      user_id: user.id,
      height_cm: input.heightCm ?? null,
      body_type: input.bodyType ?? null,
      shoulders: input.shoulders ?? null,
      torso: input.torso ?? null,
      waist: input.waist ?? null,
      fiber_preference: input.fiberPreference ?? null,
      quality_tier: input.qualityTier ?? null,
      style_cluster: input.styleCluster ?? null,
      price_min_cents: input.priceMinCents ?? null,
      price_max_cents: input.priceMaxCents ?? null,
      excluded_brands: input.excludedBrands ?? [],
      brand_scores: JSON.stringify(initialBrandScores(brands, input.selectedBrands ?? [])),
      // Q1/Q2 seed the same dictionaries ELO later updates, so an onboarding
      // answer and a learned preference are the same kind of thing and the
      // second can talk the profile out of the first.
      material_pref: JSON.stringify(
        seedPreferenceDict(input.materialPrefs ?? [], MATERIAL_TO_CATALOG),
      ),
      silhouette_pref: JSON.stringify(
        seedPreferenceDict(input.silhouettePrefs ?? [], SILHOUETTE_TO_CATALOG),
      ),
      onboarded_at: new Date(),
    })
    .execute()

  return { userId: user.id }
}

export async function updatePreferences(userId: string, input: OnboardingInput): Promise<void> {
  const brands = await knownBrands()
  const patch: Record<string, unknown> = { updated_at: new Date() }

  if (input.heightCm !== undefined) patch.height_cm = input.heightCm
  if (input.bodyType !== undefined) patch.body_type = input.bodyType
  if (input.shoulders !== undefined) patch.shoulders = input.shoulders
  if (input.torso !== undefined) patch.torso = input.torso
  if (input.waist !== undefined) patch.waist = input.waist
  if (input.fiberPreference !== undefined) patch.fiber_preference = input.fiberPreference
  if (input.qualityTier !== undefined) patch.quality_tier = input.qualityTier
  if (input.styleCluster !== undefined) patch.style_cluster = input.styleCluster
  if (input.priceMinCents !== undefined) patch.price_min_cents = input.priceMinCents
  if (input.priceMaxCents !== undefined) patch.price_max_cents = input.priceMaxCents
  if (input.excludedBrands !== undefined) patch.excluded_brands = input.excludedBrands
  // Re-answering Q1/Q2 overwrites the seed AND any ELO learning on those
  // dimensions. That is the intended reading of an edit: the shopper is
  // correcting the profile, so a stale learned value should not survive the
  // correction and quietly outweigh it.
  if (input.silhouettePrefs !== undefined) {
    patch.silhouette_pref = JSON.stringify(
      seedPreferenceDict(input.silhouettePrefs, SILHOUETTE_TO_CATALOG),
    )
  }
  if (input.materialPrefs !== undefined) {
    patch.material_pref = JSON.stringify(
      seedPreferenceDict(input.materialPrefs, MATERIAL_TO_CATALOG),
    )
  }
  // Re-selecting brands resets those priors to 0.7, per the product plan's rule
  // that re-adding a removed brand restores its onboarding score.
  if (input.selectedBrands !== undefined) {
    patch.brand_scores = JSON.stringify(initialBrandScores(brands, input.selectedBrands))
  }

  await db.updateTable('user_preferences').set(patch as never).where('user_id', '=', userId).execute()
}

async function sideOf(productId: number): Promise<ComparisonSide | null> {
  const row = await db
    .selectFrom('products')
    .select(['brand', 'primary_fiber', 'silhouette'])
    .where('id', '=', productId)
    .executeTakeFirst()
  return row ?? null
}

/**
 * Record a comparison and fold it into the derived scores.
 *
 * The log write and the projection update are one transaction: a log entry
 * without its score update would silently diverge the two, and the divergence
 * would only surface much later as a replay mismatch.
 */
export async function recordComparison(
  userId: string,
  winnerId: number,
  loserId: number,
  source: 'ab' | 'find_similar' = 'ab',
): Promise<{ comparisons: number } | { error: string }> {
  if (winnerId === loserId) return { error: 'winner and loser must differ' }

  const [winner, loser] = await Promise.all([sideOf(winnerId), sideOf(loserId)])
  if (!winner || !loser) return { error: 'unknown product' }

  const prefs = await db
    .selectFrom('user_preferences')
    .select(['brand_scores', 'material_pref', 'silhouette_pref', 'comparisons_count'])
    .where('user_id', '=', userId)
    .executeTakeFirst()
  if (!prefs) return { error: 'unknown user' }

  const dims: Dimensions = {
    brand_scores: prefs.brand_scores as Record<string, number>,
    material_pref: prefs.material_pref as Record<string, number>,
    silhouette_pref: prefs.silhouette_pref as Record<string, number>,
  }
  const next = applyComparison(dims, winner, loser)
  const comparisons = prefs.comparisons_count + 1

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('ab_comparisons')
      .values({ user_id: userId, winner_product_id: winnerId, loser_product_id: loserId, source })
      .execute()
    await trx
      .updateTable('user_preferences')
      .set({
        brand_scores: JSON.stringify(next.brand_scores),
        material_pref: JSON.stringify(next.material_pref),
        silhouette_pref: JSON.stringify(next.silhouette_pref),
        comparisons_count: comparisons,
        updated_at: new Date(),
      })
      .where('user_id', '=', userId)
      .execute()
  })

  return { comparisons }
}

/**
 * Recompute a user's dimensions from their full comparison history.
 *
 * Used to validate the K-factor: run at several K values over the same log and
 * compare, instead of re-collecting comparisons from beta users.
 */
export async function replayUser(userId: string, k?: number): Promise<Dimensions> {
  const rows = await db
    .selectFrom('ab_comparisons as c')
    .innerJoin('products as w', 'w.id', 'c.winner_product_id')
    .innerJoin('products as l', 'l.id', 'c.loser_product_id')
    .select([
      'w.brand as w_brand', 'w.primary_fiber as w_fiber', 'w.silhouette as w_sil',
      'l.brand as l_brand', 'l.primary_fiber as l_fiber', 'l.silhouette as l_sil',
    ])
    .where('c.user_id', '=', userId)
    .orderBy('c.created_at', 'asc')
    .execute()

  const brands = await knownBrands()
  const initial: Dimensions = {
    brand_scores: Object.fromEntries(brands.map((b) => [b, NEUTRAL])),
    material_pref: {},
    silhouette_pref: {},
  }

  return replay(
    rows.map((r) => ({
      winner: { brand: r.w_brand, primary_fiber: r.w_fiber, silhouette: r.w_sil },
      loser: { brand: r.l_brand, primary_fiber: r.l_fiber, silhouette: r.l_sil },
    })),
    initial,
    k,
  )
}

/**
 * Pick a pair to compare.
 *
 * Prefers cross-brand pairs: a same-brand comparison generates no brand signal at
 * all, and brand is the heaviest term in the affinity blend.
 */
export function pickPair<T extends { brand: string }>(items: T[]): [T, T] | null {
  if (items.length < 2) return null
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].brand !== items[j].brand) return [items[i], items[j]]
    }
  }
  return [items[0], items[1]]
}
