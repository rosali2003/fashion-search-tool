/**
 * Material string parser.
 *
 * Four brands publish fibre content in four different dialects, and the scraped
 * field is sometimes not a material string at all. Rather than branching on
 * brand — which means every new brand needs new code — this dispatches on the
 * *shape* of the string, so a fifth brand using either token order works free.
 *
 * Real inputs from the corpus, all of which must parse:
 *
 *   aritzia  "78% cotton, 22% polyester, exclusive of ornamentation"
 *   gap      "95% Cotton, 5% Spandex"
 *   gap      "1% Elastane"                      <- scraper truncation, sums to 1%
 *   uniqlo   "96% Cotton, 4% Spandex Imported"
 *   uniqlo   "[00 WHITE] Shell: 96% Cotton, 4% Spandex/ Lining: 95% Cotton,
 *             5% Spandex/ Cup ( Inner Lining ): 100% Polyester [Other Colors] ..."
 *   rihoas   "Polyester 65.0%, Nylon 35.0%"     <- percent AFTER fibre
 *   rihoas   "Polyester"                        <- bare, implies 100%
 *   rihoas   "Chiffon"                          <- a FABRIC, not a fibre
 *   aritzia  "This is a strapless babydoll dress with a smocked bodice and
 *             tie detail at the back..."        <- prose; 8 products like this
 */

import { FABRIC, NATURAL_FIBERS } from './vocab.js'

export interface FiberEntry {
  fiber: string
  pct: number | null
  component: string
  recycled?: boolean
  organic?: boolean
}

export interface ParsedMaterial {
  fibers: FiberEntry[]
  fiberNames: string[]
  fabric: string[]
  /** Colourway markers harvested from Uniqlo's "[00 WHITE]" prefixes. */
  colors: string[]
  /** Natural share of the main component, 0..1. Null when unknowable. */
  naturalRatio: number | null
  primaryFiber: string | null
  /** Main-component percentages sum below 90 — keep what we have, invent nothing. */
  incomplete: boolean
  /** Canonical re-render, sorted by percentage descending. The UI badge. */
  clean: string | null
  /** Set when the field held a description instead of a material. */
  prose: string | null
}

/** Surface form -> canonical fibre. */
const FIBER_ALIASES: Record<string, string> = {
  spandex: 'elastane',
  'spandex(elastane)': 'elastane',
  'spandex (elastane)': 'elastane',
  elastane: 'elastane',
  lycra: 'elastane',
  stretch: 'elastane',
  polyamide: 'nylon',
  nylon: 'nylon',
  rayon: 'viscose',
  viscose: 'viscose',
  visocse: 'viscose', // a real typo in the Gap data
  tencel: 'lyocell',
  'tencel lyocell': 'lyocell',
  'tencel™ lyocell': 'lyocell',
  lyocell: 'lyocell',
  modal: 'modal',
  cupro: 'cupro',
  flax: 'linen',
  linen: 'linen',
  cotton: 'cotton',
  'organic cotton': 'cotton',
  'recycled cotton': 'cotton',
  'supima cotton': 'cotton',
  polyester: 'polyester',
  'recycled polyester': 'polyester',
  wool: 'wool',
  merino: 'wool',
  'merino wool': 'wool',
  'lambswool': 'wool',
  cashmere: 'cashmere',
  silk: 'silk',
  acrylic: 'acrylic',
  acetate: 'acetate',
  'triacetate': 'acetate',
  leather: 'leather',
  'polyurethane': 'other',
  'pu': 'other',
}

/** Non-textile materials, mostly Rihoas jewellery. Recorded, but not fibres. */
const NON_TEXTILE = new Set([
  'brass', 'titanium steel', 'stainless steel', 'steel', 'alloy',
  'zinc alloy', 'resin', 'glass', 'copper', 'silver', 'gold',
])

const FABRIC_SET = new Set<string>(FABRIC)
const NATURAL_SET = new Set<string>(NATURAL_FIBERS)

/** Multi-word fabrics must be tested before single-word ones. */
const FABRIC_ALIASES: Record<string, string> = {
  'worsted woven': 'worsted',
  'worsted': 'worsted',
  'knitted': 'knit',
  'knit': 'knit',
  'rib knit': 'rib',
  'ribbed': 'rib',
  'sweat fleece': 'sweatfleece',
  'sweatfleece': 'sweatfleece',
  'georgette': 'chiffon',
  'sateen': 'satin',
}

