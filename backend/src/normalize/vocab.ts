/**
 * The controlled vocabulary. Single source of truth for three consumers:
 *
 *   1. the deterministic rules extractor and the Rihoas KV parser
 *   2. the LLM tool schemas (generated from these arrays, not hand-written —
 *      Haiku honours schema enums far more reliably than prose instructions)
 *   3. the eval harness, which asserts no out-of-vocabulary value ever lands
 *      in a facet column
 *
 * Values are derived from Rihoas's structured descriptions, which are the only
 * brand that publishes garment attributes as key-values, then extended to cover
 * the bottoms and outerwear Rihoas doesn't sell. Measured key frequency out of
 * 100 Rihoas products: Style 95, Embellishment 94, Fabric 94, Pattern Type 92,
 * Neckline 86, Sleeve Length 77, Waist 60, Dress Type 44.
 */

export const CATEGORY = [
  'top', 'bottom', 'dress', 'outerwear', 'knitwear',
  'swimwear', 'intimates', 'jumpsuit', 'accessory',
] as const

export const SUBCATEGORY = [
  't-shirt', 'tank', 'camisole', 'blouse', 'shirt', 'polo', 'bodysuit',
  'sweater', 'cardigan', 'hoodie', 'sweatshirt', 'vest',
  'jacket', 'coat', 'blazer',
  'jeans', 'trousers', 'shorts', 'skirt', 'leggings', 'joggers',
  'mini-dress', 'midi-dress', 'maxi-dress', 'romper',
  'bikini-top', 'bikini-bottom', 'swimsuit', 'bra-top',
] as const

export const SILHOUETTE = [
  'fitted', 'slim', 'regular', 'relaxed', 'oversized', 'boxy',
  'a-line', 'sheath', 'mermaid', 'wrap', 'shift', 'bodycon',
  'flared', 'straight', 'wide-leg', 'tapered', 'baggy', 'bubble',
] as const

export const NECKLINE = [
  'crew', 'v-neck', 'scoop', 'square', 'sweetheart', 'boat', 'halter',
  'strapless', 'one-shoulder', 'mock-neck', 'turtleneck', 'cowl',
  'collared', 'mandarin-collar', 'collarless', 'u-neck', 'off-shoulder', 'plunge',
] as const

export const SLEEVE_LENGTH = [
  'sleeveless', 'cap', 'short', 'elbow', 'three-quarter', 'long', 'strapless',
] as const

export const LENGTH = [
  'cropped', 'regular', 'longline', 'mini', 'midi', 'maxi', 'ankle', 'full',
] as const

export const RISE = ['low-rise', 'mid-rise', 'high-rise'] as const

export const FIT = ['fitted', 'regular', 'relaxed', 'oversized'] as const

export const PATTERN = [
  'solid', 'striped', 'floral', 'geometric', 'plaid', 'checked', 'polka-dot',
  'animal', 'graphic', 'colorblock', 'tie-dye', 'textured', 'lace',
  'ribbed', 'pointelle', 'jacquard',
] as const

export const DETAILS = [
  'tie-back', 'self-tie', 'drawstring', 'button-front', 'half-button',
  'zip-front', 'zip-back', 'cut-out', 'slit', 'ruched', 'smocked', 'shirred',
  'pleated', 'pockets', 'belted', 'ruffle', 'lace-trim', 'embroidery',
  'sequins', 'rhinestones', 'pearls', 'backless', 'open-back', 'corset-back',
  'drop-shoulder', 'puff-sleeve', 'raw-hem', 'cuffed', 'elastic-waist', 'high-low',
] as const

export const OCCASION = [
  'everyday', 'work', 'evening', 'formal', 'beach', 'active', 'lounge',
] as const

export const SEASON = ['spring', 'summer', 'fall', 'winter', 'all-season'] as const

export const COLORS = [
  'white', 'off-white', 'ivory', 'cream', 'beige', 'tan', 'brown',
  'black', 'grey', 'navy', 'blue', 'light-blue', 'denim',
  'green', 'olive', 'teal', 'yellow', 'apricot', 'orange',
  'pink', 'red', 'wine', 'purple', 'multicolor', 'print',
] as const

/**
 * Fabric is construction, not fibre content. Kept strictly separate because
 * Rihoas's `Material:` key mixes the two — measured values include Chiffon 12,
 * Knit 10, Worsted 9, Jacquard 9, Brass 5, Titanium Steel 1 — and letting
 * "chiffon" into `fibers` would corrupt the natural-fibre ratio that the whole
 * fibre preference ranks on.
 */
export const FABRIC = [
  'jersey', 'knit', 'denim', 'chiffon', 'satin', 'lace', 'jacquard',
  'poplin', 'twill', 'fleece', 'gauze', 'rib', 'waffle', 'mesh',
  'corduroy', 'velvet', 'worsted', 'sweatfleece',
] as const

export const FIBER = [
  'cotton', 'polyester', 'elastane', 'nylon', 'viscose', 'modal', 'lyocell',
  'cupro', 'linen', 'wool', 'cashmere', 'silk', 'acrylic', 'acetate',
  'leather', 'other',
] as const

/**
 * Fibres that count toward `natural_ratio`. Semi-synthetics (viscose, modal,
 * lyocell, cupro, acetate) are cellulose-derived but chemically processed, so
 * they deliberately count as neither — a user who says "natural fibres" means
 * cotton and linen, not rayon.
 */
