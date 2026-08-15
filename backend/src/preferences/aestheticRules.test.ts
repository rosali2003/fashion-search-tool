import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AESTHETIC_RULES, aestheticFit, aestheticReason, aestheticGuidance } from './aestheticRules.js'
import {
  AESTHETICS, SILHOUETTE_PREFS, MATERIAL_PREFS,
  SILHOUETTE_TO_CATALOG, MATERIAL_TO_CATALOG, seedPreferenceDict, QUESTIONNAIRE_PRIOR,
} from './options.js'
import { SILHOUETTE, PATTERN, DETAILS, FIBER, NECKLINE } from '../normalize/vocab.js'

test('every Q5 aesthetic is reachable by exactly one rule', () => {
  // Same guarantee stylingRules.test.ts makes for the body questions: an answer
  // no rule fires for is a question the user answers to no effect.
  for (const cluster of AESTHETICS) {
    const matching = AESTHETIC_RULES.filter((r) => r.cluster === cluster)
    assert.equal(matching.length, 1, `"${cluster}" should have exactly one rule, got ${matching.length}`)
  }
  for (const rule of AESTHETIC_RULES) {
    assert.ok(
      (AESTHETICS as readonly string[]).includes(rule.cluster),
      `rule "${rule.cluster}" fires for no questionnaire answer`,
    )
  }
})

test('every value the aesthetic rules key on exists in the controlled vocabulary', () => {
  // This is the test that catches the mistake actually made while writing this
  // file: "collared" was listed under `details`, where it can never match,
  // because it is a NECKLINE value. A typo or a drifted vocabulary produces a
  // rule that silently never fires, which is indistinguishable from the feature
  // working until someone measures it.
  const vocab: Record<string, readonly string[]> = {
    pattern: PATTERN,
    silhouette: SILHOUETTE,
    details: DETAILS,
    primary_fiber: FIBER,
    neckline: NECKLINE,
  }

  for (const rule of AESTHETIC_RULES) {
    for (const group of [rule.prefer ?? {}, rule.avoid ?? {}]) {
      for (const [key, values] of Object.entries(group)) {
        const allowed = vocab[key]
        assert.ok(allowed, `rule "${rule.cluster}" keys on unknown signal "${key}"`)
        for (const v of values as string[]) {
          assert.ok(
            allowed.includes(v),
            `rule "${rule.cluster}" expects ${key}="${v}", which is not in the ${key} vocabulary`,
          )
        }
      }
    }
  }
})

test('a garment with no pattern, silhouette or details scores neutral, not zero', () => {
  // Measured: pattern is null on 181 of 355 active products and silhouette on
  // 200. Scoring silence as disapproval would sort the entire un-normalised tail
  // to the bottom of every personalised search.
  const { score, match } = aestheticFit('minimal', {})
  assert.equal(score, 0.5)
  assert.equal(match, null)
})

test('an unanswered Q5 scores every garment neutral', () => {
  const loud = aestheticFit(null, { pattern: 'floral', details: ['sequins', 'ruffle'] })
  const plain = aestheticFit(null, { pattern: 'solid', silhouette: 'slim' })
  assert.equal(loud.score, 0.5)
  assert.equal(plain.score, 0.5)
})

test('minimal prefers a plain solid over an embellished floral', () => {
  const plain = aestheticFit('minimal', { pattern: 'solid', silhouette: 'slim' })
  const loud = aestheticFit('minimal', { pattern: 'floral', details: ['sequins', 'ruffle'] })

  assert.ok(plain.score > loud.score, `${plain.score} should beat ${loud.score}`)
  assert.ok(plain.score > 0.5, 'a garment expressing the aesthetic scores above neutral')
  assert.ok(loud.score < 0.5, 'a garment fighting it scores below neutral')
})

test('eclectic inverts that ordering on the same two garments', () => {
  // The rules must genuinely discriminate between clusters. If every aesthetic
  // liked the same garments the question would be decorative.
  const plain = aestheticFit('eclectic', { pattern: 'solid', silhouette: 'slim' })
  const loud = aestheticFit('eclectic', { pattern: 'floral', details: ['sequins', 'ruffle'] })
  assert.ok(loud.score > plain.score, `${loud.score} should beat ${plain.score}`)
})

test('classic keys on shirting details and a natural fibre', () => {
  const shirt = aestheticFit('classic', {
    pattern: 'striped', neckline: 'collared',
    details: ['button-front', 'pockets'], primary_fiber: 'cotton',
  })
  assert.ok(shirt.score > 0.5)
  assert.match(aestheticReason(shirt.match) ?? '', /shirting/)
})

test('the reason is withheld from a garment that fights the aesthetic', () => {
  // A negative match must not produce a line claiming the garment suits them.
  const loud = aestheticFit('minimal', { pattern: 'floral', details: ['sequins'] })
  assert.ok(loud.score < 0.5)
  assert.equal(aestheticReason(loud.match), null)
})

test('rerank guidance is emitted per cluster and empty when Q5 is skipped', () => {
  assert.equal(aestheticGuidance(null).length, 0)
  for (const cluster of AESTHETICS) {
    const lines = aestheticGuidance(cluster)
    assert.equal(lines.length, 1)
    assert.match(lines[0], new RegExp(cluster))
  }
})

test('Q1 and Q2 answers map onto values that exist in the catalog vocabulary', () => {
  // dictFit looks up the raw catalog column, so a mapping targeting a value the
  // normaliser can never emit is a dead question with a working-looking UI.
  for (const answer of SILHOUETTE_PREFS) {
    const targets = Object.keys(SILHOUETTE_TO_CATALOG[answer] ?? {})
    assert.ok(targets.length > 0, `Q1 "${answer}" maps to nothing`)
    for (const t of targets) {
      assert.ok(SILHOUETTE.includes(t as never), `Q1 "${answer}" maps to unknown silhouette "${t}"`)
    }
  }
  for (const answer of MATERIAL_PREFS) {
    const targets = Object.keys(MATERIAL_TO_CATALOG[answer] ?? {})
    assert.ok(targets.length > 0, `Q2 "${answer}" maps to nothing`)
    for (const t of targets) {
      assert.ok(FIBER.includes(t as never), `Q2 "${answer}" maps to unknown fibre "${t}"`)
    }
  }
})

test('seeding takes the maximum across overlapping answers, never the sum', () => {
  // 'relaxed' and 'oversized' both list boxy. Summing would push it above the
  // prior ceiling and let an incidental overlap outrank a directly-chosen value.
  const seeded = seedPreferenceDict(['relaxed', 'oversized'], SILHOUETTE_TO_CATALOG)

  for (const [value, score] of Object.entries(seeded)) {
    assert.ok(score <= QUESTIONNAIRE_PRIOR, `${value} seeded at ${score}, above the prior ceiling`)
  }
  // oversized lists boxy at 0.85, relaxed at 0.75 — the stronger claim wins.
  assert.equal(seeded.boxy, QUESTIONNAIRE_PRIOR * 0.85)
  assert.equal(seeded.oversized, QUESTIONNAIRE_PRIOR)
})

test('seeding an empty questionnaire yields an empty dictionary', () => {
  // An empty dict is what dictFit reads as "no preference", scoring neutral.
  // Anything else would make skipping the question a preference of its own.
  assert.deepEqual(seedPreferenceDict([], SILHOUETTE_TO_CATALOG), {})
  assert.deepEqual(seedPreferenceDict(['nonsense'], SILHOUETTE_TO_CATALOG), {})
})