const COMPONENT_LABELS = [
  'shell', 'body', 'main', 'outer', 'lining', 'liner', 'rib', 'binder-processed part',
  'cup ( inner lining )', 'cup (inner lining)', 'cup', 'trim', 'contrast', 'insert',
]

/** Trailing noise that carries no fibre information. */
const JUNK_PATTERNS = [
  /exclusive of ornamentation/gi,
  /exclusive of decoration/gi,
  /\bimported\b/gi,
  /\bmade in [a-z ]+/gi,
  /\bdry clean only\b/gi,
  /\bhand wash\b/gi,
  /\bmachine wash\b/gi,
  // Two Uniqlo bra products prefix the whole fibre breakdown with this.
  /this item ships with one of the below options\.?\s*note that you cannot specify a preference at this time\.?/gi,
]

function stripJunk(s: string): string {
  let out = s
  for (const p of JUNK_PATTERNS) out = out.replace(p, ' ')
  return out.replace(/\s+/g, ' ').trim()
}

function countPercentages(s: string): number {
  return (s.match(/\d+(?:\.\d+)?\s*%/g) ?? []).length
}

/**
 * Does this look like a description rather than a material?
 *
 * Several Aritzia products have prose in the material field; rendering that as
 * a badge would put a paragraph on a product card. But prose is not
 * automatically useless — "made with Mighty Cotton™ — heavyweight 100% cotton
 * jersey" carries real fibre content worth recovering.
 *
 * So the percentage count decides. Two or more means a structured fibre
 * breakdown (possibly behind a preamble, as two Uniqlo bra products have), and
 * it is parsed as a material. One or zero in a long sentence-like string means
 * prose: the raw text never becomes the badge, but fibres are still extracted
 * from it, and `clean` is re-rendered short from whatever was found.
 */
function looksLikeProse(s: string): boolean {
  if (countPercentages(s) >= 2) return false
  const words = s.trim().split(/\s+/)
  if (words.length <= 12) return false
  // Sentence-like: a verb phrase or an article early on.
  return /\b(this|it|the|a|an|is|are|has|with|features|made)\b/i.test(s)
}

function canonicalFiber(raw: string): { fiber: string; recycled: boolean; organic: boolean } | null {
  let s = raw.toLowerCase().replace(/[™®]/g, '').replace(/\s+/g, ' ').trim()
  s = s.replace(/^(?:and|&)\s+/, '')
  const recycled = /\brecycled\b/.test(s)
  const organic = /\borganic\b/.test(s)

  if (FIBER_ALIASES[s]) return { fiber: FIBER_ALIASES[s], recycled, organic }

  // Strip qualifiers and retry, so "recycled polyester fiber" resolves.
  const stripped = s
    .replace(/\b(recycled|organic|uses|fiber|fibre|certified|premium|soft|brushed)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (FIBER_ALIASES[stripped]) return { fiber: FIBER_ALIASES[stripped], recycled, organic }

  // Last resort: a known fibre appearing as a token inside a longer phrase.
  for (const [alias, canon] of Object.entries(FIBER_ALIASES)) {
    if (alias.includes(' ')) continue
    if (new RegExp(`\\b${alias}\\b`).test(stripped)) return { fiber: canon, recycled, organic }
  }
  return null
}

function canonicalFabric(raw: string): string | null {
  const s = raw.toLowerCase().replace(/\s+/g, ' ').trim()
  if (FABRIC_ALIASES[s]) return FABRIC_ALIASES[s]
  if (FABRIC_SET.has(s)) return s
  for (const [alias, canon] of Object.entries(FABRIC_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(s)) return canon
  }
  for (const f of FABRIC_SET) {
    if (new RegExp(`\\b${f}\\b`).test(s)) return f
  }
  return null
}

/** Harvest and remove Uniqlo colourway markers: "[00 WHITE]", "[Other Colors]". */
function extractColorMarkers(s: string): { text: string; colors: string[] } {
  const colors: string[] = []
  const text = s.replace(/\[([^\]]+)\]/g, (_m, inner: string) => {
    for (const part of inner.split(',')) {
      const cleaned = part.replace(/\d+/g, '').trim().toLowerCase()
      if (cleaned && !/other colors?/i.test(cleaned)) colors.push(cleaned)
    }
    return ' | ' // a component boundary, so later variants don't merge
  })
  return { text, colors: [...new Set(colors)] }
}

