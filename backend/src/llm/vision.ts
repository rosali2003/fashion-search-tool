import { readFileSync } from 'node:fs'
import path from 'node:path'
import { callTool, type ImageInput, type Usage } from './client.js'
import { modelForStage } from './models.js'
import { resolveStored } from '../ingest/images.js'
import {
  V_RISE, V_WAIST_POSITION, V_HEM_BREAK, V_SHOULDER_TREATMENT, V_NECKLINE_WIDTH,
  V_VOLUME, V_VERTICAL_LINE, V_WAIST_DEFINITION, V_DRAPE, V_STRUCTURE, V_FINISH_CUES,
  CATEGORY, SILHOUETTE, NECKLINE, SLEEVE_LENGTH, LENGTH, PATTERN, COLORS, DETAILS,
  coerce, coerceMany,
} from '../normalize/vocab.js'

/**
 * Vision feature extraction.
 *
 * ONE CALL PER PRODUCT, with every image attached — not one call per image. The
 * corpus has 1,831 images across 298 products, so per-image calls would be 1,831
 * requests a day against a catalog whose photographs essentially never change.
 * Batching by product is also better extraction: back-only attributes (tie-back,
 * open-back, corset-back) are invisible in the primary shot and only become
 * extractable when the model sees the gallery together.
 *
 * Bump to force re-extraction after a prompt change. The ingest report prints the
 * projected cost before spending it.
 */
export const VISION_VERSION = 1

/** Images sent per product. Beyond this the marginal shot is a fabric close-up. */
export const MAX_IMAGES_PER_PRODUCT = 8

/**
 * The prompt's two hard constraints, both learned from the actual photography.
 *
 * 1. Primary garment only. Rihoas shoots styled lifestyle scenes — its model
 *    carries a handbag, wears sandals, and stands in a furnished room — so a naive
 *    prompt returns "handbag" and "sandals" as garment details. Aritzia by
 *    contrast shoots clean studio on seamless neutral.
 *
 * 2. Describe geometry, do not judge bodies. The model reports where the waist
 *    sits and where the hem breaks; whether that flatters anyone is decided by
 *    reviewable rules in preferences/stylingRules.ts. Putting that judgment in
 *    here would make it unauditable and would bake in assumptions nobody reviewed.
 */
const SYSTEM = `You describe the geometry of a single garment from product photographs.

You will see several images of ONE product, plus its name. Describe only that garment.

Ignore completely:
- accessories the model is wearing or holding (bags, shoes, jewellery, sunglasses, belts that are not part of the garment)
- other garments worn alongside it (if the product is a top, say nothing about the skirt)
- the background, furniture, props, and location
- the model's body, face, or appearance

Report only what you can see. Omit any field you are unsure of — a missing value is fine, a guessed one corrupts ranking.

Describe geometry objectively: where the waistline sits, where the hem falls on the leg, how the shoulder is constructed, how the fabric hangs. Do NOT comment on whether the garment suits or flatters any body type; that judgment is made elsewhere.

Use the later images for back and detail views: ties at the back, open backs, and corset lacing are usually invisible in the first image.`

function schema(): Record<string, unknown> {
  const one = (values: readonly string[], description?: string) => ({
    type: 'string', enum: [...values], ...(description ? { description } : {}),
  })
  const many = (values: readonly string[]) => ({
    type: 'array', items: { type: 'string', enum: [...values] },
  })
  return {
    type: 'object',
    properties: {
      // Facets vision reads better than brand copy does.
      category: one(CATEGORY),
      silhouette: one(SILHOUETTE),
      neckline: one(NECKLINE),
      sleeve_length: one(SLEEVE_LENGTH),
      length: one(LENGTH),
      pattern: one(PATTERN),
      colors: many(COLORS),
      details: many(DETAILS),

      // Geometry with no text equivalent anywhere in the corpus. These exist so
      // the styling rules have something objective to key on.
      v_rise: one(V_RISE, 'Where the waistband sits. Bottoms only.'),
      v_waist_position: one(V_WAIST_POSITION, 'Where the garment’s waistline sits relative to the natural waist.'),
      v_hem_break: one(V_HEM_BREAK, 'Where the hem falls on the leg.'),
      v_shoulder_treatment: one(V_SHOULDER_TREATMENT, 'How the shoulder or strap is constructed.'),
      v_neckline_width: one(V_NECKLINE_WIDTH, 'How wide the neckline sits across the collarbone.'),
      v_volume: one(V_VOLUME, 'How close the garment sits to the body.'),
      v_vertical_line: one(V_VERTICAL_LINE, 'Whether colour and seaming form one unbroken vertical line.'),
      v_waist_definition: one(V_WAIST_DEFINITION, 'Whether the garment defines a waist.'),
      v_drape: one(V_DRAPE, 'How the fabric hangs.'),
      v_structure: one(V_STRUCTURE, 'How tailored the construction looks.'),
      v_finish_cues: many(V_FINISH_CUES),

      confidence: {
        type: 'number', minimum: 0, maximum: 1,
        description: 'Your own confidence that these observations are correct.',
      },
    },
  }
}

