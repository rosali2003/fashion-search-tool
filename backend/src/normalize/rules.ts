/**
 * Deterministic attribute inference, applied to every brand before any LLM runs.
 *
 * Product names in this corpus are unusually informative — "Apricot Sweetheart
 * Neck Floral Lace Mini Dress", "HEATTECH Ultra Warm High Neck T-Shirt",
 * "Organic Cotton Denim Classic Shirt" — so a token classifier covers category,
 * subcategory and often neckline and length outright. Whatever these rules
 * cannot reach is left null for the LLM extractors to fill, which keeps the
 * paid path as small as possible.
 *
 * Ordering matters throughout: longer, more specific patterns are tested first,
 * so "mini dress" resolves before "dress" and "bikini top" before "top".
 */

import { COLORS } from './vocab.js'
import { w, wp } from './patterns.js'

interface Rule {
  re: RegExp
  category?: string
  subcategory?: string
}

/** Most specific first. The first match wins. */
const GARMENT_RULES: Rule[] = [
  { re: wp('bikini top', 'swim top', 'bralette top'), category: 'swimwear', subcategory: 'bikini-top' },
  { re: wp('bikini bottom', 'swim bottom'), category: 'swimwear', subcategory: 'bikini-bottom' },
  { re: wp('one[- ]?piece', 'swimsuit', 'maillot'), category: 'swimwear', subcategory: 'swimsuit' },
  { re: wp('bikini'), category: 'swimwear', subcategory: 'bikini-top' },

  { re: wp('bra top', 'bra camisole', 'bralette'), category: 'intimates', subcategory: 'bra-top' },
  { re: wp('bodysuit'), category: 'top', subcategory: 'bodysuit' },

  { re: wp('maxi dress', 'gown'), category: 'dress', subcategory: 'maxi-dress' },
  { re: wp('midi dress'), category: 'dress', subcategory: 'midi-dress' },
  { re: wp('mini dress'), category: 'dress', subcategory: 'mini-dress' },
  { re: wp('dress'), category: 'dress' },
  { re: wp('romper', 'playsuit'), category: 'jumpsuit', subcategory: 'romper' },
  { re: wp('jumpsuit', 'overall'), category: 'jumpsuit' },

  { re: wp('hoodie', 'hooded sweatshirt'), category: 'knitwear', subcategory: 'hoodie' },
  { re: wp('sweatshirt'), category: 'knitwear', subcategory: 'sweatshirt' },
  { re: wp('cardigan'), category: 'knitwear', subcategory: 'cardigan' },
  { re: wp('sweater vest'), category: 'knitwear', subcategory: 'vest' },
  { re: wp('sweater', 'jumper', 'pullover', 'rollneck'), category: 'knitwear', subcategory: 'sweater' },

  { re: wp('blazer'), category: 'outerwear', subcategory: 'blazer' },
  { re: wp('trench', 'parka', 'puffer', 'overcoat', 'coat'), category: 'outerwear', subcategory: 'coat' },
  { re: wp('jacket', 'windbreaker', 'anorak', 'bomber'), category: 'outerwear', subcategory: 'jacket' },

  // Bare "Tee" is Rihoas's naming convention for roughly 14 products ("White
  // Round Neck Geometric Button Tee"), all of which had a null category until
  // this was added. `\btee\b` is safe — it does not match "committee".
  { re: wp('t[- ]?shirt', 'tee shirt', 'tee'), category: 'top', subcategory: 't-shirt' },
  { re: wp('tank top', 'tank'), category: 'top', subcategory: 'tank' },
  { re: wp('camisole', 'cami'), category: 'top', subcategory: 'camisole' },
  { re: wp('blouse'), category: 'top', subcategory: 'blouse' },
  { re: wp('polo'), category: 'top', subcategory: 'polo' },
  { re: wp('shirt'), category: 'top', subcategory: 'shirt' },
  { re: wp('bustier', 'corset top'), category: 'top' },

  { re: wp('jean', 'denim pant'), category: 'bottom', subcategory: 'jeans' },
  { re: wp('legging'), category: 'bottom', subcategory: 'leggings' },
  { re: wp('jogger', 'sweatpant'), category: 'bottom', subcategory: 'joggers' },
  { re: wp('short', 'skort'), category: 'bottom', subcategory: 'shorts' },
  { re: wp('skirt'), category: 'bottom', subcategory: 'skirt' },
  { re: wp('pant', 'trouser', 'chino', 'slack'), category: 'bottom', subcategory: 'trousers' },
  // Sweater vest is caught above; a bare vest is outerwear.
  { re: wp('vest', 'gilet'), category: 'outerwear', subcategory: 'vest' },

  { re: wp('necklace', 'earring', 'bracelet', 'ring', 'bag', 'belt', 'scarf', 'hat', 'cap', 'sock'), category: 'accessory' },

  // Deliberately last: a bare "top" would otherwise swallow "bikini top".
  { re: wp('top'), category: 'top' },
]