/**
 * Split into labelled components. Only the first variant block is canonical:
 * Uniqlo lists a full fibre breakdown per colourway, and merging them would
 * double-count.
 */
function splitComponents(s: string): { component: string; text: string }[] {
  // Two complications, both real:
  //   - Uniqlo's colourway marker is often the very first token ("[00 WHITE]
  //     Shell: ..."), so extractColorMarkers leaves a leading boundary and
  //     split('|')[0] is empty.
  //   - Two Uniqlo bra products put a prose preamble before the first marker,
  //     so the first non-empty segment is a sentence with no fibres in it.
  // Prefer the first segment that actually carries a percentage.
  const segments = s.split('|').map((p) => p.trim()).filter((p) => p.length > 0)
  const firstVariant = segments.find((p) => /\d+(?:\.\d+)?\s*%/.test(p)) ?? segments[0] ?? s
  const labelAlt = COMPONENT_LABELS.map((l) => l.replace(/[()]/g, '\\$&')).join('|')
  const re = new RegExp(`(${labelAlt})\\s*:`, 'gi')

  const marks: { label: string; at: number; len: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(firstVariant)) !== null) {
    marks.push({ label: m[1].toLowerCase(), at: m.index, len: m[0].length })
  }

  if (marks.length === 0) return [{ component: 'main', text: firstVariant }]

  const out: { component: string; text: string }[] = []
  if (marks[0].at > 0) {
    const pre = firstVariant.slice(0, marks[0].at).trim()
    if (pre) out.push({ component: 'main', text: pre })
  }
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : firstVariant.length
    const body = firstVariant.slice(mark.at + mark.len, end)
    const isMain = /^(shell|body|main|outer)$/.test(mark.label)
    out.push({ component: isMain ? 'main' : mark.label, text: body })
  })
  return out
}

/**
 * Capture the percentage plus a bounded run of following word characters, then
 * let canonicalFiber find a known fibre token inside it. Deliberately no
 * closing lookahead: an earlier version required the phrase to end at a comma,
 * slash or digit, which silently failed on prose like "100% cotton jersey with
 * a soft-structured feel" where the fibre is followed by ordinary words. The
 * character class excludes commas, colons, slashes and dashes-as-separators, so
 * a run still stops before the next component or fibre.
 */
const PCT_FIRST = /(\d+(?:\.\d+)?)\s*%\s*([A-Za-z][A-Za-z™®()\s-]{0,40})/g
const PCT_LAST = /([A-Za-z][A-Za-z™®()\s-]{0,30}?)\s*(\d+(?:\.\d+)?)\s*%/g

function parseComponent(text: string, component: string): FiberEntry[] {
  const out: FiberEntry[] = []
  const seen = new Set<string>()

  const push = (rawName: string, pct: number | null) => {
    const hit = canonicalFiber(rawName)
    if (!hit) return
    const key = `${hit.fiber}:${component}`
    if (seen.has(key)) return
    seen.add(key)
    const entry: FiberEntry = { fiber: hit.fiber, pct, component }
    if (hit.recycled) entry.recycled = true
    if (hit.organic) entry.organic = true
    out.push(entry)
  }

  // Shape 1: "96% Cotton"
  PCT_FIRST.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PCT_FIRST.exec(text)) !== null) {
    push(m[2], Number.parseFloat(m[1]))
  }

  // Shape 2: "Polyester 65.0%". Only if shape 1 found nothing, so a string is
  // never read in both directions.
  if (out.length === 0) {
    PCT_LAST.lastIndex = 0
    while ((m = PCT_LAST.exec(text)) !== null) {
      push(m[1], Number.parseFloat(m[2]))
    }
  }

  // Shape 3: bare fibre, no percentage. Implies 100%, but only when the whole
  // remaining string is one or two known fibre tokens — otherwise a stray word
  // in prose would become a fibre claim.
  if (out.length === 0) {
    const bare = stripJunk(text).replace(/[.,;]/g, '').trim()
    if (bare && bare.split(/\s+/).length <= 3 && !FABRIC_SET.has(bare.toLowerCase())) {
      const hit = canonicalFiber(bare)
      if (hit) push(bare, 100)
    }
  }

  return out
}

