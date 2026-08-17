/**
 * Shared helpers for the scrapers that read structured data off a product page.
 *
 * Five of the nine retailers publish schema.org product data, so the JSON-LD
 * reader that used to live inside gap.ts is here instead. The `@type` is a
 * parameter because the shape is not consistent across retailers: Gap, Madewell
 * and Reformation emit a plain `Product`, while Skims emits a `ProductGroup`
 * whose `hasVariant` array is the only place sizes appear.
 */

/** One schema.org offer. Retailers disagree on whether this is an object or an array. */
export interface JsonLdOffer {
  price?: string | number
  priceCurrency?: string
  size?: string
  color?: string
  availability?: string
  sku?: string
}

/** A schema.org Product or ProductGroup, narrowed to the fields the scrapers read. */
export interface JsonLdProduct {
  '@type': string | string[]
  name?: string
  description?: string
  sku?: string
  mpn?: string
  color?: string
  /** Set on ProductGroup variants — the size that variant represents. */
  size?: string
  image?: string | string[]
  url?: string
  offers?: JsonLdOffer | JsonLdOffer[]
  /** ProductGroup only — each variant is a Product with its own `size` and `offers`. */
  hasVariant?: JsonLdProduct[]
  /** Product only — points back at the group, and sometimes carries `hasVariant`. */
  isVariantOf?: JsonLdProduct
}

/** `@type` may be a bare string or an array (Madewell emits `['Corporation','Brand',…]`). */
function hasType(node: unknown, wanted: string): boolean {
  if (typeof node !== 'object' || node === null) return false
  const t = (node as { '@type'?: unknown })['@type']
  if (typeof t === 'string') return t === wanted
  if (Array.isArray(t)) return t.includes(wanted)
  return false
}

/**
 * Find the first node of the given `@type` across every JSON-LD block on a page.
 *
 * Retailers put several blocks on a page (Madewell serves eleven, most of them
 * Organization boilerplate) and any one of them may be malformed, so a bad block
 * is skipped rather than failing the product.
 */
export function readJsonLd(blocks: string[], type = 'Product'): JsonLdProduct | null {
  for (const raw of blocks) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue // malformed block — the page usually has another
    }
    // A block may be a single node, an array of nodes, or an @graph wrapper.
    const candidates: unknown[] = Array.isArray(parsed)
      ? parsed
      : [parsed, ...((parsed as { '@graph'?: unknown[] })?.['@graph'] ?? [])]

    const found = candidates.find((c) => hasType(c, type))
    if (found) return found as JsonLdProduct
  }
  return null
}

/** Pull the JSON-LD blocks out of raw HTML, for the scrapers that never open a browser. */
export function jsonLdBlocksFromHtml(html: string): string[] {
  const out: string[] = []
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m[1].trim())
  return out
}

/** Normalise `offers` to an array — it is an object for single-variant products. */
export function offerList(offers: JsonLdProduct['offers']): JsonLdOffer[] {
  if (!offers) return []
  return Array.isArray(offers) ? offers : [offers]
}

/**
 * Fibre composition, e.g. "97% cotton, 3% elastane".
 *
 * Previously duplicated in aritzia.ts and gap.ts in two slightly different forms.
 * The trailing run captures the second fibre in a pair, which is why it is
 * greedy at all — "95% Cotton" alone loses the blend.
 *
 * That tail excludes quotes, backslashes and brackets rather than just newline
 * and full stop. Skims embeds its composition inside a JSON payload in the page
 * source, so the looser tail ran straight through the delimiters and yielded
 * `95% Cotton / 5% Elastane\",\"Imported\",\"Machine` as the material.
 *
 * Up to two words may sit between the percentage and the fibre name, because
 * brands trademark their fibres: "97% Supima® Cotton, 3% Elastane" used to match
 * only the `3% Elastane` tail, silently reporting a trace fibre as the whole
 * composition. The `(?!\s*off\b)` guard is what keeps that looseness safe —
 * without it "30% off" plus any later fibre word becomes a false composition,
 * and retail pages are full of "30% off".
 *
 * French fibre names are in the list because Sézane publishes its compositions
 * in French even on the US storefront ("92% coton, 3% polyester, 5% elasthanne").
 * Without them the match started at the polyester and reported a trace fibre as
 * the whole garment.
 */
export const FIBER_RE =
  /\d{1,3}%(?!\s*off\b)\s*(?:[A-Za-z®™-]+[^\S\n]+){0,2}(?:cotton|coton|polyester|nylon|spandex|[ée]lasthanne|elastane|wool|laine|linen|lin|viscose|rayon|lyocell|modal|acrylic|acrylique|tencel|silk|soie|cashmere|cachemire|polyamide)[^\n."'\\<>{}[\]]{0,40}/i

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  deg: '°',
}

/**
 * Decode the HTML entities that survive into structured data.
 *
 * Madewell's JSON-LD description contains a literal `&mdash;`, and Reformation's
 * model-height sentence contains `&quot;` where the inches mark should be —
 * which `parseHeightCm` cannot match until it is decoded.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
}

/** Strip tags and collapse whitespace. Shared by every HTML-description reader. */
export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/**
 * Read a fibre composition out of arbitrary product copy. Null when absent.
 *
 * The trailing separator is trimmed because the regex stops mid-list when the
 * next character is a delimiter, leaving strings like "95% Cotton /".
 */
export function extractFibers(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.match(FIBER_RE)
  if (!m) return null
  const cleaned = m[0]
    // The 40-character tail runs past the end of the composition and into
    // whatever copy follows it — origin and care lines, most often.
    .split(/\s(?:Made in|Imported|Machine wash|Hand wash|Dry clean|Environmental)\b/i)[0]
    .trim()
    .replace(/[\s,;/|·-]+$/, '')
    .trim()
  return cleaned || null
}