const NECKLINE_PATTERNS: [RegExp, string][] = [
  // Bare "turtle" is Rihoas's own neckline vocabulary (observed 4x in its KV
  // blocks) and appears in names like "Off White Turtle Tie Regular Sleeve
  // Shirt" — which is the canary query's target. Without it that product's
  // neckline is null, and "high collar" has nothing to match through the
  // mock-neck/turtleneck synonym chain.
  [w('turtle ?neck', 'turtleneck', 'turtle'), 'turtleneck'],
  [w('mock ?neck', 'high ?neck', 'funnel ?neck'), 'mock-neck'],
  [w('mandarin collar', 'band collar'), 'mandarin-collar'],
  [w('sweetheart'), 'sweetheart'],
  [w('halter', 'halterneck'), 'halter'],
  [w('strapless', 'bandeau', 'tube top'), 'strapless'],
  [w('off[- ]shoulder'), 'off-shoulder'],
  [w('one[- ]shoulder'), 'one-shoulder'],
  [w('square ?neck'), 'square'],
  [w('boat ?neck', 'boatneck', 'bateau'), 'boat'],
  [w('scoop ?neck'), 'scoop'],
  [w('cowl ?neck', 'cowl'), 'cowl'],
  [w('plunge', 'plunging', 'deep v'), 'plunge'],
  [w('v[- ]?neck'), 'v-neck'],
  [w('crew ?neck', 'crewneck', 'round ?neck'), 'crew'],
  [w('collared', 'shirt collar'), 'collared'],
]

const SLEEVE_PATTERNS: [RegExp, string][] = [
  [wp('sleeveless', 'tank', 'cami'), 'sleeveless'],
  [w('3/4', 'three[- ]quarter'), 'three-quarter'],
  [wp('cap sleeve'), 'cap'],
  [wp('long ?sleeve'), 'long'],
  [wp('short ?sleeve'), 'short'],
  [w('strapless'), 'strapless'],
]

const LENGTH_PATTERNS: [RegExp, string][] = [
  [w('cropped', 'crop', 'baby tee', 'shrunken'), 'cropped'],
  [w('longline'), 'longline'],
  [w('maxi', 'floor length'), 'maxi'],
  [w('midi'), 'midi'],
  [w('mini', 'micro'), 'mini'],
  [w('ankle'), 'ankle'],
]

const RISE_PATTERNS: [RegExp, string][] = [
  [w('high[- ]?rise', 'hi[- ]?rise', 'high[- ]?waisted', 'high[- ]?waist'), 'high-rise'],
  [w('mid[- ]?rise'), 'mid-rise'],
  [w('low[- ]?rise', 'lo[- ]?rise', 'low[- ]?waisted', 'low[- ]?waist'), 'low-rise'],
]

const FIT_PATTERNS: [RegExp, string][] = [
  [w('oversized', 'mega', 'roomy', 'slouchy', 'baggy'), 'oversized'],
  [w('relaxed', 'loose', 'easy'), 'relaxed'],
  [w('fitted', 'slim', 'skinny', 'body ?con'), 'fitted'],
  [w('regular', 'classic', 'straight'), 'regular'],
]