export function parseMaterial(raw: string | null | undefined): ParsedMaterial {
  const empty: ParsedMaterial = {
    fibers: [], fiberNames: [], fabric: [], colors: [],
    naturalRatio: null, primaryFiber: null, incomplete: false,
    clean: null, prose: null,
  }
  if (!raw || !raw.trim()) return empty

  const input = raw.replace(/\s+/g, ' ').trim()

  // Several Aritzia rows hold a description here. Record it so the caller can
  // relocate it to the description and never render it as a badge — but keep
  // going, because prose can still name a fibre ("heavyweight 100% cotton").
  // `clean` is always re-rendered from parsed fibres, never from this string.
  const prose = looksLikeProse(input) ? input : null

  const { text: noColors, colors } = extractColorMarkers(input)

  // "( 35% Uses Recycled Polyester Fiber )" is a claim about a fibre already
  // listed, not an extra component. Note it, then drop it.
  const recycledClaim = /\(\s*\d+\s*%\s*uses recycled[^)]*\)/i.test(noColors)
  const noParens = noColors.replace(/\(\s*\d+\s*%\s*uses recycled[^)]*\)/gi, ' ')

  const cleanedInput = stripJunk(noParens)

  const fibers: FiberEntry[] = []
  const fabric = new Set<string>()

  // A single variant block can repeat a component label: Uniqlo's bra products
  // list "Shell: 67% Polyester ... Shell: 71% Polyester" for two colourways with
  // no bracket marker between them. The first occurrence of each
  // (fibre, component) pair is canonical, so later repeats are dropped rather
  // than appended — otherwise the main component's percentages sum past 100 and
  // naturalRatio is computed over a double-counted total.
  const seenPairs = new Set<string>()
  for (const { component, text } of splitComponents(cleanedInput)) {
    for (const entry of parseComponent(text, component)) {
      const key = `${entry.fiber}:${entry.component}`
      if (seenPairs.has(key)) continue
      seenPairs.add(key)
      fibers.push(entry)
    }
    const fab = canonicalFabric(text)
    if (fab) fabric.add(fab)
  }

  // Non-textile materials (Rihoas jewellery) register as 'other'.
  const lower = cleanedInput.toLowerCase()
  let nonTextile = false
  for (const nt of NON_TEXTILE) {
    if (new RegExp(`\\b${nt}\\b`).test(lower)) {
      nonTextile = true
      if (!fibers.some((f) => f.fiber === 'other')) {
        fibers.push({ fiber: 'other', pct: null, component: 'main' })
      }
      break
    }
  }

  if (recycledClaim) {
    const poly = fibers.find((f) => f.fiber === 'polyester')
    if (poly) poly.recycled = true
  }

  const main = fibers.filter((f) => f.component === 'main' && f.pct !== null)
  const mainTotal = main.reduce((s, f) => s + (f.pct ?? 0), 0)
  const incomplete = main.length > 0 && mainTotal < 90

  let naturalRatio: number | null = null
  if (main.length > 0 && mainTotal > 0 && !incomplete) {
    const nat = main
      .filter((f) => NATURAL_SET.has(f.fiber))
      .reduce((s, f) => s + (f.pct ?? 0), 0)
    naturalRatio = Math.round((nat / mainTotal) * 1000) / 1000
  } else if (nonTextile && main.length === 0) {
    naturalRatio = null
  }

  // Primary fibre is the largest main-component share, but only when the
  // breakdown is trustworthy. "1% Elastane" must not report elastane as primary.
  const primaryFiber = incomplete
    ? null
    : ([...main].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0]?.fiber ?? null)

  const clean = main.length
    ? [...main]
        .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
        .map((f) => `${f.pct}% ${f.fiber}`)
        .join(', ')
    : fibers.length
      ? [...new Set(fibers.map((f) => f.fiber))].join(', ')
      : null

  return {
    fibers,
    fiberNames: [...new Set(fibers.map((f) => f.fiber))],
    fabric: [...fabric],
    colors,
    naturalRatio,
    primaryFiber,
    incomplete,
    clean,
    prose,
  }
}
