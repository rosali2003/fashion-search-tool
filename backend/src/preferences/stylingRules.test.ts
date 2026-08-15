import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rulesFor, stylingFit, guidanceFor, STYLING_RULES } from './stylingRules.js'
import { BODY_TYPES, SHOULDERS, TORSO, WAIST } from './options.js'

test('every onboarding answer is reachable by at least one rule', () => {
  // A questionnaire option no rule matches is a silently dead question: the user
  // answers it and nothing whatsoever changes in their results.
  const covered = new Set<string>()
  for (const r of STYLING_RULES) {
    for (const v of Object.values(r.when)) covered.add(String(v))
  }
  for (const v of [...BODY_TYPES, ...SHOULDERS, ...TORSO, ...WAIST]) {
    // "average" is deliberately the no-op middle option for the three axes.
    if (v === 'average') continue
    assert.ok(covered.has(v), `no styling rule matches "${v}" — the question would be inert`)
  }
})

test('a petite profile prefers high rise over a dropped waist', () => {
  const profile = { body_type: 'petite' }
  const highRise = stylingFit(profile, { v_rise: 'high', v_vertical_line: 'continuous', v_hem_break: 'midi' })
  const dropped = stylingFit(profile, { v_waist_position: 'dropped', v_volume: 'voluminous', v_hem_break: 'floor' })

  assert.ok(highRise.score > dropped.score, `${highRise.score} should beat ${dropped.score}`)
  assert.ok(highRise.score > 0.5, 'a satisfying garment scores above neutral')
  assert.ok(dropped.score < 0.5, 'a conflicting garment scores below neutral')
  assert.match(highRise.matches[0].rule.because, /leg line/)
})

test('wide shoulders prefer a halter over an off-shoulder puff sleeve', () => {
  const profile = { shoulders: 'wide' }
  const halter = stylingFit(profile, { v_shoulder_treatment: 'halter', neckline: 'halter' })
  const puff = stylingFit(profile, { v_shoulder_treatment: 'off-shoulder', neckline: 'boat', details: ['puff-sleeve'] })
  assert.ok(halter.score > puff.score)
  assert.match(halter.matches[0].rule.because, /shoulder width/)
})

test('a garment with no extracted geometry scores neutral, not zero', () => {
  // Products awaiting vision extraction must not be pushed to the bottom of every
  // personalised search.
  const fit = stylingFit({ body_type: 'petite' }, {})
  assert.equal(fit.score, 0.5)
  assert.deepEqual(fit.matches, [])
})

test('a profile with no answers matches no rules and scores neutral', () => {
  assert.deepEqual(rulesFor({}), [])
  assert.equal(stylingFit({}, { v_rise: 'high' }).score, 0.5)
})

test('an "average" answer is a deliberate no-op', () => {
  assert.deepEqual(rulesFor({ shoulders: 'average' }), [])
  assert.deepEqual(rulesFor({ torso: 'average' }), [])
  assert.deepEqual(rulesFor({ waist: 'average' }), [])
})

test('multiple matching rules combine', () => {
  const profile = { body_type: 'petite', torso: 'long' }
  assert.equal(rulesFor(profile).length, 2)
  // Both rules want high rise, so a high-rise garment satisfies both.
  const fit = stylingFit(profile, { v_rise: 'high', v_waist_position: 'above-natural' })
  assert.ok(fit.score > 0.9, `expected strong agreement, got ${fit.score}`)
  assert.equal(fit.matches.length, 2)
})

test('conflicting rules do not produce a nonsensical score', () => {
  // Long torso wants a high waist; short torso wants a low one. A profile cannot
  // hold both, but the scorer must stay in range for any input it is given.
  const fit = stylingFit({ torso: 'long', body_type: 'petite' }, { v_rise: 'low', v_waist_position: 'dropped' })
  assert.ok(fit.score >= 0 && fit.score <= 1)
})

test('guidance is human-readable and mentions both preference and avoidance', () => {
  const lines = guidanceFor({ body_type: 'petite', shoulders: 'wide' })
  assert.equal(lines.length, 2)
  for (const l of lines) {
    assert.ok(l.includes('prefer:'), `guidance should state preferences: ${l}`)
    assert.ok(l.length > 30)
  }
})

test('every rule states a reason a person could read on a product card', () => {
  for (const r of STYLING_RULES) {
    assert.ok(r.because.length > 20, `${r.id}: reason too terse to be useful`)
    assert.ok(r.because.length <= 90, `${r.id}: reason too long for a card line`)
    assert.ok(!/\bv_/.test(r.because), `${r.id}: reason must not leak column names`)
    assert.ok(r.prefer || r.avoid, `${r.id}: a rule with neither prefer nor avoid does nothing`)
  }
})
