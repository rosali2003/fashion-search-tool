import { callTool, type Usage } from './client.js'
import { modelForStage } from './models.js'
import {
  CATEGORY, SUBCATEGORY, SILHOUETTE, NECKLINE, SLEEVE_LENGTH, LENGTH, RISE, FIT,
  PATTERN, DETAILS, OCCASION, SEASON, COLORS, coerce, coerceMany,
} from '../normalize/vocab.js'

/**
 * Text attribute extraction.
 *
 * Only fills what the deterministic rules could not reach, which keeps the paid
 * path small: the rules already cover 99.7% of category and 98.7% of fibre
 * content, and Rihoas publishes its attributes outright so its 100 products need
 * no model at all. What remains is mostly Aritzia, whose product names are brand
 * poetry ("Altar Bustier - Crepette™") and whose descriptions are prose.
 *
 * Bump when the prompt or schema changes; rows below the current version are
 * re-extracted on the next ingest.
 */
export const EXTRACTION_VERSION = 1

const SYSTEM = `You extract structured garment attributes from fashion product copy.

Rules that matter more than completeness:
- Only state an attribute you can actually see evidence for in the text. Omit anything you would be guessing at. A missing attribute is fine; a wrong one is not, because these values are used to filter and rank.
- Never infer fibre content. It is parsed from the material field separately and your guess would override real data.
- Do not repeat the garment category in the details list.
- "details" means construction and trim: fastenings, cut-outs, ruching, pockets. Not fabric, not colour.
- Colour must be the colour of the garment itself, not a colour the copy suggests pairing it with.`

function schema(): Record<string, unknown> {
  const one = (values: readonly string[]) => ({ type: 'string', enum: [...values] })
  const many = (values: readonly string[]) => ({
    type: 'array', items: { type: 'string', enum: [...values] },
  })
  return {
    type: 'object',
    properties: {
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            category: one(CATEGORY),
            subcategory: one(SUBCATEGORY),
            silhouette: one(SILHOUETTE),
            neckline: one(NECKLINE),
            sleeve_length: one(SLEEVE_LENGTH),
            length: one(LENGTH),
            rise: one(RISE),
            fit: one(FIT),
            pattern: one(PATTERN),
            details: many(DETAILS),
            occasion: many(OCCASION),
            season: many(SEASON),
            colors: many(COLORS),
          },
          required: ['index'],
        },
      },
    },
    required: ['products'],
  }
}

export interface ExtractionInput {
  index: number
  brand: string
  name: string
  description: string | null
  materialClean: string | null
  /** Facets the rules already resolved — the model is asked only for the gaps. */
  known: Record<string, string | string[] | null>
}

export interface ExtractedAttributes {
  index: number
  category: string | null
  subcategory: string | null
  silhouette: string | null
  neckline: string | null
  sleeve_length: string | null
  length: string | null
  rise: string | null
  fit: string | null
  pattern: string | null
  details: string[]
  occasion: string[]
  season: string[]
  colors: string[]
}

/**
 * Coerce every value against the controlled vocabulary.
 *
 * Out-of-vocabulary values are dropped and counted rather than stored. A facet
 * column holding free text silently breaks the styling rules (which compare
 * against exact values) and the eval's coverage assertions, so the failure has to
 * be visible at extraction time.
 */
export function sanitizeExtraction(raw: unknown): { items: ExtractedAttributes[]; dropped: number } {
  const container = raw as { products?: unknown }
  if (!Array.isArray(container.products)) return { items: [], dropped: 0 }

  let dropped = 0
  const items: ExtractedAttributes[] = []

  for (const entry of container.products) {
    if (typeof entry !== 'object' || entry === null) continue
    const r = entry as Record<string, unknown>
    if (typeof r.index !== 'number') continue

    const single = (field: Parameters<typeof coerce>[0]) => {
      const v = coerce(field, r[field])
      if (r[field] != null && v === null) dropped++
      return v
    }
    const multi = (field: Parameters<typeof coerceMany>[0]) => {
      const v = coerceMany(field, r[field])
      if (Array.isArray(r[field])) {
        const seen = new Set(v)
        dropped += (r[field] as unknown[]).filter(
          (x) => typeof x !== 'string' || !seen.has(x.trim().toLowerCase().replace(/[\s_]+/g, '-')),
        ).length
      }
      return v
    }

    items.push({
      index: Math.trunc(r.index),
      category: single('category'),
      subcategory: single('subcategory'),
      silhouette: single('silhouette'),
      neckline: single('neckline'),
      sleeve_length: single('sleeve_length'),
      length: single('length'),
      rise: single('rise'),
      fit: single('fit'),
      pattern: single('pattern'),
      details: multi('details'),
      occasion: multi('occasion'),
      season: multi('season'),
      colors: multi('colors'),
    })
  }

  return { items, dropped }
}

function render(p: ExtractionInput): string {
  const known = Object.entries(p.known)
    .filter(([, v]) => v != null && (!Array.isArray(v) || v.length > 0))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`)
    .join(' ')

  return [
    `[${p.index}] ${p.brand} · ${p.name}`,
    p.materialClean ? `    material: ${p.materialClean}` : '',
    known ? `    already known (do not contradict): ${known}` : '',
    p.description ? `    text: ${p.description.slice(0, 700)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Extract for a batch of products.
 *
 * Batched because per-product calls would spend most of their tokens re-sending
 * the same system prompt and schema. Eight is a balance between that overhead and
 * the risk of one malformed row costing the whole batch.
 */
export async function extractBatch(
  inputs: ExtractionInput[],
): Promise<{ items: ExtractedAttributes[]; usage: Usage; dropped: number }> {
  if (inputs.length === 0) {
    return { items: [], usage: { inputTokens: 0, outputTokens: 0, calls: 0 }, dropped: 0 }
  }

  const { result, usage } = await callTool<unknown>({
    system: SYSTEM,
    text: `Extract attributes for each product. Return one entry per index.\n\n${inputs
      .map(render)
      .join('\n\n')}`,
    toolName: 'extract_attributes',
    toolDescription: 'Return structured garment attributes for each product.',
    schema: schema(),
    maxTokens: 6000,
    retries: 5,
    model: modelForStage('extract'),
  })

  const { items, dropped } = sanitizeExtraction(result)
  return { items, usage, dropped }
}
