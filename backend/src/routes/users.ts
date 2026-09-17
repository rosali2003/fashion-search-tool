import { Hono } from 'hono'
import { db } from '../db/index.js'
import { currentSession, issueSession, requireOwner } from '../auth/repository.js'
import { readObject } from '../auth/security.js'
import {
  createUser, updatePreferences, loadPreferences, knownBrands,
  recordComparison, pickPair,
} from '../preferences/repository.js'
import { imageUrlFor } from './imageUrl.js'
import { isProfileStable, STABLE_AFTER_COMPARISONS } from '../preferences/elo.js'
import {
  BODY_TYPES, SHOULDERS, TORSO, WAIST, QUALITY_TIERS,
  SILHOUETTE_PREFS, MATERIAL_PREFS, AESTHETICS,
} from '../preferences/options.js'

const users = new Hono()
users.use('*', async (context, next) => {
  context.header('Cache-Control', 'no-store')
  await next()
})

const oneOf = (allowed: readonly string[], v: unknown): string | null =>
  typeof v === 'string' && allowed.includes(v) ? v : null

const num = (v: unknown, lo: number, hi: number): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v >= lo && v <= hi ? v : null
}

/**
 * Multi-select answers, filtered to the known vocabulary.
 *
 * Unknown values are dropped rather than rejected: these feed the seed maps in
 * options.ts, and a value with no mapping would silently contribute nothing
 * anyway. Dropping it here makes that explicit at the boundary.
 */
const manyOf = (allowed: readonly string[], v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && allowed.includes(x)) : []

/** The onboarding vocabulary, so the frontend never hardcodes it. */
users.get('/options', async (c) => {
  return c.json({
    brands: await knownBrands(),
    bodyTypes: BODY_TYPES,
    shoulders: SHOULDERS,
    torso: TORSO,
    waist: WAIST,
    qualityTiers: QUALITY_TIERS,
    // Q1, Q2 and Q5 of the style questionnaire.
    silhouettePrefs: SILHOUETTE_PREFS,
    materialPrefs: MATERIAL_PREFS,
    aesthetics: AESTHETICS,
    stableAfterComparisons: STABLE_AFTER_COMPARISONS,
  })
})

function parseOnboarding(body: Record<string, unknown>) {
  return {
    displayName: typeof body.displayName === 'string' ? body.displayName.slice(0, 80) : null,
    heightCm: num(body.heightCm, 120, 220),
    bodyType: oneOf(BODY_TYPES, body.bodyType),
    shoulders: oneOf(SHOULDERS, body.shoulders),
    torso: oneOf(TORSO, body.torso),
    waist: oneOf(WAIST, body.waist),
    fiberPreference: num(body.fiberPreference, 0, 1),
    qualityTier: oneOf(QUALITY_TIERS, body.qualityTier),
    silhouettePrefs: manyOf(SILHOUETTE_PREFS, body.silhouettePrefs),
    materialPrefs: manyOf(MATERIAL_PREFS, body.materialPrefs),
    styleCluster: oneOf(AESTHETICS, body.styleCluster),
    priceMinCents: num(body.priceMinCents, 0, 1_000_000),
    priceMaxCents: num(body.priceMaxCents, 0, 1_000_000),
    selectedBrands: Array.isArray(body.selectedBrands)
      ? body.selectedBrands.filter((b): b is string => typeof b === 'string')
      : [],
    excludedBrands: Array.isArray(body.excludedBrands)
      ? body.excludedBrands.filter((b): b is string => typeof b === 'string')
      : [],
  }
}

users.post('/', async (c) => {
  const body = await readObject(c)
  if (!body) {
    return c.json({ error: 'Body must be JSON' }, 400)
  }
  const session = await currentSession(c)
  if (session) {
    await updatePreferences(session.user_id, parseOnboarding(body))
    return c.json({ userId: session.user_id })
  }
  const { userId } = await createUser(parseOnboarding(body))
  await issueSession(c, userId)
  return c.json({ userId }, 201)
})

users.use('/:id/*', requireOwner)

users.get('/:id', async (c) => {
  const id = c.req.param('id')
  const prefs = await loadPreferences(id)
  if (!prefs) return c.json({ error: 'Not found' }, 404)

  const row = await db
    .selectFrom('user_preferences')
    .select(['comparisons_count', 'quality_tier'])
    .where('user_id', '=', id)
    .executeTakeFirstOrThrow()

  // Ranked brand affinities, for the profile summary on the search home screen.
  const topBrands = Object.entries(prefs.brandScores)
    .sort(([, a], [, b]) => b - a)
    .map(([brand, score]) => ({ brand, score }))

  return c.json({
    body: prefs.body,
    fiberPreference: prefs.fiberPreference,
    qualityTier: row.quality_tier,
    priceMinCents: prefs.priceMinCents,
    priceMaxCents: prefs.priceMaxCents,
    excludedBrands: prefs.excludedBrands,
    brands: topBrands,
    materialPref: prefs.materialPref,
    silhouettePref: prefs.silhouettePref,
    styleCluster: prefs.styleCluster,
    comparisonsCount: row.comparisons_count,
    profileStable: isProfileStable(row.comparisons_count),
  })
})

users.put('/:id/preferences', async (c) => {
  const id = c.req.param('id')
  if (!(await loadPreferences(id))) return c.json({ error: 'Not found' }, 404)

  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400)
  }
  await updatePreferences(id, parseOnboarding(body))
  return c.json({ ok: true })
})

/**
 * Record an A/B comparison.
 *
 * `source` distinguishes an explicit comparison from a "find similar" click,
 * which the product plan treats as an implicit positive with the same ELO step.
 */
users.post('/:id/comparisons', async (c) => {
  const id = c.req.param('id')
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400)
  }

  const winner = num(body.winnerId, 1, Number.MAX_SAFE_INTEGER)
  const loser = num(body.loserId, 1, Number.MAX_SAFE_INTEGER)
  if (winner === null || loser === null) {
    return c.json({ error: 'winnerId and loserId are required' }, 400)
  }
  const source = body.source === 'find_similar' ? 'find_similar' : 'ab'

  const res = await recordComparison(id, winner, loser, source)
  if ('error' in res) return c.json(res, 400)

  return c.json({ ok: true, comparisons: res.comparisons, profileStable: isProfileStable(res.comparisons) })
})

/**
 * Suggest a pair to compare, drawn from products the user has just seen.
 *
 * Cross-brand is preferred because a same-brand pair produces no brand signal,
 * and brand is the heaviest term in the affinity blend.
 */
users.post('/:id/pair', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400)
  }
  const ids = Array.isArray(body.productIds)
    ? body.productIds.filter((v): v is number => typeof v === 'number')
    : []
  if (ids.length < 2) return c.json({ pair: null })

  const rows = await db
    .selectFrom('products')
    .select(['id', 'brand', 'name', 'price_cents', 'image_hashes', 'material_clean'])
    .where('id', 'in', ids)
    .execute()

  const pair = pickPair(rows)
  if (!pair) return c.json({ pair: null })

  return c.json({
    pair: pair.map((p) => ({
      id: p.id,
      brand: p.brand,
      name: p.name,
      price_cents: p.price_cents,
      material_badge: p.material_clean?.split(',')[0]?.trim() ?? null,
      image_url: imageUrlFor(p.image_hashes),
    })),
  })
})

export default users
