import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSize, normalizeSizes, parseHeightCm } from './types.js'

test('model height parses the forms retail copy actually uses', () => {
  // Aritzia and Uniqlo both publish model height, in different formats and with
  // several different apostrophe characters.
  assert.equal(parseHeightCm("5'9\""), 175)
  assert.equal(parseHeightCm('5’9”'), 175)
  assert.equal(parseHeightCm("Model is 5'10\" and wears a size XS"), 178)
  assert.equal(parseHeightCm('Height:5\'8"/173cm'), 173, 'metric wins when both are present')
  assert.equal(parseHeightCm('175cm'), 175)
  assert.equal(parseHeightCm('175 cm'), 175)
  assert.equal(parseHeightCm("6'"), 183, 'feet with no inches')
})

test('implausible heights are rejected rather than stored', () => {
  for (const bad of [null, undefined, '', 'no height here', "12'4\"", '999cm', '40cm']) {
    assert.equal(parseHeightCm(bad as string | null), null, `${bad} must not parse`)
  }
})

test('size labels normalise, and non-sizes are rejected', () => {
  assert.equal(normalizeSize('xs'), 'XS')
  assert.equal(normalizeSize(' Large '), null, 'spelled-out sizes are not in the vocabulary')
  assert.equal(normalizeSize('XXL'), 'XXL')
  assert.equal(normalizeSize('2xl'), '2XL')
  assert.equal(normalizeSize('28'), '28')
  assert.equal(normalizeSize('28x32'), '28X32')
  assert.equal(normalizeSize('one size'), 'ONE SIZE')

  // These are the failure mode worth guarding: colour codes and SKUs sit right
  // next to sizes in the same API payloads.
  assert.equal(normalizeSize('00 WHITE'), null)
  assert.equal(normalizeSize('E465760-000'), null)
  assert.equal(normalizeSize('COL09'), null)
  assert.equal(normalizeSize(''), null)
})

test('size lists de-duplicate and drop unparseable entries', () => {
  assert.deepEqual(
    normalizeSizes(['XS', 'xs', 'S', null, '00 WHITE', 'M', undefined, 'M']),
    ['XS', 'S', 'M'],
  )
  assert.deepEqual(normalizeSizes([]), [])
  assert.deepEqual(normalizeSizes([null, 'garbage']), [])
})
