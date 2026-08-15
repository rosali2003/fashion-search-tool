import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toStrictSchema } from './strictSchema.js'

type Json = Record<string, any>

test('every object gains additionalProperties:false and a complete required list', () => {
  const out = toStrictSchema({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'integer' } },
    required: ['a'],
  }) as Json

  assert.equal(out.additionalProperties, false)
  assert.deepEqual(out.required.sort(), ['a', 'b'], 'strict mode requires every property')
})

test('an originally-optional field becomes a null union, not a dropped field', () => {
  // Strict mode has no "optional". The prompts rely on omission meaning "unsure",
  // so absence has to be encodable — as null.
  const out = toStrictSchema({
    type: 'object',
    properties: { needed: { type: 'string' }, maybe: { type: 'string' } },
    required: ['needed'],
  }) as Json

  assert.deepEqual(out.properties.needed.type, 'string', 'required fields keep a plain type')
  assert.deepEqual(out.properties.maybe.type, ['string', 'null'])
})

test('optional enums admit null, or the model cannot express "unsure"', () => {
  const out = toStrictSchema({
    type: 'object',
    properties: { neckline: { type: 'string', enum: ['crew', 'v-neck'] } },
  }) as Json

  const n = out.properties.neckline
  assert.deepEqual(n.type, ['string', 'null'])
  assert.ok(n.enum.includes(null), 'null must be a legal enum value under constrained decoding')
  assert.ok(n.enum.includes('crew'), 'real values survive')
})

test('arrays stay non-nullable — an empty array already means "none found"', () => {
  // Allowing both null and [] would give the model two encodings for one state,
  // and every sanitizer would have to handle both.
  const out = toStrictSchema({
    type: 'object',
    properties: { details: { type: 'array', items: { type: 'string', enum: ['slit'] } } },
  }) as Json

  assert.equal(out.properties.details.type, 'array')
  assert.ok(!Array.isArray(out.properties.details.type))
})

test('nested objects inside arrays are converted too', () => {
  // This is the extract.ts shape: { products: [ { index, category, ... } ] }.
  const out = toStrictSchema({
    type: 'object',
    properties: {
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: { index: { type: 'integer' }, category: { type: 'string', enum: ['top'] } },
          required: ['index'],
        },
      },
    },
    required: ['products'],
  }) as Json

  const item = out.properties.products.items
  assert.equal(item.additionalProperties, false)
  assert.deepEqual(item.required.sort(), ['category', 'index'])
  assert.deepEqual(item.properties.index.type, 'integer', 'index was required, stays plain')
  assert.deepEqual(item.properties.category.type, ['string', 'null'])
  assert.ok(item.properties.category.enum.includes(null))
})

test('a type that is already a null union is not double-wrapped', () => {
  // rerank.ts declares reason as ['string','null'] by hand.
  const out = toStrictSchema({
    type: 'object',
    properties: { reason: { type: ['string', 'null'], maxLength: 90 } },
  }) as Json

  assert.deepEqual(out.properties.reason.type, ['string', 'null'])
  assert.equal(out.properties.reason.maxLength, 90, 'unrelated keywords survive')
})

test('conversion does not mutate the input schema', () => {
  // The schemas are rebuilt per call, but a shared constant would be corrupted
  // for the Anthropic path if this mutated.
  const input = {
    type: 'object',
    properties: { a: { type: 'string', enum: ['x'] } },
  }
  const snapshot = JSON.stringify(input)
  toStrictSchema(input)
  assert.equal(JSON.stringify(input), snapshot)
})

test('the real vision schema survives conversion', () => {
  // Guards against a regression in the actual shape sent to OpenAI: every leaf
  // must be expressible, and nothing may be left un-required.
  const schema = {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['top', 'dress'] },
      colors: { type: 'array', items: { type: 'string', enum: ['black'] } },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  }
  const out = toStrictSchema(schema) as Json

  assert.deepEqual(out.required.sort(), ['category', 'colors', 'confidence'])
  assert.equal(out.additionalProperties, false)
  assert.deepEqual(out.properties.confidence.type, ['number', 'null'])
  assert.equal(out.properties.colors.type, 'array')
})
