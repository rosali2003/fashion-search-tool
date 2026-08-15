import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMaterial } from './material.js'

/**
 * Every fixture below is a verbatim `material` value from
 * output/2026-06-28-legacy/*_products.json. Synthetic strings would not have
 * caught the cases these do.
 */

test('aritzia: percent-first with trailing ornamentation junk', () => {
  const r = parseMaterial('78% cotton, 22% polyester, exclusive of ornamentation')
  assert.deepEqual(r.fiberNames, ['cotton', 'polyester'])
  assert.equal(r.primaryFiber, 'cotton')
  assert.equal(r.naturalRatio, 0.78)
  assert.equal(r.incomplete, false)
  assert.equal(r.clean, '78% cotton, 22% polyester')
})

test('gap: spandex canonicalises to elastane', () => {
  const r = parseMaterial('95% Cotton, 5% Spandex')
  assert.deepEqual(r.fiberNames, ['cotton', 'elastane'])
  assert.equal(r.naturalRatio, 0.95)
  assert.equal(r.clean, '95% cotton, 5% elastane')
})

test('gap: truncated partial keeps the fibre but refuses to invent the rest', () => {
  const r = parseMaterial('1% Elastane')
  assert.deepEqual(r.fiberNames, ['elastane'])
  assert.equal(r.incomplete, true, 'sums to 1%, must be flagged')
  assert.equal(r.primaryFiber, null, 'elastane is not the primary fibre of anything')
  assert.equal(r.naturalRatio, null, 'unknowable from a 1% fragment')
})

test('uniqlo: trailing "Imported" is stripped', () => {
  const r = parseMaterial('96% Cotton, 4% Spandex Imported')
  assert.deepEqual(r.fiberNames, ['cotton', 'elastane'])
  assert.equal(r.naturalRatio, 0.96)
  assert.equal(r.incomplete, false)
})

test('uniqlo: multi-component monster uses shell only, and harvests colours', () => {
  const r = parseMaterial(
    '[00 WHITE] Shell: 96% Cotton, 4% Spandex/ Lining: 95% Cotton, 5% Spandex/ ' +
      'Binder-processed Part: 67% Cotton, 33% Polyester/ Cup ( Inner Lining ): 100% Polyester ' +
      '[Other Colors] Shell: 97% Cotton, 3% Spandex Imported',
  )
  // naturalRatio must come from the shell, not an average across components.
  assert.equal(r.naturalRatio, 0.96)
  assert.equal(r.primaryFiber, 'cotton')
  assert.ok(r.colors.includes('white'), 'colourway marker harvested')
  assert.ok(!r.colors.some((c) => /other/i.test(c)), '"[Other Colors]" is not a colour')
  const mainFibers = r.fibers.filter((f) => f.component === 'main').map((f) => f.fiber)
  assert.deepEqual(mainFibers, ['cotton', 'elastane'])
})

test('rihoas: percent AFTER the fibre name', () => {
  const r = parseMaterial('Polyester 65.0%, Nylon 35.0%')
  assert.deepEqual(r.fiberNames, ['polyester', 'nylon'])
  assert.equal(r.primaryFiber, 'polyester')
  assert.equal(r.naturalRatio, 0)
  assert.equal(r.incomplete, false)
})

test('rihoas: spandex(elastane) parenthetical form', () => {
  const r = parseMaterial('Polyester 95.0%, Spandex(Elastane) 5.0%')
  assert.deepEqual(r.fiberNames, ['polyester', 'elastane'])
  assert.equal(r.naturalRatio, 0)
})

test('rihoas: bare fibre implies 100%', () => {
  const r = parseMaterial('Polyester')
  assert.deepEqual(r.fiberNames, ['polyester'])
  assert.equal(r.fibers[0].pct, 100)
  assert.equal(r.naturalRatio, 0)
})

test('rihoas: bare 100% cotton is fully natural', () => {
  const r = parseMaterial('Cotton 100.0%')
  assert.equal(r.naturalRatio, 1)
  assert.equal(r.primaryFiber, 'cotton')
})

test('fabric is never mistaken for fibre', () => {
  for (const f of ['Chiffon', 'Knit', 'Worsted', 'Jacquard']) {
    const r = parseMaterial(f)
    assert.deepEqual(r.fiberNames, [], `${f} must not become a fibre`)
    assert.ok(r.fabric.length > 0, `${f} must be recorded as a fabric`)
  }
})

