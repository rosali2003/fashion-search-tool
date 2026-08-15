/**
 * Two jobs, both about what the BM25 index actually sees.
 *
 * `resolveAttributes` applies text-vs-vision precedence and records
 * disagreements. `renderSearchFields` turns the resolved facets into the four
 * search-tier strings.
 *
 * The design constraint driving all of this: Tantivy hardcodes BM25's `b`
 * (length normalisation) at 0.75 with no override, so document length cannot be
 * de-weighted at query time. The only remaining lever is what goes in each
 * field. `search_attrs` is therefore rendered purely from a controlled
 * vocabulary — bounded, and near-identical in length whether the source
 * description was 308 characters (Aritzia mean) or 1,956 (Uniqlo max). Prose is
 * confined to `search_body`, truncated, and given the lowest boost.
 */

import { expandAll } from './synonyms.js'
import type { AttributeConflict } from '../db/types.js'

/** Facets that both extractors can produce, so precedence has to be decided. */
export interface TextAttributes {
  category: string | null
  subcategory: string | null
  silhouette: string | null
  neckline: string | null
  sleeve_length: string | null
  length: string | null
  rise: string | null
  fit: string | null
  pattern: string | null
  colors: string[]
  details: string[]
  occasion: string[]
  season: string[]
}

export interface VisionAttributes {
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
}

export interface ResolvedAttributes extends TextAttributes {
  conflicts: AttributeConflict[]
}

const emptyVision = (): VisionAttributes => ({
  v_category: null, v_silhouette: null, v_neckline: null, v_sleeve_length: null,
  v_length: null, v_pattern: null, v_colors: [], v_details: [], v_rise: null,
  v_waist_position: null, v_hem_break: null, v_shoulder_treatment: null,
  v_neckline_width: null, v_volume: null, v_vertical_line: null,
  v_waist_definition: null, v_drape: null, v_structure: null, v_finish_cues: [],
})

/**
 * Resolve each facet to a single value.
 *
 * Vision wins for anything directly observable in a photograph: it sees the
 * garment, whereas brand copy is marketing. The live example that motivated
 * conflict logging is Rihoas `apricot-boat-neck-pearl-satin-midi-dress`, which
 * is *named* apricot satin but photographs as cream and matte.
 *
 * Text wins for category and subcategory, where the product name is nearly
 * always explicit and unambiguous, and vision can mistake a romper for a dress.
 * Fibre content is not resolved here at all — it comes only from the material
 * parser, because no model can see "96% cotton" and will invent percentages.
 */
export function resolveAttributes(
  text: TextAttributes,
  vision: VisionAttributes | null,
): ResolvedAttributes {
  const v = vision ?? emptyVision()
  const conflicts: AttributeConflict[] = []

  const note = (field: string, t: string | null, vv: string | null) => {
    if (t && vv && t !== vv) conflicts.push({ field, text_value: t, vision_value: vv })
  }

  // Vision-preferred, single-valued.
  const visionFirst = <K extends string>(
    field: K,
    textVal: string | null,
    visionVal: string | null,
  ): string | null => {
    note(field, textVal, visionVal)
    return visionVal ?? textVal
  }

  // Text-preferred, but still log disagreement.
  const textFirst = (field: string, textVal: string | null, visionVal: string | null) => {
    note(field, textVal, visionVal)
    return textVal ?? visionVal
  }

  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])]

  return {
    category: textFirst('category', text.category, v.v_category),
    subcategory: text.subcategory,
    silhouette: visionFirst('silhouette', text.silhouette, v.v_silhouette),
    neckline: visionFirst('neckline', text.neckline, v.v_neckline),
    sleeve_length: visionFirst('sleeve_length', text.sleeve_length, v.v_sleeve_length),
    length: visionFirst('length', text.length, v.v_length),
    pattern: visionFirst('pattern', text.pattern, v.v_pattern),
    // Rise: vision reads it off the waistband, but text is explicit when a name
    // says "High-Rise", so text wins and vision fills gaps.
    rise: textFirst('rise', text.rise, v.v_rise),
    fit: text.fit,
    // Colours: vision is authoritative but both are kept, because a shopper may
    // search the brand's colour name ("apricot") even when the photo reads cream.
    colors: union(v.v_colors, text.colors),
    details: union(text.details, v.v_details),
    occasion: text.occasion,
    season: text.season,
    conflicts,
  }
}

export interface RenderInput {
  name: string
  name_variant: string | null
  brand: string
  description_clean: string | null
  material_clean: string | null
  fiber_names: string[]
  fabric: string[]
  resolved: ResolvedAttributes
  vision: VisionAttributes | null
  size_range: string[]
  fit_notes: string | null
}

export interface SearchFields {
  search_title: string
  search_attrs: string
  search_material: string
  search_body: string
}

/**
 * Prose is capped. Beyond roughly this much text the marginal token is styling
 * advice ("pair with sneakers"), which adds document length — and therefore BM25
 * length penalty — without adding anything retrievable.
 */
const MAX_BODY_CHARS = 600

export function renderSearchFields(input: RenderInput): SearchFields {
  const r = input.resolved
  const v = input.vision

  const search_title = [input.name, input.name_variant].filter(Boolean).join(' ').toLowerCase()

  // Every facet, plus every synonym of every facet. This is what lets a query
  // for "high collar" reach a product whose copy only ever says "turtle neck",
  // and what makes vague queries like "something cozy for the weekend" land on
  // the occasion facet rather than on nothing at all.
  const search_attrs = expandAll([
    r.category, r.subcategory, r.silhouette, r.neckline, r.sleeve_length,
    r.length, r.rise, r.fit, r.pattern,
    ...r.colors, ...r.details, ...r.occasion, ...r.season,
    ...input.fabric,
    // Vision geometry is searchable too: a user typing "high waisted" should
    // reach a garment the model saw as high-rise even when the copy is silent.
    v?.v_rise, v?.v_waist_position, v?.v_hem_break, v?.v_shoulder_treatment,
    v?.v_neckline_width, v?.v_volume, v?.v_waist_definition, v?.v_drape,
    v?.v_structure,
    ...(v?.v_finish_cues ?? []),
  ])

  // Fibre names are expanded so "stretchy" reaches elastane and "tencel"
  // reaches lyocell. The canonical percentage string is included for exact
  // matches like "100% cotton".
  const search_material = [
    input.material_clean ?? '',
    expandAll(input.fiber_names),
    expandAll(input.fabric),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const bodyParts = [input.description_clean ?? '', input.fit_notes ?? '']
  let search_body = bodyParts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  if (search_body.length > MAX_BODY_CHARS) {
    // Cut on a word boundary so the last token isn't a fragment.
    const cut = search_body.lastIndexOf(' ', MAX_BODY_CHARS)
    search_body = search_body.slice(0, cut > 0 ? cut : MAX_BODY_CHARS)
  }

  return {
    search_title,
    search_attrs,
    search_material,
    search_body: search_body.toLowerCase(),
  }
}