const SILHOUETTE_PATTERNS: [RegExp, string][] = [
  [w('a[- ]line', 'fit and flare', 'skater'), 'a-line'],
  [w('wide[- ]leg', 'palazzo', 'barrel'), 'wide-leg'],
  [w('mermaid', 'trumpet', 'fishtail'), 'mermaid'],
  [w('sheath', 'pencil', 'column'), 'sheath'],
  [w('body ?con'), 'bodycon'],
  [w('wrap'), 'wrap'],
  [w('shift'), 'shift'],
  [w('oversized', 'mega'), 'oversized'],
  [w('boxy'), 'boxy'],
  [w('bubble', 'balloon'), 'bubble'],
  [w('tapered'), 'tapered'],
  [w('relaxed'), 'relaxed'],
  [w('slim'), 'slim'],
]

const PATTERN_PATTERNS: [RegExp, string][] = [
  [wp('floral', 'flower'), 'floral'],
  [wp('striped', 'stripe', 'pinstripe'), 'striped'],
  [wp('plaid', 'tartan'), 'plaid'],
  [wp('checked', 'check', 'gingham'), 'checked'],
  [wp('polka ?dot', 'spotted'), 'polka-dot'],
  [wp('leopard', 'zebra', 'snake print', 'animal print'), 'animal'],
  [w('colou?r ?block'), 'colorblock'],
  [w('tie[- ]dye'), 'tie-dye'],
  [w('ribbed', 'rib'), 'ribbed'],
  [w('pointelle'), 'pointelle'],
  [w('jacquard'), 'jacquard'],
  [w('lace'), 'lace'],
  [w('waffle', 'textured', 'crinkle'), 'textured'],
  [wp('graphic', 'logo', 'letter print'), 'graphic'],
  [w('solid', 'plain'), 'solid'],
]

const DETAIL_PATTERNS: [RegExp, string][] = [
  [w('tie[- ]back', 'back tie', 'ties at the back'), 'tie-back'],
  // Bare "tie" counts: Rihoas names garments "... Turtle Tie Regular Sleeve
  // Shirt" and lists `Embellishment: Tie`, and it is the "one tie" the canary
  // query asks for. The lookahead keeps "tie-dye" out, since that is a pattern
  // rather than a fastening — tie-back is matched by the rule above this one.
  [w('self[- ]tie', 'tie waist', 'tie detail', 'tie front', 'tie(?![- ]dye)'), 'self-tie'],
  [wp('drawcord', 'drawstring'), 'drawstring'],
  [w('button[- ](?:front|up|down)', 'single breasted', 'double breasted'), 'button-front'],
  [w('half[- ]button', 'henley'), 'half-button'],
  [w('zip[- ](?:up|front)', 'full zip'), 'zip-front'],
  [wp('cut[- ]?out', 'keyhole', 'hollow out'), 'cut-out'],
  [wp('slit', 'split'), 'slit'],
  [w('ruched', 'ruching', 'gathered'), 'ruched'],
  [w('smocked', 'smocking'), 'smocked'],
  [w('shirred'), 'shirred'],
  [wp('pleated', 'pleat'), 'pleated'],
  [wp('pocket', 'inseam pocket', 'patch pocket'), 'pockets'],
  [w('belted', 'belt', 'cinched'), 'belted'],
  [wp('ruffle', 'frill', 'flounce'), 'ruffle'],
  [w('lace trim', 'lace detail'), 'lace-trim'],
  [w('embroidered', 'embroidery'), 'embroidery'],
  [wp('sequin', 'sequinned'), 'sequins'],
  [wp('rhinestone', 'diamante'), 'rhinestones'],
  [wp('pearl'), 'pearls'],
  [w('backless'), 'backless'],
  [w('open[- ]back', 'low back'), 'open-back'],
  [w('corset'), 'corset-back'],
  [w('drop(?:ped)? shoulder', 'drop(?:ped)? shoulders'), 'drop-shoulder'],
  [w('puff(?:ed)? sleeve', 'puff(?:ed)? sleeves', 'balloon sleeve'), 'puff-sleeve'],
  [w('raw hem', 'frayed hem'), 'raw-hem'],
  [w('cuffed'), 'cuffed'],
  [w('elastic(?:ated)? waist', 'pull[- ]on'), 'elastic-waist'],
  [w('high[- ]low', 'asymmetric hem'), 'high-low'],
]

