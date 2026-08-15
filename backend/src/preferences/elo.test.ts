import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyComparison, replay, initialBrandScores, isProfileStable,
  K_FACTOR, NEUTRAL, STABLE_AFTER_COMPARISONS, type Dimensions,
} from './elo.js'

const fresh = (): Dimensions => ({ brand_scores: {}, material_pref: {}, silhouette_pref: {} })

const side = (brand: string, fiber: string | null, sil: string | null) => ({
  brand, primary_fiber: fiber, silhouette: sil,
})

test('a win raises the winner and lowers the loser', () => {
  const d = applyComparison(fresh(), side('aritzia', 'cotton', 'relaxed'), side('rihoas', 'polyester', 'bodycon'))
  assert.ok(d.brand_scores.aritzia > NEUTRAL)
  assert.ok(d.brand_scores.rihoas < NEUTRAL)
  assert.ok(d.material_pref.cotton > NEUTRAL)
  assert.ok(d.material_pref.polyester < NEUTRAL)
})

test('scores stay clamped to [0,1] under sustained one-sided input', () => {
  let d = fresh()
  for (let i = 0; i < 500; i++) {
    d = applyComparison(d, side('aritzia', 'cotton', 'relaxed'), side('rihoas', 'polyester', 'bodycon'))
  }
  assert.ok(d.brand_scores.aritzia <= 1)
  assert.ok(d.brand_scores.rihoas >= 0)
  assert.ok(d.material_pref.cotton <= 1)
})

test('a same-brand pair generates no brand signal', () => {
  // Two garments from one brand say nothing about brand preference, which is why
  // the pair selector prefers cross-brand comparisons.
  const d = applyComparison(fresh(), side('gap', 'cotton', 'relaxed'), side('gap', 'polyester', 'fitted'))
  assert.equal(d.brand_scores.gap, undefined, 'brand must be untouched')
  assert.ok(d.material_pref.cotton > NEUTRAL, 'but material still moves')
})

test('a dimension only one side has still produces signal', () => {
  const d = applyComparison(fresh(), side('gap', 'cotton', 'relaxed'), side('rihoas', null, null))
  assert.ok(d.material_pref.cotton > NEUTRAL)
  assert.equal(Object.keys(d.silhouette_pref).length, 1)
})

test('the profile stabilises within the target number of comparisons', () => {
  let d = fresh()
  for (let i = 0; i < STABLE_AFTER_COMPARISONS; i++) {
    d = applyComparison(d, side('aritzia', 'linen', 'relaxed'), side('rihoas', 'polyester', 'bodycon'))
  }
  // The product plan targets a usable profile after 20 comparisons; at K=0.1 a
  // consistently-preferred brand should be clearly separated from neutral by then.
  assert.ok(d.brand_scores.aritzia > 0.85, `expected >0.85, got ${d.brand_scores.aritzia}`)
  assert.ok(d.brand_scores.rihoas < 0.15, `expected <0.15, got ${d.brand_scores.rihoas}`)
  assert.equal(isProfileStable(STABLE_AFTER_COMPARISONS), true)
  assert.equal(isProfileStable(STABLE_AFTER_COMPARISONS - 1), false)
})

test('replay reproduces an incrementally-built profile exactly', () => {
  // This is the property that makes the K-factor tunable after the fact: if
  // replay diverged from the incremental path, re-simulating history at a
  // different K would be meaningless.
  const history = [
    { winner: side('aritzia', 'cotton', 'relaxed'), loser: side('rihoas', 'polyester', 'bodycon') },
    { winner: side('uniqlo', 'linen', 'relaxed'), loser: side('gap', 'cotton', 'fitted') },
    { winner: side('aritzia', 'linen', 'oversized'), loser: side('uniqlo', 'polyester', 'fitted') },
  ]

  let incremental = fresh()
  for (const h of history) incremental = applyComparison(incremental, h.winner, h.loser)

  assert.deepEqual(replay(history, fresh()), incremental)
})

test('replay at a different K produces a different, stronger profile', () => {
  const history = Array.from({ length: 10 }, () => ({
    winner: side('aritzia', 'cotton', 'relaxed'),
    loser: side('rihoas', 'polyester', 'bodycon'),
  }))
  const conservative = replay(history, fresh(), K_FACTOR)
  const aggressive = replay(history, fresh(), 0.3)
  assert.ok(aggressive.brand_scores.aritzia > conservative.brand_scores.aritzia)
})

test('brand priors follow the onboarding locks', () => {
  const scores = initialBrandScores(['aritzia', 'gap', 'rihoas', 'uniqlo'], ['aritzia', 'uniqlo'])
  assert.equal(scores.aritzia, 0.7, 'selected brands start warm')
  assert.equal(scores.uniqlo, 0.7)
  assert.equal(scores.gap, 0.5, 'unselected brands start neutral')
  assert.equal(scores.rihoas, 0.5)
})

test('applyComparison does not mutate its input', () => {
  const before = fresh()
  before.brand_scores.gap = 0.5
  const snapshot = JSON.stringify(before)
  applyComparison(before, side('aritzia', 'cotton', null), side('gap', 'polyester', null))
  assert.equal(JSON.stringify(before), snapshot)
})
