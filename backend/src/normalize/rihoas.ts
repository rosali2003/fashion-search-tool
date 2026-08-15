/**
 * Rihoas publishes its garment attributes as a key-value block in the
 * description field, which makes 100 of the 298 products free of LLM extraction
 * entirely — and, more importantly, defines the controlled vocabulary the other
 * three brands get mapped into.
 *
 * Verbatim example:
 *   "- Occasion: Daily - Style: Cute - Season: Spring, Summer - Back Neckline:
 *    Corset - Fabric Stretch: Medium Stretch - Waist: Natural Waisted - Sleeve
 *    Length: Sleeveless - Sleeve Type: Sleeveless - Pattern Type: Floral -
 *    Embellishment: Ruched, Zipper, Tie, Lace - Neckline: Sweetheart Neck -
 *    Dress Type: Skater - Silhouette: A-Line - Fabric: Polyester 65.0%, Nylon
 *    35.0% - Lining: Polyester - Material: Lace"
 *
 * Splitting greedily on "-" is wrong: values contain hyphens ("A-Line") and the
 * scraped data contains run-together pairs where the separator was lost, e.g.
 * "Waist: Natural Waisted Sleeve Length: Sleeveless". So the parser splits on
 * the position of the *next known key* instead.
 */

import type { ParsedMaterial } from './material.js'

/** Every key observed in the corpus, longest first so "Sleeve Length" beats "Sleeve". */
const KEYS = [
  'Back Neckline', 'Fabric Stretch', 'Sleeve Length', 'Sleeve Type', 'Pattern Type',
  'Dress Type', 'Embellishment', 'Silhouette', 'Neckline', 'Occasion', 'Material',
  'Season', 'Fabric', 'Lining', 'Waist', 'Style', 'Length', 'Fit', 'Type',
].sort((a, b) => b.length - a.length)

const KEY_RE = new RegExp(`(${KEYS.join('|')})\\s*:`, 'gi')

export type RihoasKV = Record<string, string>

/** Split the block into raw key -> value pairs. */
export function parseKV(description: string): RihoasKV {
  const out: RihoasKV = {}
  const marks: { key: string; at: number; len: number }[] = []

  KEY_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KEY_RE.exec(description)) !== null) {
    marks.push({ key: m[1].toLowerCase(), at: m.index, len: m[0].length })
  }

  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : description.length
    let value = description.slice(mark.at + mark.len, end)
    // Trim the list separator that precedes the next key, plus stray dashes.
    value = value.replace(/[\s-]+$/, '').replace(/^[\s-]+/, '').trim()
    if (value) out[mark.key] = value
  })

  return out
}

const splitList = (v: string): string[] =>
  v.split(/[,/]/).map((s) => s.trim()).filter(Boolean)

const NECKLINE_MAP: Record<string, string> = {
  'v neck': 'v-neck', 'v-neck': 'v-neck', 'deep v neck': 'plunge', 'plunging': 'plunge',
  'square neck': 'square', square: 'square',
  'sweetheart neck': 'sweetheart', sweetheart: 'sweetheart',
  'round neck': 'crew', round: 'crew', 'crew neck': 'crew', 'o neck': 'crew',
  'boat neck': 'boat', bateau: 'boat',
  'scoop neck': 'scoop', scoop: 'scoop', 'u neck': 'u-neck',
  halter: 'halter', 'halter neck': 'halter',
  strapless: 'strapless', bandeau: 'strapless', tube: 'strapless',
  'off shoulder': 'off-shoulder', 'off the shoulder': 'off-shoulder',
  'one shoulder': 'one-shoulder', asymmetrical: 'one-shoulder',
  turtle: 'turtleneck', 'turtle neck': 'turtleneck', turtleneck: 'turtleneck',
  'mock neck': 'mock-neck', 'high neck': 'mock-neck', 'stand collar': 'mock-neck',
  mandarin: 'mandarin-collar', 'mandarin collar': 'mandarin-collar',
  collar: 'collared', 'shirt collar': 'collared', 'lapel collar': 'collared',
  'peter pan collar': 'collared', collared: 'collared',
  cowl: 'cowl', 'cowl neck': 'cowl',
  // "Straps" describes the shoulder treatment, not a neckline shape; it is
  // routed to v_shoulder_treatment by the caller, not stored as a neckline.
}

const SLEEVE_MAP: Record<string, string> = {
  sleeveless: 'sleeveless', 'no sleeve': 'sleeveless',
  'short sleeves': 'short', 'short sleeve': 'short',
  '3/4 length sleeves': 'three-quarter', '3/4 sleeves': 'three-quarter',
  'three quarter': 'three-quarter',
  'long sleeves': 'long', 'long sleeve': 'long',
  'cap sleeve': 'cap', 'circular cap': 'cap', 'cap sleeves': 'cap',
  'elbow length': 'elbow', strapless: 'strapless',
}

