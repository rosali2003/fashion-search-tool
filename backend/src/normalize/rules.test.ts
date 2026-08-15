import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRules } from './rules.js'
import { w, wp } from './patterns.js'

/**
 * The first two groups are regression tests for bugs that reached the database.
 * Both were invisible in unit terms and only showed up when the ingested facets
 * were read back, which is why they are pinned here explicitly.
 */

test('regression: alternation must not leak past a word boundary', () => {
  // `/\bmini|micro\b/` parses as `(\bmini)|(micro\b)`, so "minimalist" matched
  // and gauze pants were labelled length=mini.
  assert.equal(w('mini', 'micro').test('minimalist'), false)
  assert.equal(w('mini', 'micro').test('mini'), true)
  // Same defect made `/\bred|crimson\b/` match "reduced".
  assert.equal(w('red', 'crimson', 'scarlet').test('reduced'), false)
  assert.equal(w('red', 'crimson', 'scarlet').test('red dress'), true)
})

test('regression: plural garment nouns must match', () => {
  // `\bshort\b` cannot match "Shorts" — the boundary is occupied by the s — so
  // '3" Low Rise Denim Shorts' fell through to the accessory rule.
  for (const [singular, plural] of [
    ['short', 'shorts'], ['pant', 'pants'], ['legging', 'leggings'],
    ['jogger', 'joggers'], ['pocket', 'pockets'], ['jean', 'jeans'],
  ]) {
    assert.equal(wp(singular).test(plural), true, `wp('${singular}') must match "${plural}"`)
    assert.equal(wp(singular).test(singular), true, `wp('${singular}') must match "${singular}"`)
  }
})

test('denim shorts classify as a bottom, not an accessory', () => {
  const r = applyRules('3" Low Rise Denim Shorts', null)
  assert.equal(r.category, 'bottom')
  assert.equal(r.subcategory, 'shorts')
  assert.equal(r.rise, 'low-rise')
  assert.deepEqual(r.colors, ['denim'])
})

test('gauze pants are not mini-length', () => {
  const r = applyRules(
    'Cotton Gauze Easy Split-Hem Pants',
    'A minimalist silhouette with a relaxed drape and a split hem.',
  )
  assert.equal(r.category, 'bottom')
  assert.equal(r.subcategory, 'trousers')
  assert.equal(r.length, null, '"minimalist" must not read as "mini"')
  assert.ok(r.details.includes('slit'))
})

test('most specific garment rule wins', () => {
  assert.equal(applyRules('Racer Back Bra Top', null).subcategory, 'bra-top')
  assert.equal(applyRules('String Bikini Top', null).subcategory, 'bikini-top')
  assert.equal(applyRules('Sweetheart Neck Mini Dress', null).subcategory, 'mini-dress')
  assert.equal(applyRules('Linen-Blend Embroidered Cami Maxi Dress', null).subcategory, 'maxi-dress')
  assert.equal(applyRules('100% Cotton Pocket Sweater Vest', null).subcategory, 'vest')
  assert.equal(applyRules('Oversized Icon Denim Jacket', null).subcategory, 'jacket')
})

test('a bare vest is outerwear but a sweater vest is knitwear', () => {
  assert.equal(applyRules('100% Cotton Pocket Sweater Vest', null).category, 'knitwear')
  assert.equal(applyRules('Quilted Puffer Vest', null).category, 'outerwear')
})

test('necklines are read off the name', () => {
  const cases: [string, string][] = [
    ['HEATTECH Ultra Warm High Neck T-Shirt', 'mock-neck'],
    ['Off White Turtle Tie Regular Sleeve Shirt', 'turtleneck'],
    ['Purple Mandarin Collar Slit Mermaid Dress', 'mandarin-collar'],
    ['Apricot Sweetheart Neck Floral Lace Mini Dress', 'sweetheart'],
    ['Black Square Neck Sleeveless Button Midi Dress', 'square'],
    ['CloseKnit Jersey Boatneck Crop Tank Top', 'boat'],
    ['Original Contour Waver Dress', 'crew'],
  ]
  for (const [name, expected] of cases) {
    const got = applyRules(name, null).neckline
    if (expected === 'crew') continue // no neckline token in that name; covered below
    assert.equal(got, expected, `${name} -> ${expected}, got ${got}`)
  }
})

test('a name with no neckline token yields null rather than a guess', () => {
  assert.equal(applyRules('Original Contour Waver Dress', null).neckline, null)
})

test('the canary target is classified correctly', () => {
  // The product the canary query must surface.
  const r = applyRules('Off White Turtle Tie Regular Sleeve Shirt', null)
  assert.equal(r.category, 'top')
  assert.equal(r.subcategory, 'shirt')
  assert.equal(r.neckline, 'turtleneck', 'turtle = the "high collar" the query asks for')
  assert.ok(r.colors.includes('off-white'))
  assert.ok(r.details.includes('self-tie'), 'the "one tie" in the query')
})

test('colours come from the name only, never the description', () => {
  // Brand copy routinely names colours the garment is not.
  const r = applyRules('Linen Shirt', 'A crisp white linen shirt that pairs well with black denim.')
  assert.deepEqual(r.colors, [], 'description colours must not become facets')
})

test('rise is extracted from both hyphenated and spaced forms', () => {
  assert.equal(applyRules("The '90s Vintage Hi-Rise Baggy Denim Short", null).rise, 'high-rise')
  assert.equal(applyRules('High Rise Stride Wide-Leg Ankle Jeans', null).rise, 'high-rise')
  assert.equal(applyRules('Cozy Sweatfleece Boyfriend Lo-Rise Mini Short', null).rise, 'low-rise')
  assert.equal(applyRules('Mid Rise Longline Denim Shorts', null).rise, 'mid-rise')
})
