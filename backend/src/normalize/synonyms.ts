/**
 * Canonical vocabulary term -> surface forms.
 *
 * This file is the single most load-bearing piece of the retrieval system.
 * BM25 is purely lexical: it can only match words that are literally present.
 * A user typing "high collar" against a product whose copy says "turtle neck"
 * scores zero on that term, no matter how well-tuned the index is.
 *
 * Two consumers, pulling in opposite directions and meeting in the middle:
 *
 *   - render.ts emits every synonym of every extracted attribute into
 *     `search_attrs` at ingest, so the *document* carries all surface forms.
 *   - the query expander uses the same map as a grounding vocabulary, so the
 *     *query* is rewritten into terms the documents actually use.
 *
 * Measured impact on the canary query "cotton tie-back shirt, high collar, one
 * tie": raw BM25 ranks the best available match (rihoas | Off White Turtle Tie
 * Regular Sleeve Shirt) at #13, because its top hits are bikinis that merely
 * repeat the token "tie". With `high collar -> turtle, mock neck, funnel neck,
 * mandarin collar` expansion it reaches #2. That single mapping is the
 * difference between the flagship query working and not.
 */

export const SYNONYMS: Record<string, readonly string[]> = {
  // -- Neckline. The highest-value group: necklines have the most divergent
  //    vernacular between how shoppers talk and how brands write.
  'mock-neck': ['mock neck', 'high neck', 'high collar', 'funnel neck', 'stand collar', 'band collar'],
  // "high neck" and "high collar" belong here as well as under mock-neck: a
  // turtleneck is a form of high neckline, and a shopper typing "high collar"
  // means either. Omitting them cost the canary query its target — the phrase
  // matched the HEATTECH mock-neck tees and the turtle shirt scored nothing on it.
  turtleneck: [
    'turtleneck', 'turtle neck', 'turtle', 'roll neck', 'polo neck',
    'high neck', 'high collar',
  ],
  'mandarin-collar': ['mandarin collar', 'chinese collar', 'band collar', 'stand collar'],
  'v-neck': ['v neck', 'v-neck', 'vee neck'],
  plunge: ['plunge', 'plunging', 'deep v', 'low cut'],
  sweetheart: ['sweetheart', 'sweetheart neck'],
  boat: ['boat neck', 'bateau', 'wide neck'],
  crew: ['crew neck', 'crewneck', 'round neck', 'round neckline'],
  scoop: ['scoop neck', 'scooped', 'u neck'],
  'u-neck': ['u neck', 'u-neck', 'deep scoop'],
  square: ['square neck', 'square neckline'],
  halter: ['halter', 'halterneck', 'halter neck', 'tie neck'],
  'off-shoulder': ['off shoulder', 'off-the-shoulder', 'bardot'],
  'one-shoulder': ['one shoulder', 'asymmetric neckline', 'single strap'],
  strapless: ['strapless', 'bandeau', 'tube'],
  cowl: ['cowl neck', 'draped neck'],
  collared: ['collared', 'shirt collar', 'point collar', 'button down collar'],
  collarless: ['collarless', 'no collar'],

  // -- Silhouette and fit
  oversized: ['oversized', 'roomy', 'slouchy', 'boyfriend', 'baggy', 'loose'],
  relaxed: ['relaxed', 'easy', 'loose', 'comfortable', 'not fitted'],
  fitted: ['fitted', 'body skimming', 'close to body', 'snug'],
  bodycon: ['bodycon', 'body con', 'second skin', 'clingy'],
  boxy: ['boxy', 'square cut', 'straight cut'],
  'a-line': ['a-line', 'a line', 'fit and flare', 'flared', 'skater'],
  sheath: ['sheath', 'column', 'pencil'],
  mermaid: ['mermaid', 'trumpet', 'fishtail'],
  wrap: ['wrap', 'wrapped', 'surplice', 'crossover'],
  shift: ['shift', 'unstructured', 'straight shift'],
  'wide-leg': ['wide leg', 'wide-leg', 'palazzo', 'flowy leg'],
  tapered: ['tapered', 'narrow leg', 'carrot'],
  bubble: ['bubble', 'balloon', 'puffball'],

  // -- Length
  cropped: ['cropped', 'crop', 'mini length', 'baby tee', 'shrunken'],
  mini: ['mini', 'short', 'above the knee', 'thigh length'],
  midi: ['midi', 'mid length', 'below the knee', 'calf length'],
  maxi: ['maxi', 'full length', 'floor length', 'ankle length', 'long'],
  longline: ['longline', 'extended length', 'tunic length'],

  // -- Rise
  'high-rise': ['high rise', 'high-rise', 'high waisted', 'high waist', 'hi rise'],
  'mid-rise': ['mid rise', 'mid-rise', 'natural waist'],
  'low-rise': ['low rise', 'low-rise', 'low waisted', 'hip slung'],

  // -- Sleeves
  sleeveless: ['sleeveless', 'no sleeves', 'tank', 'shell'],
  cap: ['cap sleeve', 'capped sleeve'],
  'three-quarter': ['three quarter', '3/4 sleeve', '3/4 length sleeve', 'bracelet sleeve'],
  short: ['short sleeve', 'short sleeves'],
  long: ['long sleeve', 'long sleeves', 'full sleeve'],

  // -- Construction details. `tie-back` is the canary query's key term and does
  //    not appear literally on any product in the corpus, so its surface forms
  //    are what give the query anything to match at all.
  'tie-back': ['tie back', 'tie-back', 'back tie', 'ties at the back', 'self tie back', 'bow back'],
  'self-tie': ['self tie', 'self-tie', 'tie waist', 'tie detail', 'tie front', 'tie'],
  'open-back': ['open back', 'low back', 'exposed back'],
  backless: ['backless', 'open back', 'no back'],
  'corset-back': ['corset back', 'lace up back', 'corset'],
  'cut-out': ['cut out', 'cut-out', 'cutout', 'keyhole'],
  slit: ['slit', 'split', 'side slit', 'thigh slit'],
  ruched: ['ruched', 'ruching', 'gathered', 'shirred'],
  smocked: ['smocked', 'smocking', 'elasticated bodice'],
  pleated: ['pleated', 'pleats', 'accordion'],
  belted: ['belted', 'belt', 'cinched waist', 'defined waist'],
  'drop-shoulder': ['drop shoulder', 'dropped shoulder', 'dropped shoulders'],
  'puff-sleeve': ['puff sleeve', 'puffed sleeve', 'balloon sleeve'],
  'button-front': ['button front', 'button up', 'button down', 'buttoned'],
  'half-button': ['half button', 'henley', 'partial placket'],
  'zip-front': ['zip front', 'zip up', 'full zip', 'zipper front'],
  pockets: ['pockets', 'pocket', 'inseam pockets', 'patch pockets'],
  'elastic-waist': ['elastic waist', 'elasticated waist', 'pull on'],
  drawstring: ['drawstring', 'draw cord', 'tie cord'],
  'raw-hem': ['raw hem', 'unfinished hem', 'frayed hem'],
  ruffle: ['ruffle', 'ruffled', 'frill', 'flounce'],
  'lace-trim': ['lace trim', 'lace detail', 'lace edging'],

  // -- Pattern
  solid: ['solid', 'plain', 'block colour', 'block color'],
  striped: ['striped', 'stripe', 'stripes', 'pinstripe'],
  floral: ['floral', 'flowers', 'flower print', 'botanical'],
  'polka-dot': ['polka dot', 'polka-dot', 'spotted', 'dotted'],
  plaid: ['plaid', 'tartan', 'check', 'checked'],
  animal: ['animal print', 'leopard', 'zebra', 'snake print'],
  colorblock: ['colorblock', 'colour block', 'color block'],
  ribbed: ['ribbed', 'rib', 'ribbing'],
  textured: ['textured', 'texture', 'waffle', 'crinkle'],

  // -- Fibre. Users say "stretchy"; labels say "elastane" or "spandex".
  elastane: ['elastane', 'spandex', 'lycra', 'stretch', 'stretchy'],
  lyocell: ['lyocell', 'tencel'],
  viscose: ['viscose', 'rayon'],
  linen: ['linen', 'flax'],
  cotton: ['cotton', 'organic cotton'],
  wool: ['wool', 'merino', 'woollen'],
  cashmere: ['cashmere', 'kashmir'],
  silk: ['silk', 'mulberry silk'],
  nylon: ['nylon', 'polyamide'],

  // -- Fabric
  denim: ['denim', 'jean', 'chambray'],
  jersey: ['jersey', 't-shirt fabric', 'knit jersey'],
  chiffon: ['chiffon', 'sheer', 'georgette'],
  satin: ['satin', 'sateen', 'silky', 'shiny'],
  fleece: ['fleece', 'sweatfleece', 'brushed back'],
  corduroy: ['corduroy', 'cord', 'wale'],
  velvet: ['velvet', 'velour'],

  // -- Occasion. These carry most of the load for vague queries like
  //    "something cozy for the weekend", which have no other lexical anchor.
  everyday: ['everyday', 'daily', 'casual', 'weekend', 'easy'],
  work: ['work', 'office', 'workwear', 'professional', 'business'],
  evening: ['evening', 'night out', 'going out', 'party', 'cocktail'],
  formal: ['formal', 'black tie', 'wedding', 'special occasion'],
  beach: ['beach', 'vacation', 'holiday', 'resort', 'poolside'],
  lounge: ['lounge', 'loungewear', 'cozy', 'cosy', 'comfy', 'relaxing', 'home'],
  active: ['active', 'activewear', 'workout', 'gym', 'performance', 'training'],
}

/**
 * All surface forms for a canonical term, the term itself always included.
 * Unknown terms pass through as themselves rather than vanishing — a facet
 * value with no synonym entry should still be searchable.
 */
export function expand(term: string): string[] {
  const forms = SYNONYMS[term]
  if (!forms) return [term.replace(/-/g, ' ')]
  return [...new Set([term.replace(/-/g, ' '), ...forms])]
}

/** Expand many terms into one de-duplicated, space-joined string for indexing. */
export function expandAll(terms: readonly (string | null | undefined)[]): string {
  const out = new Set<string>()
  for (const t of terms) {
    if (!t) continue
    for (const form of expand(t)) out.add(form)
  }
  return [...out].join(' ')
}
