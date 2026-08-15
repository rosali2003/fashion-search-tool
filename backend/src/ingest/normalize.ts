import { createHash } from 'node:crypto'
import type { Insertable } from 'kysely'
import type { ProductsTable } from '../db/types.js'
import type { ScrapedProduct } from './types.js'
import { ingestImages, imageSetHash } from './images.js'
import { parseMaterial } from '../normalize/material.js'
import {
  cleanDescription, extractVendorSku, normalizeProductUrl, splitNameVariant,
} from '../normalize/text.js'
import { applyRules, applyGapBlocks, patternFromVariant, KNOWN_COLORS } from '../normalize/rules.js'
import { extractRihoasAttributes, colorFromRihoasName } from '../normalize/rihoas.js'
import { renderSearchFields, resolveAttributes, type TextAttributes } from '../normalize/render.js'
import { coerce, coerceMany } from '../normalize/vocab.js'

/**
 * Bump when any deterministic rule below changes. Rows carrying an older version
 * are re-normalised on the next ingest even if their source bytes are identical,
 * which is what makes a rule fix propagate without a manual purge.
 */
export const NORMALIZER_VERSION = 7

/**
 * Identity of the *source* data, used to skip work.
 *
 * Only raw scraper fields feed the hash, never derived values — otherwise a
 * normaliser change would alter the hash and be indistinguishable from the brand
 * editing its own copy.
 */
export function contentHash(p: ScrapedProduct): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        p.name, p.description, p.material, p.price_cents,
        p.image_urls, p.size_range ?? null, p.model_height_cm ?? null,
        p.model_size ?? null, p.fit_notes ?? null,
      ]),
    )
    .digest('hex')
}

export type ProductRow = Insertable<ProductsTable>

export interface NormalizeStats {
  imagesLinked: number
  imagesMissing: number
}

/**
 * Turn one scraped product into a database row.
 *
 * Deterministic only — no network, no LLM. This is what lets the catalog be
 * searchable before an API key exists, and it is the path the eval harness
 * exercises when tuning retrieval.
 */