export const NATURAL_FIBERS = [
  'cotton', 'linen', 'wool', 'cashmere', 'silk', 'leather',
] as const

// ---------------------------------------------------------------------------
// Vision-only garment geometry. These have no text equivalent anywhere in the
// scraped corpus — they exist solely so the styling rules have something
// objective to key on. See preferences/stylingRules.ts.
// ---------------------------------------------------------------------------

export const V_RISE = ['high', 'mid', 'low'] as const
export const V_WAIST_POSITION = ['above-natural', 'natural', 'dropped', 'undefined'] as const
export const V_HEM_BREAK = ['mini', 'above-knee', 'midi', 'mid-calf', 'ankle', 'floor'] as const
export const V_SHOULDER_TREATMENT = [
  'halter', 'strap', 'set-in', 'raglan', 'drop', 'off-shoulder', 'puff', 'structured',
] as const
export const V_NECKLINE_WIDTH = [
  'narrow-v', 'deep-v', 'scoop', 'wide-scoop', 'boat', 'crew', 'square',
] as const
export const V_VOLUME = ['fitted', 'skimming', 'relaxed', 'voluminous'] as const
export const V_VERTICAL_LINE = ['continuous', 'interrupted-waistband', 'colorblocked'] as const
export const V_WAIST_DEFINITION = ['defined', 'semi-defined', 'undefined'] as const
export const V_DRAPE = ['fluid', 'structured', 'stiff', 'clingy'] as const
export const V_STRUCTURE = ['unstructured', 'light', 'tailored'] as const
export const V_FINISH_CUES = [
  'visible-seams', 'lined', 'topstitching', 'raw-edge', 'french-seams', 'exposed-zip',
] as const

export type Category = (typeof CATEGORY)[number]
export type Subcategory = (typeof SUBCATEGORY)[number]
export type Silhouette = (typeof SILHOUETTE)[number]
export type Neckline = (typeof NECKLINE)[number]
export type SleeveLength = (typeof SLEEVE_LENGTH)[number]
export type Length = (typeof LENGTH)[number]
export type Rise = (typeof RISE)[number]
export type Fit = (typeof FIT)[number]
export type Pattern = (typeof PATTERN)[number]
export type Detail = (typeof DETAILS)[number]
export type Occasion = (typeof OCCASION)[number]
export type Season = (typeof SEASON)[number]
export type Color = (typeof COLORS)[number]
export type Fabric = (typeof FABRIC)[number]
export type Fiber = (typeof FIBER)[number]

export type VRise = (typeof V_RISE)[number]
export type VWaistPosition = (typeof V_WAIST_POSITION)[number]
export type VHemBreak = (typeof V_HEM_BREAK)[number]
export type VShoulderTreatment = (typeof V_SHOULDER_TREATMENT)[number]
export type VNecklineWidth = (typeof V_NECKLINE_WIDTH)[number]
export type VVolume = (typeof V_VOLUME)[number]
export type VVerticalLine = (typeof V_VERTICAL_LINE)[number]
export type VWaistDefinition = (typeof V_WAIST_DEFINITION)[number]
export type VDrape = (typeof V_DRAPE)[number]
export type VStructure = (typeof V_STRUCTURE)[number]
export type VFinishCue = (typeof V_FINISH_CUES)[number]

/** Every facet an extractor may write, mapped to its permitted values. */
export const VOCAB = {
  category: CATEGORY,
  subcategory: SUBCATEGORY,
  silhouette: SILHOUETTE,
  neckline: NECKLINE,
  sleeve_length: SLEEVE_LENGTH,
  length: LENGTH,
  rise: RISE,
  fit: FIT,
  pattern: PATTERN,
  details: DETAILS,
  occasion: OCCASION,
  season: SEASON,
  colors: COLORS,
  fabric: FABRIC,
  v_rise: V_RISE,
  v_waist_position: V_WAIST_POSITION,
  v_hem_break: V_HEM_BREAK,
  v_shoulder_treatment: V_SHOULDER_TREATMENT,
  v_neckline_width: V_NECKLINE_WIDTH,
  v_volume: V_VOLUME,
  v_vertical_line: V_VERTICAL_LINE,
  v_waist_definition: V_WAIST_DEFINITION,
  v_drape: V_DRAPE,
  v_structure: V_STRUCTURE,
  v_finish_cues: V_FINISH_CUES,
} as const

export type VocabField = keyof typeof VOCAB

/**
 * Coerce a single extracted value into the vocabulary, or null.
 *
 * Every LLM-produced value passes through here. Out-of-vocabulary values are
 * dropped rather than stored, because a facet column holding free text silently
 * breaks both the styling rules and the eval's coverage assertions.
 */
export function coerce(field: VocabField, value: unknown): string | null {
  if (typeof value !== 'string') return null
  const needle = value.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (!needle) return null
  const allowed = VOCAB[field] as readonly string[]
  return allowed.includes(needle) ? needle : null
}

/** Coerce an array-valued facet, dropping unknowns and de-duplicating. */
export function coerceMany(field: VocabField, values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const out = new Set<string>()
  for (const v of values) {
    const hit = coerce(field, v)
    if (hit) out.add(hit)
  }
  return [...out]
}