export interface VisionResult {
  v_category: string | null
  v_silhouette: string | null
  v_neckline: string | null
  v_sleeve_length: string | null
  v_length: string | null
  v_pattern: string | null
  v_colors: string[]
  v_details: string[]
  v_rise: string | null
  v_waist_position: string | null
  v_hem_break: string | null
  v_shoulder_treatment: string | null
  v_neckline_width: string | null
  v_volume: string | null
  v_vertical_line: string | null
  v_waist_definition: string | null
  v_drape: string | null
  v_structure: string | null
  v_finish_cues: string[]
  v_confidence: number | null
}

export function sanitizeVision(raw: unknown): { result: VisionResult; dropped: number } {
  const r = (raw ?? {}) as Record<string, unknown>
  let dropped = 0

  const single = (field: Parameters<typeof coerce>[0], key: string) => {
    const v = coerce(field, r[key])
    if (r[key] != null && v === null) dropped++
    return v
  }
  const multi = (field: Parameters<typeof coerceMany>[0], key: string) => {
    const v = coerceMany(field, r[key])
    // Count only values that failed the vocabulary, not ones removed by
    // de-duplication — coerceMany dedupes, and an earlier version counted a
    // repeated VALID value as a dropped one, inflating the metric.
    if (Array.isArray(r[key])) {
      const seen = new Set(v)
      dropped += (r[key] as unknown[]).filter(
        (x) => typeof x !== 'string' || !seen.has(x.trim().toLowerCase().replace(/[\s_]+/g, '-')),
      ).length
    }
    return v
  }

  const conf = typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1
    ? r.confidence
    : null

  return {
    result: {
      v_category: single('category', 'category'),
      v_silhouette: single('silhouette', 'silhouette'),
      v_neckline: single('neckline', 'neckline'),
      v_sleeve_length: single('sleeve_length', 'sleeve_length'),
      v_length: single('length', 'length'),
      v_pattern: single('pattern', 'pattern'),
      v_colors: multi('colors', 'colors'),
      v_details: multi('details', 'details'),
      v_rise: single('v_rise', 'v_rise'),
      v_waist_position: single('v_waist_position', 'v_waist_position'),
      v_hem_break: single('v_hem_break', 'v_hem_break'),
      v_shoulder_treatment: single('v_shoulder_treatment', 'v_shoulder_treatment'),
      v_neckline_width: single('v_neckline_width', 'v_neckline_width'),
      v_volume: single('v_volume', 'v_volume'),
      v_vertical_line: single('v_vertical_line', 'v_vertical_line'),
      v_waist_definition: single('v_waist_definition', 'v_waist_definition'),
      v_drape: single('v_drape', 'v_drape'),
      v_structure: single('v_structure', 'v_structure'),
      v_finish_cues: multi('v_finish_cues', 'v_finish_cues'),
      v_confidence: conf,
    },
    dropped,
  }
}

const MEDIA_TYPES: Record<string, ImageInput['mediaType']> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/**
 * Build the image blocks for one product.
 *
 * Reads from the content-addressed store, so a product whose gallery was
 * reshuffled but not changed produces the same payload — which is what makes the
 * image-set hash a valid cache key.
 */
export function imageBlocks(hashes: string[]): ImageInput[] {
  const blocks: ImageInput[] = []

  for (const hash of hashes.slice(0, MAX_IMAGES_PER_PRODUCT)) {
    const file = resolveStored(hash)
    if (!file) continue
    const mediaType = MEDIA_TYPES[path.extname(file).toLowerCase()]
    if (!mediaType) continue

    // NOTE: images are sent at full resolution. Both providers downscale on
    // their side (Anthropic caps the long edge at 1568px; OpenAI tiles from a
    // 768px short edge), so this is correct but not the cheapest option — a
    // local downscale to ~1024px would roughly halve Anthropic's image tokens.
    // Measure before doing it: fine detail like topstitching feeds the
    // quality-tier heuristic and may not survive the smaller size.
    blocks.push({ mediaType, base64: readFileSync(file).toString('base64') })
  }
  return blocks
}

export interface VisionInput {
  name: string
  brand: string
  materialClean: string | null
  imageHashes: string[]
}

/**
 * Extract geometry for one product from all of its images.
 *
 * Material is passed as text context so the model is not guessing at fabric from
 * a photograph — it can see that something drapes, but not that it is 96% cotton.
 */
export async function extractVision(
  input: VisionInput,
): Promise<{ result: VisionResult; usage: Usage; dropped: number; images: number } | null> {
  const images = imageBlocks(input.imageHashes)
  // Six Gap products currently have no image at all, because two products named
  // "CloseKnit Jersey T-Shirt" collide on slugify(name) and overwrite each
  // other's folder. Skip and count them rather than failing the run.
  if (images.length === 0) return null

  const context = [
    `Product: ${input.brand} · ${input.name}`,
    input.materialClean ? `Material (from the label, do not re-derive): ${input.materialClean}` : '',
    `Images: ${images.length} views of this one product.`,
  ]
    .filter(Boolean)
    .join('\n')

  const { result, usage } = await callTool<unknown>({
    system: SYSTEM,
    text: context,
    images,
    toolName: 'describe_garment',
    toolDescription: 'Report the observable geometry of the garment in these photographs.',
    schema: schema(),
    maxTokens: 3000,
    // Ingest: wait out rate limits rather than failing the product.
    retries: 5,
    model: modelForStage('vision'),
  })

  const { result: clean, dropped } = sanitizeVision(result)
  return { result: clean, usage, dropped, images: images.length }
}