test('non-textile jewellery materials register as other, not as a natural fibre', () => {
  const r = parseMaterial('Titanium Steel')
  assert.ok(r.fiberNames.includes('other'))
  assert.equal(r.naturalRatio, null, 'natural ratio is meaningless for metal')
})

test('aritzia prose in the material field is detected, not parsed', () => {
  const r = parseMaterial(
    'This is a strapless babydoll dress with a smocked bodice and tie detail at the back ' +
      'that falls to a tiered mini skirt.',
  )
  assert.ok(r.prose, 'must be returned as prose for the caller to relocate')
  assert.deepEqual(r.fibers, [], 'must not invent fibres from a description')
  assert.equal(r.clean, null, 'must never render a paragraph as a badge')
})

test('recycled and organic qualifiers are flagged, not treated as separate fibres', () => {
  const r = parseMaterial('60% Organic Cotton, 40% Recycled Polyester')
  assert.deepEqual(r.fiberNames, ['cotton', 'polyester'])
  assert.equal(r.naturalRatio, 0.6)
  assert.equal(r.fibers.find((f) => f.fiber === 'cotton')?.organic, true)
  assert.equal(r.fibers.find((f) => f.fiber === 'polyester')?.recycled, true)
})

test('tencel and rayon canonicalise, and count as neither natural nor synthetic', () => {
  const r = parseMaterial('50% TENCEL™ Lyocell, 50% Rayon')
  assert.deepEqual(r.fiberNames, ['lyocell', 'viscose'])
  assert.equal(r.naturalRatio, 0, 'semi-synthetics do not count as natural')
})

test('the visocse typo present in the Gap data still parses', () => {
  const r = parseMaterial('70% Visocse, 30% Cotton')
  assert.ok(r.fiberNames.includes('viscose'))
  assert.ok(r.fiberNames.includes('cotton'))
})

test('polyamide canonicalises to nylon', () => {
  const r = parseMaterial('Polyamide 80.0%, Spandex 20.0%')
  assert.deepEqual(r.fiberNames, ['nylon', 'elastane'])
})

test('aritzia prose that names a fibre still yields the fibre, but not as the badge', () => {
  // Verbatim: aritzia | Mighty Cotton™ Surfside Short
  const r = parseMaterial(
    "These are low-rise micro shorts with a drawcord waist. They're made with Mighty Cotton™ " +
      '— heavyweight 100% cotton jersey with a soft-structured feel. Mighty comfortable.',
  )
  assert.ok(r.prose, 'the raw sentence must be flagged for relocation')
  assert.deepEqual(r.fiberNames, ['cotton'], 'the embedded 100% cotton is recoverable')
  assert.equal(r.naturalRatio, 1)
  assert.equal(r.clean, '100% cotton', 'badge is re-rendered short, never the paragraph')
})

test('uniqlo prose preamble before the fibre breakdown is skipped', () => {
  // Verbatim: uniqlo | AIRism Bra Camisole
  const r = parseMaterial(
    'This item ships with one of the below options. Note that you cannot specify a preference ' +
      'at this time. [00 WHITE] Shell: 67% Polyester, 24% Cupro, 9% Spandex ' +
      '( 45% Uses Recycled Polyester Fiber )/ Lining: 72% Nylon, 28% Spandex/ ' +
      'Cup ( Inner Lining ): 100% Polyester Shell: 71% Polyester, 19% Cupro, 10% Spandex',
  )
  assert.equal(r.prose, null, 'a structured breakdown is not prose, despite the preamble')
  const main = r.fibers.filter((f) => f.component === 'main')
  assert.deepEqual(
    main.map((f) => f.fiber),
    ['polyester', 'cupro', 'elastane'],
    'shell fibres, not the lining or cup',
  )
  assert.equal(r.primaryFiber, 'polyester')
  assert.equal(r.naturalRatio, 0)
  assert.equal(r.fibers.find((f) => f.fiber === 'polyester')?.recycled, true)
})

test('null and empty inputs are safe', () => {
  for (const v of [null, undefined, '', '   ']) {
    const r = parseMaterial(v as string | null)
    assert.deepEqual(r.fibers, [])
    assert.equal(r.clean, null)
    assert.equal(r.naturalRatio, null)
  }
})
