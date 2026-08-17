import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTypeGate } from './typeGate.js'
import { OFF_TYPE_FLOOR } from './config.js'
import type { Candidate } from './repository.js'

/** Only the three fields the gate reads are meaningful; the rest are ballast. */
function candidate(
  id: number,
  category: string | null,
  subcategory: string | null,
): Candidate {
  return {
    id, brand: 'test', name: `p${id}`, name_variant: null, price_cents: null,
    material_clean: null, primary_fiber: null, natural_ratio: null,
    category, subcategory,
    silhouette: null, neckline: null, sleeve_length: null, length: null,
    rise: null, fit: null, pattern: null, colors: [], details: [], occasion: [],
    v_rise: null, v_waist_position: null, v_hem_break: null,
    v_shoulder_treatment: null, v_neckline_width: null, v_volume: null,
    v_vertical_line: null, v_waist_definition: null, v_drape: null,
    v_structure: null,
    product_url: `https://example.com/${id}`, image_hashes: [],
    description_clean: null, size_range: [], bm25_score: 100 - id,
  }
}

/** Enough on-type candidates to clear OFF_TYPE_FLOOR. */
const manyJeans = (n = OFF_TYPE_FLOOR) =>
  Array.from({ length: n }, (_, i) => candidate(i, 'bottom', 'jeans'))

