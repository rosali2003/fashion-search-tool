import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreForUser, PREFERENCE_WEIGHT, type UserPreferences } from './affinity.js'
import type { Candidate } from '../search/repository.js'

function candidate(over: Partial<Candidate>): Candidate {
  return {
    id: 1, brand: 'gap', name: 'x', name_variant: null, price_cents: 5000,
    material_clean: null, primary_fiber: null, natural_ratio: null,
    category: null, subcategory: null, silhouette: null, neckline: null,
    sleeve_length: null, length: null, rise: null, fit: null, pattern: null,
    colors: [], details: [], occasion: [],
    v_rise: null, v_waist_position: null, v_hem_break: null,
    v_shoulder_treatment: null, v_neckline_width: null, v_volume: null,
    v_vertical_line: null, v_waist_definition: null, v_drape: null, v_structure: null,
    product_url: 'https://x/1', image_hashes: [], description_clean: null,
    size_range: [], bm25_score: 1,
    ...over,
  }
}

const prefs = (over: Partial<UserPreferences> = {}): UserPreferences => ({
  body: {},
  fiberPreference: 0.9,
  priceMinCents: null,
  priceMaxCents: null,
  brandScores: { gap: 0.5, uniqlo: 0.7, aritzia: 0.7, rihoas: 0.5 },
  materialPref: {},
  silhouettePref: {},
  styleCluster: null,
  excludedBrands: [],
  ...over,
})

const order = (cands: Candidate[], p: UserPreferences | null): number[] =>
  scoreForUser(cands, p, (_c, i) => 1 - i / (cands.length + 1))
    .sort((a, b) => b.finalScore - a.finalScore)
    .map((s) => s.candidate.id)

test('REGRESSION: preferences must actually change the order', () => {
  // The original multiplicative blend, relevance * (0.5 + 0.5 * affinity),
  // produced ranking identical to the unpersonalised order for every real query.
  // The achievable affinity spread on a cold profile is ~0.04 while overcoming a
  // single rank needed ~0.16, so preferences were computed, attached to the
  // response, and silently ignored. This test fails if that regresses.
  const cands = [
    candidate({ id: 1, brand: 'gap', natural_ratio: 0.0, primary_fiber: 'polyester' }),
    candidate({ id: 2, brand: 'uniqlo', natural_ratio: 1.0, primary_fiber: 'cotton' }),
  ]
  const anonymous = order(cands, null)
  const personalised = order(cands, prefs())

  assert.deepEqual(anonymous, [1, 2], 'anonymous keeps retrieval order')
  assert.deepEqual(
    personalised,
    [2, 1],
    'a fully-natural item from a preferred brand must overtake a synthetic one one rank above',
  )
})

test('preference cannot lift a bottom-of-window result to the top', () => {
  // Bounded influence: relevance must still lead. A perfect preference match at
  // the bottom of a 10-candidate window should climb but not win.
  const cands = Array.from({ length: 10 }, (_, i) =>
    candidate({ id: i + 1, brand: 'gap', natural_ratio: 0.0, primary_fiber: 'polyester' }),
  )
  cands[9] = candidate({ id: 10, brand: 'uniqlo', natural_ratio: 1.0, primary_fiber: 'cotton' })

  const ranked = order(cands, prefs())
  assert.notEqual(ranked[0], 10, 'the last candidate must not become first')
  assert.ok(ranked.indexOf(10) < 9, 'but it should climb from last place')
})

test('identical candidates keep retrieval order exactly', () => {
  // When no preference discriminates, the affinity spread is zero. Normalisation
  // must not divide by it and shuffle results on floating-point noise.
  const cands = Array.from({ length: 5 }, (_, i) =>
    candidate({ id: i + 1, brand: 'gap', natural_ratio: 0.5, primary_fiber: 'cotton' }),
  )
  assert.deepEqual(order(cands, prefs()), [1, 2, 3, 4, 5])
})