export function normalizeProduct(
  p: ScrapedProduct,
  sourceRun: string,
  stats: NormalizeStats,
): ProductRow {
  const brand = p.brand.toLowerCase()

  const { name, variant } = splitNameVariant(p.name)
  const description_clean = cleanDescription(brand, p.description)
  const material = parseMaterial(p.material)

  // Prose that landed in the material field belongs with the description. Eight
  // Aritzia products are like this; discarding it would lose real garment detail.
  const bodyText = [description_clean, material.prose].filter(Boolean).join(' ') || null

  // --- deterministic attribute inference ---------------------------------
  const rules = applyRules(name, bodyText)
  const textAttrs: TextAttributes = {
    category: rules.category,
    subcategory: rules.subcategory,
    silhouette: rules.silhouette,
    neckline: rules.neckline,
    sleeve_length: rules.sleeve_length,
    length: rules.length,
    rise: rules.rise,
    fit: rules.fit,
    pattern: rules.pattern,
    colors: rules.colors,
    details: rules.details,
    occasion: rules.occasion,
    season: rules.season,
  }

  // Gap states fit and rise in structured blocks, which beat the same words
  // appearing in prose.
  if (brand === 'gap') Object.assign(textAttrs, applyGapBlocks(p.description))

  // Rihoas publishes a key-value attribute block: authoritative, and free.
  let rihoasWaistPosition: string | null = null
  let rihoasShoulder: string | null = null
  if (brand === 'rihoas' && p.description) {
    const rk = extractRihoasAttributes(p.description)
    textAttrs.silhouette = rk.silhouette ?? textAttrs.silhouette
    textAttrs.neckline = rk.neckline ?? textAttrs.neckline
    textAttrs.sleeve_length = rk.sleeve_length ?? textAttrs.sleeve_length
    textAttrs.pattern = rk.pattern ?? textAttrs.pattern
    textAttrs.rise = rk.rise ?? textAttrs.rise
    textAttrs.fit = rk.fit ?? textAttrs.fit
    textAttrs.details = [...new Set([...textAttrs.details, ...rk.details])]
    // Union rather than replace: the KV block is authoritative where it speaks,
    // but it omits occasion on 14 of 100 products and season on 14, and the
    // name-derived rules still apply there.
    textAttrs.occasion = [...new Set([...rk.occasion, ...textAttrs.occasion])]
    textAttrs.season = [...new Set([...rk.season, ...textAttrs.season])]
    rihoasWaistPosition = rk.v_waist_position
    rihoasShoulder = rk.v_shoulder_treatment

    const c = colorFromRihoasName(p.name, KNOWN_COLORS)
    if (c) textAttrs.colors = [...new Set([c, ...textAttrs.colors])]
  }

  // Uniqlo puts the colourway after a pipe in the name.
  if (variant) {
    textAttrs.pattern = patternFromVariant(variant) ?? textAttrs.pattern
  }
  // Uniqlo also brackets colourways inside the material string.
  if (material.colors.length) {
    const mapped = material.colors
      .flatMap((c) => (KNOWN_COLORS.includes(c) ? [c] : []))
    textAttrs.colors = [...new Set([...textAttrs.colors, ...mapped])]
  }

  // Everything must be in-vocabulary before it reaches a facet column.
  const safe: TextAttributes = {
    category: coerce('category', textAttrs.category),
    subcategory: coerce('subcategory', textAttrs.subcategory),
    silhouette: coerce('silhouette', textAttrs.silhouette),
    neckline: coerce('neckline', textAttrs.neckline),
    sleeve_length: coerce('sleeve_length', textAttrs.sleeve_length),
    length: coerce('length', textAttrs.length),
    rise: coerce('rise', textAttrs.rise),
    fit: coerce('fit', textAttrs.fit),
    pattern: coerce('pattern', textAttrs.pattern),
    colors: coerceMany('colors', textAttrs.colors),
    details: coerceMany('details', textAttrs.details),
    occasion: coerceMany('occasion', textAttrs.occasion),
    season: coerceMany('season', textAttrs.season),
  }

  // Vision has not run at this stage, so resolution is text-only; the vision
  // pass re-resolves and rewrites the search fields when it lands.
  const resolved = resolveAttributes(safe, null)

  const img = ingestImages(p.local_image_paths)
  stats.imagesLinked += img.linked
  stats.imagesMissing += img.missing

  const search = renderSearchFields({
    name,
    name_variant: variant,
    brand,
    description_clean: bodyText,
    material_clean: material.clean,
    fiber_names: material.fiberNames,
    fabric: [...new Set([...material.fabric])],
    resolved,
    vision: null,
    size_range: p.size_range ?? [],
    fit_notes: p.fit_notes ?? null,
  })

  return {
    product_url: normalizeProductUrl(brand, p.product_url),
    brand,
    vendor_sku: extractVendorSku(brand, p.description),
    content_hash: contentHash(p),
    source_run: sourceRun,
    scraped_at: p.scraped_at ? new Date(p.scraped_at) : null,
    is_active: true,

    raw_name: p.name,
    raw_description: p.description,
    raw_material: p.material,
    price_cents: p.price_cents,
    image_urls: p.image_urls,
    image_hashes: img.hashes,

    name,
    name_variant: variant,
    description_clean: bodyText,
    material_clean: material.clean,
    fibers: JSON.stringify(material.fibers),
    fiber_names: material.fiberNames,
    natural_ratio: material.naturalRatio,
    primary_fiber: material.primaryFiber,
    fibers_incomplete: material.incomplete,
    fabric: material.fabric,

    category: resolved.category,
    subcategory: resolved.subcategory,
    silhouette: resolved.silhouette,
    neckline: resolved.neckline,
    sleeve_length: resolved.sleeve_length,
    length: resolved.length,
    rise: resolved.rise,
    fit: resolved.fit,
    pattern: resolved.pattern,
    colors: resolved.colors,
    details: resolved.details,
    occasion: resolved.occasion,
    season: resolved.season,

    size_range: p.size_range ?? [],
    model_height_cm: p.model_height_cm ?? null,
    model_size: p.model_size ?? null,
    fit_notes: p.fit_notes ?? null,

    attributes_source: brand === 'rihoas' ? 'rihoas_kv' : 'rules',
    attributes_version: NORMALIZER_VERSION,
    attributes_at: new Date(),

    // Rihoas states the waistline and shoulder treatment outright, so those two
    // vision-tier columns can be populated without a model.
    v_waist_position: coerce('v_waist_position', rihoasWaistPosition),
    v_shoulder_treatment: coerce('v_shoulder_treatment', rihoasShoulder),

    // Only the "what the images are now" hash. Enrichment columns are NOT
    // written here — see upsert.ts, which excludes them from the update set so
    // a daily re-ingest cannot wipe work the vision pass already paid for.
    image_set_hash: imageSetHash(img.hashes),
    attribute_conflicts: JSON.stringify(resolved.conflicts),

    ...search,
  }
}