const JEANS_INTENT = { category: 'bottom', subcategory: 'jeans' }
const JEANS_QUERY = 'high rise wide leg jeans'

  test('applyTypeGate: does nothing when the expansion named no type', () => {
    const cands = [candidate(1, 'swimwear', 'bikini-bottom'), candidate(2, 'bottom', 'jeans')]
    const r = applyTypeGate(cands, {}, JEANS_QUERY)
    assert.equal(r.applied, false)
    assert.deepEqual(r.kept, cands)
  })

  test('applyTypeGate: drops the off-category candidate that motivated this module', () => {
    // The reported bug: "high rise wide leg jeans" returning a high-rise bikini.
    const bikini = candidate(999, 'swimwear', 'bikini-bottom')
    const r = applyTypeGate([...manyJeans(), bikini], JEANS_INTENT, JEANS_QUERY)
    assert.equal(r.applied, true)
    assert.equal(r.dropped, 1)
    assert.ok(!(r.kept).includes(bikini))
  })

  test('applyTypeGate: keeps same-category neighbours', () => {
    // Trousers are a defensible answer to a jeans query; bikinis are not.
    const trousers = candidate(500, 'bottom', 'trousers')
    const r = applyTypeGate([trousers, ...manyJeans()], JEANS_INTENT, JEANS_QUERY)
    assert.ok((r.kept).includes(trousers))
  })

  test('applyTypeGate: never reorders the candidates it keeps', () => {
    // Ranking belongs to BM25 and the reranker. An earlier version hoisted exact
    // subcategory matches and took "beach vacation dress" from nDCG 0.82 to 0.04.
    const trousers = candidate(500, 'bottom', 'trousers')
    const bikini = candidate(999, 'swimwear', 'bikini-bottom')
    const input = [trousers, ...manyJeans(), bikini]
    const r = applyTypeGate(input, JEANS_INTENT, JEANS_QUERY)
    assert.deepEqual(
      r.kept.map((c) => c.id),
      input.filter((c) => c !== bikini).map((c) => c.id),
    )
    assert.equal(r.kept[0], trousers)
  })

  test('applyTypeGate: declines to fire on a garment type the shopper never typed', () => {
    // "something cozy for the weekend" expands to top/hoodie — a fair guess and
    // a ruinous filter, since cozy legitimately includes joggers.
    const tops = Array.from({ length: OFF_TYPE_FLOOR }, (_, i) => candidate(i, 'top', 'hoodie'))
    const joggers = candidate(900, 'bottom', 'joggers')
    const r = applyTypeGate(
      [...tops, joggers],
      { category: 'top', subcategory: 'hoodie' },
      'something cozy for the weekend',
    )
    assert.equal(r.applied, false)
    assert.ok((r.kept).includes(joggers))
  })

  test('applyTypeGate: fires when only the category is named, not the subcategory', () => {
    const dresses = Array.from({ length: OFF_TYPE_FLOOR }, (_, i) =>
      candidate(i, 'dress', 'midi-dress'),
    )
    const top = candidate(900, 'top', 'blouse')
    // The expander guesses maxi-dress; the shopper only wrote "dress".
    const r = applyTypeGate(
      [...dresses, top],
      { category: 'dress', subcategory: 'maxi-dress' },
      'beach vacation dress',
    )
    assert.equal(r.applied, true)
    assert.ok(!(r.kept).includes(top))
    // The guessed subcategory must not evict the midis that share its category.
    assert.equal((r.kept).length, OFF_TYPE_FLOOR)
  })

  test('applyTypeGate: matches type words on whole words only', () => {
    const shorts = Array.from({ length: OFF_TYPE_FLOOR }, (_, i) =>
      candidate(i, 'bottom', 'shorts'),
    )
    const top = candidate(900, 'top', 'blouse')
    // "short sleeve" must not grounded-match the subcategory "shorts".
    const r = applyTypeGate(
      [...shorts, top],
      { category: 'bottom', subcategory: 'shorts' },
      'short sleeve blouse',
    )
    assert.equal(r.applied, false)
  })

  test('applyTypeGate: recognises singular and informal forms of a type word', () => {
    const jeans = manyJeans()
    const bikini = candidate(999, 'swimwear', 'bikini-bottom')
    // Brands name garments in the singular; shoppers type either.
    for (const q of ['the ultimate wide-leg jean', 'high waisted denim']) {
      const r = applyTypeGate([...jeans, bikini], JEANS_INTENT, q)
      assert.equal(r.applied, true, q)
      assert.ok(!r.kept.includes(bikini), q)
    }
  })

  test('applyTypeGate: fails open when too few eligible candidates survive', () => {
    // Guards one scenario only: category extraction having broken corpus-wide.
    const offType = Array.from({ length: 40 }, (_, i) => candidate(i, 'top', 't-shirt'))
    const r = applyTypeGate([...offType, candidate(99, 'bottom', 'jeans')], JEANS_INTENT, JEANS_QUERY)
    assert.equal(r.applied, false)
    assert.equal(r.dropped, 0)
    assert.equal((r.kept).length, 41)
  })

  test('applyTypeGate: gates down to a short page rather than padding with the wrong garment', () => {
    // A catalog that holds six jackets should answer "biker jacket" with six
    // jackets. Padding to a full page with jeans is the reported defect.
    const jackets = Array.from({ length: 6 }, (_, i) => candidate(i, 'outerwear', 'jacket'))
    const jeans = Array.from({ length: 60 }, (_, i) => candidate(100 + i, 'bottom', 'jeans'))
    const r = applyTypeGate(
      [...jackets, ...jeans],
      { category: 'outerwear', subcategory: 'jacket' },
      'black leather biker jacket',
    )
    assert.equal(r.applied, true)
    assert.equal((r.kept).length, 6)
    assert.equal(r.dropped, 60)
  })

  test('applyTypeGate: treats unenriched candidates as eligible rather than off-type', () => {
    // A null category is missing extraction, not evidence of a wrong garment.
    const unknown = candidate(777, null, null)
    const r = applyTypeGate([...manyJeans(), unknown], JEANS_INTENT, JEANS_QUERY)
    assert.ok((r.kept).includes(unknown))
    assert.equal(r.dropped, 0)
  })

  test('applyTypeGate: keeps a subcategory match whose category disagrees with the expansion', () => {
    // Corpus and expander can disagree on where a garment sits — a sweater is
    // 'knitwear' to one and 'top' to the other. The exact subcategory hit is the
    // stronger signal and must survive the weaker one.
    const sweater = candidate(42, 'top', 'sweater')
    const knits = Array.from({ length: OFF_TYPE_FLOOR }, (_, i) =>
      candidate(i, 'knitwear', 'sweater'),
    )
    const r = applyTypeGate(
      [sweater, ...knits],
      { category: 'knitwear', subcategory: 'sweater' },
      '100% cashmere sweater',
    )
    assert.equal(r.applied, true)
    assert.ok((r.kept).includes(sweater))
  })
