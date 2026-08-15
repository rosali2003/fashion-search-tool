import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeRerank } from './rerank.js'

const one = (reason: unknown) => sanitizeRerank({ results: [{ index: 0, reason }] }, 5)[0]

test('a trailing literal "null" written into the reason string is stripped', () => {
  // Observed against a live catalog on gpt-5-nano. The prompt asks it to return
  // null when it cannot name an attribute; under constrained decoding it wrote
  // the word into the already-open string instead of closing it.
  assert.equal(
    one('100% cotton T-shirt — not a button shirt, null').reason,
    '100% cotton T-shirt — not a button shirt',
  )
  assert.equal(one('spread collar; button-front null').reason, 'spread collar; button-front')
  assert.equal(one('linen blend, NULL.').reason, 'linen blend')
})

test('the word "null" is left alone anywhere but the end', () => {
  // Guards against an over-eager regex eating real copy.
  const r = one('null print on a cotton poplin shirt')
  assert.equal(r.reason, 'null print on a cotton poplin shirt')
})

test('a reason that is nothing but "null" collapses to no reason at all', () => {
  // Stripping leaves an empty string, which the generic-reason filter then drops.
  // An empty string would render as a blank annotation line and look like a bug.
  assert.equal(one('null').reason, null)
})

test('a genuine null reason stays null', () => {
  assert.equal(one(null).reason, null)
  assert.equal(one(undefined).reason, null)
  assert.equal(one(42).reason, null)
})

test('generic reasons are still dropped', () => {
  assert.equal(one('great match').reason, null)
  assert.equal(one('perfect for you').reason, null)
  assert.equal(one('short').reason, null)
})

test('long reasons are truncated to the 90-character contract', () => {
  const r = one('x'.repeat(200))
  assert.ok(r.reason !== null && r.reason.length <= 90)
})

test('out-of-range and duplicate indices are discarded', () => {
  const out = sanitizeRerank(
    { results: [{ index: 0, reason: null }, { index: 0, reason: null }, { index: 99, reason: null }, { index: -1, reason: null }] },
    5,
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].index, 0)
})