const SILHOUETTE_MAP: Record<string, string> = {
  'a-line': 'a-line', 'a line': 'a-line', skater: 'a-line', 'fit and flare': 'a-line',
  sheath: 'sheath', 'sheath dress': 'sheath', pencil: 'sheath', column: 'sheath',
  mermaid: 'mermaid', trumpet: 'mermaid', fishtail: 'mermaid',
  bodycon: 'bodycon', 'body con': 'bodycon',
  straight: 'straight', shift: 'shift', tunic: 'shift',
  wrap: 'wrap', slip: 'straight',
  flared: 'flared', 'ball gown': 'a-line', 'puff ball': 'bubble', bubble: 'bubble',
  loose: 'relaxed', oversized: 'oversized', regular: 'regular', fitted: 'fitted',
}

const PATTERN_MAP: Record<string, string> = {
  solid: 'solid', plain: 'solid',
  floral: 'floral', flower: 'floral',
  striped: 'striped', stripe: 'striped', 'vertical stripe': 'striped',
  geometric: 'geometric', abstract: 'geometric',
  plaid: 'plaid', tartan: 'plaid', checked: 'checked', check: 'checked', gingham: 'checked',
  'polka dot': 'polka-dot', dot: 'polka-dot', dots: 'polka-dot',
  leopard: 'animal', animal: 'animal', snake: 'animal', zebra: 'animal',
  'color block': 'colorblock', colorblock: 'colorblock',
  'tie dye': 'tie-dye', textured: 'textured', graphic: 'graphic', letter: 'graphic',
  lace: 'lace', ribbed: 'ribbed', jacquard: 'jacquard', pointelle: 'pointelle',
  paisley: 'geometric', 'heart': 'graphic',
}

/** Rihoas's `Embellishment` list maps onto construction details. */
const DETAIL_MAP: Record<string, string> = {
  button: 'button-front', buttons: 'button-front', 'single breasted': 'button-front',
  'double breasted': 'button-front',
  zipper: 'zip-front', zip: 'zip-front',
  tie: 'self-tie', ties: 'self-tie', bow: 'self-tie', 'lace up': 'corset-back',
  ruched: 'ruched', ruching: 'ruched', shirred: 'shirred', smocked: 'smocked',
  pleated: 'pleated', pleat: 'pleated',
  'cut out': 'cut-out', cutout: 'cut-out', 'hollow out': 'cut-out', keyhole: 'cut-out',
  slit: 'slit', split: 'slit',
  lace: 'lace-trim', 'lace trim': 'lace-trim',
  ruffle: 'ruffle', ruffles: 'ruffle', flounce: 'ruffle', frill: 'ruffle',
  rhinestones: 'rhinestones', rhinestone: 'rhinestones', diamante: 'rhinestones',
  sequins: 'sequins', sequin: 'sequins', beaded: 'sequins',
  pearls: 'pearls', pearl: 'pearls',
  embroidery: 'embroidery', embroidered: 'embroidery',
  pocket: 'pockets', pockets: 'pockets',
  belt: 'belted', belted: 'belted', sash: 'belted',
  backless: 'backless', 'open back': 'open-back', corset: 'corset-back',
  drawstring: 'drawstring', elastic: 'elastic-waist',
  'puff sleeve': 'puff-sleeve', 'drop shoulder': 'drop-shoulder',
  textured: 'textured', tassel: 'ruffle', fringe: 'ruffle',
}

const OCCASION_MAP: Record<string, string> = {
  daily: 'everyday', casual: 'everyday', everyday: 'everyday', cute: 'everyday',
  'office wear': 'work', office: 'work', work: 'work', business: 'work', commute: 'work',
  'special occasion': 'formal', formal: 'formal', wedding: 'formal', prom: 'formal',
  party: 'evening', evening: 'evening', club: 'evening', 'night out': 'evening',
  elegant: 'evening', cocktail: 'evening',
  vacation: 'beach', beach: 'beach', holiday: 'beach', resort: 'beach', swim: 'beach',
  sport: 'active', sports: 'active', athletic: 'active', workout: 'active',
  home: 'lounge', lounge: 'lounge', sleep: 'lounge',
}

const SEASON_MAP: Record<string, string> = {
  spring: 'spring', summer: 'summer', fall: 'fall', autumn: 'fall', winter: 'winter',
  'all season': 'all-season', 'four seasons': 'all-season',
}

const WAIST_MAP: Record<string, string> = {
  'high waisted': 'high-rise', 'high waist': 'high-rise',
  'natural waisted': 'mid-rise', 'natural waist': 'mid-rise',
  'low waisted': 'low-rise', 'low waist': 'low-rise',
  'drop waisted': 'low-rise', 'empire': 'high-rise',
}

/** Rihoas's `Waist` value also tells us where the waistline sits visually. */
const WAIST_POSITION_MAP: Record<string, string> = {
  'high waisted': 'above-natural', empire: 'above-natural',
  'natural waisted': 'natural', 'natural waist': 'natural',
  'low waisted': 'dropped', 'drop waisted': 'dropped',
}

const SHOULDER_MAP: Record<string, string> = {
  straps: 'strap', strap: 'strap', spaghetti: 'strap', 'adjustable straps': 'strap',
  halter: 'halter', 'off shoulder': 'off-shoulder', 'one shoulder': 'strap',
  'puff sleeve': 'puff', 'drop shoulder': 'drop', raglan: 'raglan',
  'regular sleeve': 'set-in', 'set in sleeve': 'set-in',
}