/** Two-word colours must be tested before their single-word components. */
const COLOR_PATTERNS: [RegExp, string][] = [
  [w('off[- ]white'), 'off-white'],
  [w('light blue', 'powder blue', 'pale blue', 'sky blue'), 'light-blue'],
  [w('multi[- ]?colou?r', 'rainbow'), 'multicolor'],
  [w('navy', 'midnight'), 'navy'],
  [w('ivory'), 'ivory'],
  [w('cream'), 'cream'],
  [w('beige', 'sand', 'oatmeal'), 'beige'],
  [w('taupe', 'tan', 'camel'), 'tan'],
  [w('brown', 'chocolate', 'espresso'), 'brown'],
  [w('black', 'noir'), 'black'],
  [w('grey', 'gray', 'charcoal', 'heather'), 'grey'],
  [w('denim'), 'denim'],
  [w('olive', 'khaki'), 'olive'],
  [w('teal'), 'teal'],
  [w('green', 'sage', 'emerald', 'forest'), 'green'],
  [w('yellow', 'butter', 'lemon'), 'yellow'],
  [w('apricot', 'peach'), 'apricot'],
  [w('orange', 'rust', 'terracotta'), 'orange'],
  [w('pink', 'blush', 'rose', 'fuchsia'), 'pink'],
  [w('wine', 'burgundy', 'maroon'), 'wine'],
  [w('red', 'crimson', 'scarlet'), 'red'],
  [w('purple', 'lilac', 'lavender', 'violet'), 'purple'],
  [w('white'), 'white'],
  [w('blue', 'cobalt', 'indigo'), 'blue'],
]

/**
 * Occasion, inferred from garment vocabulary.
 *
 * This facet carries almost all the weight for vague queries — "something cozy
 * for the weekend" has no lexical overlap with any product text, so unless the
 * occasion facet fires there is nothing for BM25 to match. Rihoas states occasion
 * outright in its KV block, but the other 198 products had it empty, which
 * measured directly as recall@120 of 0.500 on the cozy-weekend case and 0.333 on
 * the office case.
 *
 * Deliberately conservative: only vocabulary that genuinely implies a context.
 * A false occasion is worse than a missing one, because it pulls a garment into
 * queries it has no business answering.
 */
const OCCASION_PATTERNS: [RegExp, string][] = [
  [w('pyjama', 'pajama', '\\bpj\\b', 'sleep', 'lounge', 'robe', 'cozy', 'cosy',
     'sweatfleece', 'fleece', 'sweatpant', 'jogger', 'hoodie', 'sweatshirt'), 'lounge'],
  [w('swim', 'bikini', 'beach', 'surfside', 'vacation', 'resort', 'cover[- ]up',
     'poolside', 'sail'), 'beach'],
  [w('active', 'activewear', 'sport', 'training', 'workout', 'performance',
     'dry[- ]ex', 'running', 'yoga'), 'active'],
  [w('blazer', 'tailored', 'suit', 'office', 'workwear', 'trouser'), 'work'],
  [w('gown', 'formal', 'wedding', 'bridal'), 'formal'],
  [w('cocktail', 'party', 'evening', 'sequin', 'bustier', 'satin'), 'evening'],
  [w('everyday', 'essential', 'classic', 'all[- ]time', 'daily'), 'everyday'],
]

/**
 * Season, inferred from fabric weight and coverage vocabulary.
 *
 * Narrower than occasion because the signal is weaker: a linen shirt is a summer
 * garment, but a cotton t-shirt is not obviously seasonal, and guessing would
 * add noise to a facet the styling rules never consult.
 */
const SEASON_PATTERNS: [RegExp, string][] = [
  [w('fleece', 'sweatfleece', 'thermal', 'heattech', 'puffer', 'quilted',
     'wool', 'cashmere', 'parka', 'overcoat', 'turtleneck'), 'winter'],
  [w('linen', 'gauze', 'chiffon', 'seersucker', 'swim', 'bikini', 'beach',
     'sleeveless', 'tank', 'camisole', 'sundress'), 'summer'],
]