test('unknown natural_ratio is neutral, not treated as synthetic', () => {
  // 4 products have unparseable material strings. "Unknown" and "fully synthetic"
  // are different facts and must not collapse.
  const unknown = candidate({ id: 1, brand: 'gap', natural_ratio: null })
  const synthetic = candidate({ id: 2, brand: 'gap', natural_ratio: 0 })
  const scored = scoreForUser([unknown, synthetic], prefs(), () => 1)
  assert.ok(
    scored[0].affinity > scored[1].affinity,
    'unknown must not be penalised as hard as known-synthetic',
  )
})

test('a petite profile promotes a high-rise garment', () => {
  const cands = [
    candidate({ id: 1, brand: 'gap', rise: 'low-rise', natural_ratio: 1 }),
    candidate({ id: 2, brand: 'gap', rise: 'high-rise', natural_ratio: 1 }),
  ]
  const ranked = order(cands, prefs({ body: { body_type: 'petite' } }))
  assert.deepEqual(ranked, [2, 1])

  const scored = scoreForUser(cands, prefs({ body: { body_type: 'petite' } }), () => 1)
  const high = scored.find((s) => s.candidate.id === 2)
  assert.match(high?.stylingReason ?? '', /leg line/, 'the reason is shown to the user')
})

test('excluded brands are not handled here', () => {
  // Documenting the boundary: exclusion is a hard filter applied in the BM25
  // query, because an excluded product must never be retrieved at all — not
  // retrieved and then down-weighted.
  const cands = [candidate({ id: 1, brand: 'rihoas' })]
  const scored = scoreForUser(cands, prefs({ excludedBrands: ['rihoas'] }), () => 1)
  assert.equal(scored.length, 1, 'affinity scoring does not filter')
})

test('an anonymous user gets pure relevance order', () => {
  const cands = [
    candidate({ id: 1, brand: 'rihoas', natural_ratio: 0 }),
    candidate({ id: 2, brand: 'uniqlo', natural_ratio: 1 }),
  ]
  assert.deepEqual(order(cands, null), [1, 2])
})

test('REGRESSION: a full 60-candidate window must not zero out relevance', () => {
  // The relevance ramp was a FIXED 10 ranks, which was fine only while the
  // reranker truncated the window to 10. Once the whole window reaches this
  // function, a fixed scale gives every candidate from index 10 onward a
  // relevance of exactly 0 — fifty products ordered by preference alone.
  const cands = Array.from({ length: 60 }, (_, i) =>
    candidate({
      id: i + 1,
      brand: i % 2 === 0 ? 'gap' : 'uniqlo',
      natural_ratio: (i % 5) / 4,
      primary_fiber: i % 2 === 0 ? 'polyester' : 'cotton',
    }),
  )

  const scored = scoreForUser(cands, prefs(), (_c, i) => 1 - i / 60)

  const last = scored[scored.length - 1]
  assert.ok(last.finalScore > 0, 'the last candidate must retain some relevance')

  // Every position must be distinguishable by relevance, not collapsed to a tie.
  const tailScores = scored.slice(10).map((s) => s.finalScore)
  assert.ok(
    new Set(tailScores.map((v) => v.toFixed(6))).size > 1,
    'candidates past rank 10 must not all share one relevance value',
  )
})

test('relevance still dominates preference across a wide window', () => {
  // Bounded influence has to hold at 60 as well as at 10: a perfect preference
  // match at the bottom climbs, but must not reach the top.
  const cands = Array.from({ length: 60 }, (_, i) =>
    candidate({ id: i + 1, brand: 'gap', natural_ratio: 0, primary_fiber: 'polyester' }),
  )
  cands[59] = candidate({ id: 60, brand: 'uniqlo', natural_ratio: 1, primary_fiber: 'cotton' })

  const ranked = order(cands, prefs())
  assert.notEqual(ranked[0], 60, 'the last candidate must not become first')
  assert.ok(ranked.indexOf(60) < 59, 'but it should climb')
})

test('the preference weight is in a sane range', () => {
  assert.ok(PREFERENCE_WEIGHT > 0 && PREFERENCE_WEIGHT < 0.5,
    'above 0.5 preference would outrank relevance, which is not search any more')
})