function lookup(map: Record<string, string>, value: string): string | null {
  const k = value.toLowerCase().replace(/\s+/g, ' ').trim()
  if (map[k]) return map[k]
  // Substring fallback, longest key first so "sweetheart neck" beats "neck".
  for (const key of Object.keys(map).sort((a, b) => b.length - a.length)) {
    if (k.includes(key)) return map[key]
  }
  return null
}

function lookupMany(map: Record<string, string>, value: string): string[] {
  const out = new Set<string>()
  for (const part of splitList(value)) {
    const hit = lookup(map, part)
    if (hit) out.add(hit)
  }
  return [...out]
}

export interface RihoasAttributes {
  silhouette: string | null
  neckline: string | null
  sleeve_length: string | null
  pattern: string | null
  rise: string | null
  fit: string | null
  details: string[]
  occasion: string[]
  season: string[]
  fabric: string[]
  /** Waist position is vision-tier, but Rihoas states it outright. */
  v_waist_position: string | null
  v_shoulder_treatment: string | null
  /** The `Fabric:` value is a material string; hand it to parseMaterial. */
  fabricRaw: string | null
}

/**
 * Map the KV block onto the controlled vocabulary.
 *
 * Only vocabulary values are emitted; anything unrecognised is dropped rather
 * than stored, so a facet column can never hold free text.
 */
export function extractRihoasAttributes(description: string): RihoasAttributes {
  const kv = parseKV(description)

  const details = new Set<string>()
  if (kv.embellishment) for (const d of lookupMany(DETAIL_MAP, kv.embellishment)) details.add(d)

  const occasion = new Set<string>()
  for (const key of ['occasion', 'style']) {
    if (kv[key]) for (const o of lookupMany(OCCASION_MAP, kv[key])) occasion.add(o)
  }

  const fabric = new Set<string>()
  // `Material:` is where Rihoas puts construction (Chiffon, Knit, Worsted) as
  // often as fibre, so it feeds fabric; `Fabric:` is the percentage breakdown.
  if (kv.material) {
    for (const part of splitList(kv.material)) {
      const p = part.toLowerCase().trim()
      if (['chiffon', 'knit', 'worsted', 'jacquard', 'lace', 'satin', 'denim',
           'mesh', 'velvet', 'corduroy', 'jersey', 'twill', 'poplin'].includes(p)) {
        fabric.add(p === 'worsted woven' ? 'worsted' : p)
      }
    }
  }

  // Pattern can come from Pattern Type or, failing that, from Material: Lace.
  let pattern = kv['pattern type'] ? lookup(PATTERN_MAP, kv['pattern type']) : null
  if (!pattern && kv.material) pattern = lookup(PATTERN_MAP, kv.material)

  // Silhouette: prefer the explicit key, fall back to Dress Type.
  let silhouette = kv.silhouette ? lookup(SILHOUETTE_MAP, kv.silhouette) : null
  if (!silhouette && kv['dress type']) silhouette = lookup(SILHOUETTE_MAP, kv['dress type'])

  // Sleeve Length is the authoritative key; Sleeve Type is a fallback.
  let sleeve = kv['sleeve length'] ? lookup(SLEEVE_MAP, kv['sleeve length']) : null
  if (!sleeve && kv['sleeve type']) sleeve = lookup(SLEEVE_MAP, kv['sleeve type'])

  const neckline = kv.neckline ? lookup(NECKLINE_MAP, kv.neckline) : null

  // "Straps" appears under Neckline but describes the shoulder, so it is routed
  // to the shoulder field instead of being discarded.
  let shoulder = kv['sleeve type'] ? lookup(SHOULDER_MAP, kv['sleeve type']) : null
  if (!shoulder && kv.neckline) shoulder = lookup(SHOULDER_MAP, kv.neckline)

  const stretchFit = kv['fabric stretch']?.toLowerCase() ?? ''
  const fit =
    /high stretch/.test(stretchFit) ? 'fitted'
    : /no stretch/.test(stretchFit) ? 'regular'
    : null

  return {
    silhouette,
    neckline,
    sleeve_length: sleeve,
    pattern,
    rise: kv.waist ? lookup(WAIST_MAP, kv.waist) : null,
    fit,
    details: [...details],
    occasion: [...occasion],
    season: kv.season ? lookupMany(SEASON_MAP, kv.season) : [],
    fabric: [...fabric],
    v_waist_position: kv.waist ? lookup(WAIST_POSITION_MAP, kv.waist) : null,
    v_shoulder_treatment: shoulder,
    fabricRaw: kv.fabric ?? null,
  }
}

/**
 * Rihoas product names lead with the colour: "Apricot Sweetheart Neck Floral
 * Lace Mini Dress". Cheap, reliable, and it covers all 100 products.
 */
export function colorFromRihoasName(name: string, known: readonly string[]): string | null {
  const first = name.trim().split(/\s+/)[0]?.toLowerCase()
  if (!first) return null
  return known.includes(first) ? first : null
}

export type { ParsedMaterial }