function first(patterns: [RegExp, string][], text: string): string | null {
  for (const [re, value] of patterns) if (re.test(text)) return value
  return null
}

function all(patterns: [RegExp, string][], text: string): string[] {
  const out = new Set<string>()
  for (const [re, value] of patterns) if (re.test(text)) out.add(value)
  return [...out]
}

export interface RuleAttributes {
  category: string | null
  subcategory: string | null
  neckline: string | null
  sleeve_length: string | null
  length: string | null
  rise: string | null
  fit: string | null
  silhouette: string | null
  pattern: string | null
  details: string[]
  colors: string[]
  occasion: string[]
  season: string[]
}

/**
 * Infer what can be inferred from the name and cleaned description.
 *
 * The name is weighted more heavily than the description by being searched
 * first for single-valued facets: a name saying "Mini Dress" is authoritative,
 * whereas a description mentioning "mini" may be describing a detail.
 */
export function applyRules(name: string, description: string | null): RuleAttributes {
  const n = name
  const both = `${name} ${description ?? ''}`

  const garment = GARMENT_RULES.find((r) => r.re.test(n)) ?? GARMENT_RULES.find((r) => r.re.test(both))

  // Colour comes from the name only. Descriptions mention colours the garment
  // is not ("pairs well with black"), which would poison the facet.
  const colors = all(COLOR_PATTERNS, n)

  return {
    category: garment?.category ?? null,
    subcategory: garment?.subcategory ?? null,
    neckline: first(NECKLINE_PATTERNS, n) ?? first(NECKLINE_PATTERNS, both),
    sleeve_length: first(SLEEVE_PATTERNS, n) ?? first(SLEEVE_PATTERNS, both),
    length: first(LENGTH_PATTERNS, n) ?? first(LENGTH_PATTERNS, both),
    rise: first(RISE_PATTERNS, n) ?? first(RISE_PATTERNS, both),
    fit: first(FIT_PATTERNS, n) ?? first(FIT_PATTERNS, both),
    silhouette: first(SILHOUETTE_PATTERNS, n) ?? first(SILHOUETTE_PATTERNS, both),
    pattern: first(PATTERN_PATTERNS, n) ?? first(PATTERN_PATTERNS, both),
    details: all(DETAIL_PATTERNS, both),
    colors,
    occasion: all(OCCASION_PATTERNS, both),
    season: all(SEASON_PATTERNS, both),
  }
}

/**
 * Gap keeps structured blocks in its descriptions ("Fit: Relaxed.", "Rise: High
 * rise.", "Crewneck.", "Short sleeves."). These are more reliable than the same
 * words appearing in marketing prose, so they are read directly.
 */
export function applyGapBlocks(description: string | null): Partial<RuleAttributes> {
  if (!description) return {}
  const out: Partial<RuleAttributes> = {}

  const fitBlock = description.match(/\bFit:\s*([^.]+)\./i)?.[1]
  if (fitBlock) {
    const f = first(FIT_PATTERNS, fitBlock)
    if (f) out.fit = f
    const sil = first(SILHOUETTE_PATTERNS, fitBlock)
    if (sil) out.silhouette = sil
  }

  const riseBlock = description.match(/\bRise:\s*([^.]+)\./i)?.[1]
  if (riseBlock) {
    const r = first(RISE_PATTERNS, riseBlock)
    if (r) out.rise = r
  }

  // Gap states these as bare sentences: "Crewneck." x9, "Short sleeves." x8,
  // "Sleeveless." x7, "Button front." x8.
  const neck = first(NECKLINE_PATTERNS, description)
  if (neck) out.neckline = neck
  const sleeve = first(SLEEVE_PATTERNS, description)
  if (sleeve) out.sleeve_length = sleeve

  return out
}

/** Uniqlo encodes the colourway in the name variant: "Mini T-Shirt | Striped". */
export function patternFromVariant(variant: string | null): string | null {
  if (!variant) return null
  return first(PATTERN_PATTERNS, variant)
}

export function colorsFromText(text: string): string[] {
  return all(COLOR_PATTERNS, text)
}

export const KNOWN_COLORS: readonly string[] = COLORS
