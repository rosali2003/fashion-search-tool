/**
 * Reformation scraper — sitemap + JSON-LD, no browser needed.
 *
 * thereformation.com is Salesforce Commerce Cloud. Plain HTTP gets the fully
 * server-rendered PDP, which carries a schema.org Product block with one offer
 * per size, so name / description / price / sizes all come from structured data.
 *
 * robots.txt disallows /api and /on/demandware.store/* — the Demandware AJAX
 * endpoints are deliberately NOT used here. Only PDPs are fetched, which robots
 * permits.
 *
 * This is the second brand after Uniqlo with real fit data: the page copy
 * carries "The model is wearing a size 2 and is 5'9.5", 25" waist, ..." which
 * gives model_height_cm, model_size and fit_notes.
 */

import { parsePrice, saveProducts, sleep, downloadImages } from './utils.js'
import { normalizeSizes, parseHeightCm } from './types.js'
import {
  readJsonLd,
  jsonLdBlocksFromHtml,
  offerList,
  stripHtml,
  decodeEntities,
  extractFibers,
} from './jsonld.js'
import type { ScrapedProduct } from './types.js'

const BRAND = 'reformation'
const BASE_URL = 'https://www.thereformation.com'
const SITEMAP_URL = `${BASE_URL}/sitemap_0-product.xml`
const MAX_PRODUCTS = 100

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  Referer: `${BASE_URL}/`,
}

/**
 * Reformation ships Demandware size codes zero-padded to three characters:
 * `0XS`, `00S`, `00M`, `00L`, `0XL`. Passed through raw, every letter size is
 * rejected by normalizeSize and the product lands with an empty size_range —
 * which is how the Winslow Dress came back with 0 sizes despite offering five.
 *
 * Numeric sizes are also zero-padded (`000`, `002`) but must be kept intact:
 * those ARE the size. So only codes containing a letter are unpadded.
 */
function unpadSizeCode(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim().toUpperCase()
  return /^0+[A-Z]+$/.test(s) ? s.replace(/^0+/, '') : s
}

/**
 * Reformation sells more than clothing. Matched against the URL slug, which is
 * hyphen-delimited, so the terms are anchored on hyphens rather than \b.
 */
const SKIP_SLUG_RE =
  /gift-card|candle|perfume|fragrance|shoe|sneaker|boot|sandal|heel|clog|loafer|mule|-bag|tote|jewelry|earring|necklace|bracelet|beanie|-hat|scarf|sock|glove|belt|sunglass/i

// ── Sitemap ───────────────────────────────────────────────────────────────────

async function collectProductUrls(limit: number): Promise<string[]> {
  console.log(`Fetching sitemap ${SITEMAP_URL}`)
  const res = await fetch(SITEMAP_URL, { headers: COMMON_HEADERS })
  if (!res.ok) throw new Error(`sitemap returned HTTP ${res.status}`)
  const xml = await res.text()

  const all = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim())
  const urls = all.filter((u) => /\/products\/[^/]+\/\d+\.html$/.test(u) && !SKIP_SLUG_RE.test(u))

  console.log(`  ${all.length} sitemap entries, ${urls.length} after filtering`)
  return urls.slice(0, limit)
}

// ── Fit data ──────────────────────────────────────────────────────────────────

/**
 * "The model is wearing a size 2 and is 5'9.5", 25" waist, 36" hips, 34" bust."
 *
 * The inches marks arrive as `&quot;` in the raw HTML, so the caller must decode
 * entities before this runs or parseHeightCm has nothing to match on.
 */
const MODEL_RE = /(?:the\s+)?model is wearing a size ([\w.]+)[^.]{0,120}/i

interface ModelFit {
  heightCm: number | null
  size: string | null
  notes: string | null
}

function readModelFit(text: string): ModelFit {
  const m = text.match(MODEL_RE)
  if (!m) return { heightCm: null, size: null, notes: null }

  const sentence = m[0].trim()
  return {
    heightCm: parseHeightCm(sentence),
    size: m[1] ? m[1].trim() : null,
    notes: sentence.slice(0, 400),
  }
}

// ── Images ────────────────────────────────────────────────────────────────────

/**
 * Gallery assets look like
 *   media.thereformation.com/image/upload/<transform>/PRD-SFCC/<id>/<COLOR>/<id>.<N>.<COLOR>
 *
 * The same shot appears under several transform prefixes (dpr_1.0/w_800,
 * dpr_2.0/w_500, dpr_auto/w_500 …) — 27 raw URLs collapsed to 4 real photos on
 * the product measured. Deduping on the trailing `<id>.<N>.<COLOR>` segment is
 * what makes the count honest, and requesting one large transform makes the
 * downloaded file worth using.
 */
const LARGE_TRANSFORM = 'f_auto,q_auto,dpr_2.0/w_1200'

/** The colour segment of a PRD-SFCC asset path, e.g. …/0103940/BELLFLOWER/… -> BELLFLOWER. */
function assetColor(url: string): string | null {
  return url.match(/\/PRD-SFCC\/[^/]+\/([^/]+)\//)?.[1] ?? null
}

/**
 * @param preferredColor colour of the JSON-LD primary image.
 *
 * Filtering by style id alone is not enough: a PDP references every colourway of
 * the style, and some of those have no published assets at all. The Violet Top
 * page cites a MADAME colourway whose images 404 at every index and every
 * transform, so a style-only filter produced a gallery whose first shot was
 * permanently broken. Pinning to the colour of the canonical image keeps the
 * gallery to the colourway this row actually represents.
 */
function galleryImages(html: string, styleId: string, preferredColor: string | null): string[] {
  const urls = [
    ...new Set(
      [...html.matchAll(/https:\/\/media\.thereformation\.com\/image\/upload\/[^"'\\\s)&]+/gi)].map(
        (m) => m[0]
      )
    ),
  ]

  const bySegment = new Map<string, string>()
  for (const url of urls) {
    const m = url.match(/\/PRD-SFCC\/([^/]+)\/([^/]+)\/(.+)$/)
    if (!m) continue
    const [, id, color] = m
    // Drop any `?_s=RAABAB0` cache token. Carried into the rebuilt URL it 404s,
    // because the token is bound to the transform it was issued for.
    const tail = m[3].split('?')[0]
    if (id !== styleId) continue // another product's shot (recommendations)
    if (preferredColor && color !== preferredColor) continue // another colourway

    const segment = `${id}/${color}/${tail}`
    if (bySegment.has(segment)) continue
    bySegment.set(segment, `https://media.thereformation.com/image/upload/${LARGE_TRANSFORM}/PRD-SFCC/${segment}`)
  }

  // Sort by the .N index so the primary shot comes first.
  return [...bySegment.entries()]
    .sort((a, b) => {
      const n = (s: string) => Number(s.match(/\.(\d+)\./)?.[1] ?? 99)
      return n(a[0]) - n(b[0])
    })
    .map(([, url]) => url)
    .slice(0, 8)
}

// ── Product page ──────────────────────────────────────────────────────────────

async function scrapeProductPage(url: string): Promise<ScrapedProduct | null> {
  try {
    const res = await fetch(url, { headers: COMMON_HEADERS })
    if (!res.ok) {
      console.warn(`  ✗ HTTP ${res.status}`)
      return null
    }
    const html = await res.text()

    const ld = readJsonLd(jsonLdBlocksFromHtml(html), 'Product')
    if (!ld?.name) {
      console.warn('  ✗ no Product JSON-LD — page structure may have changed')
      return null
    }

    const name = decodeEntities(ld.name).trim()
    const description = ld.description ? stripHtml(ld.description) : null

    const offers = offerList(ld.offers)

    // Sold-out products carry a single AggregateOffer with lowprice/highprice
    // and no per-size offers at all, instead of one Offer per size. Reading only
    // `price` left those with a null price and no sizes.
    const aggregate = offers[0] as { lowprice?: string; lowPrice?: string; highprice?: string; highPrice?: string } | undefined
    const rawPrice =
      offers[0]?.price ?? aggregate?.lowprice ?? aggregate?.lowPrice ?? aggregate?.highprice ?? aggregate?.highPrice
    const priceCents = rawPrice !== undefined ? parsePrice(String(rawPrice)) : null

    // Sizes are zero-padded: numeric US dress sizes (000, 002 …), which
    // normalizeSize was widened to three digits for, and letter codes (0XS, 00M)
    // which need unpadding first.
    const sizes = normalizeSizes(offers.map((o) => unpadSizeCode(o.size)))

    // Body copy, minus scripts, is where material and fit live.
    const bodyText = stripHtml(html.replace(/<script[\s\S]*?<\/script>/gi, ''))
    const material = extractFibers(bodyText) ?? extractFibers(description)
    const fit = readModelFit(bodyText)

    const styleId = url.match(/\/(\d+)\.html$/)?.[1] ?? ''

    // The JSON-LD `image` is the canonical shot, so its colour is the colourway
    // this row represents. Fall back to unfiltered if it is missing.
    const ldImage = Array.isArray(ld.image) ? ld.image[0] : ld.image
    const imageUrls = galleryImages(html, styleId, ldImage ? assetColor(ldImage) : null)
    if (imageUrls.length === 0) {
      console.warn(`  ! no gallery image matched style id ${styleId} — skipping`)
      return null
    }

    // The style id must be in the slug: Reformation lists each colourway under
    // its own id, and several share a product name.
    const slug = `${url.split('/products/')[1]?.split('/')[0] ?? 'product'}-${styleId}`
    const localPaths = await downloadImages(imageUrls, BRAND, slug, url)

    // A discontinued colourway still has a PDP, but its assets are gone: every
    // index and every transform 404s. Those products reach here with a gallery
    // that downloads to nothing, and an image-driven catalog has no use for
    // them — the vision pass and the style tiles both need a photo.
    if (localPaths.length === 0) {
      console.warn('  ! every image 404d (discontinued colourway) — skipping')
      return null
    }

    return {
      brand: BRAND,
      name,
      description,
      material,
      price_cents: priceCents,
      product_url: url,
      image_urls: imageUrls,
      local_image_paths: localPaths,
      scraped_at: new Date().toISOString(),
      size_range: sizes,
      model_height_cm: fit.heightCm,
      model_size: fit.size,
      fit_notes: fit.notes,
    }
  } catch (e) {
    console.warn(`  ✗ Failed to scrape ${url}: ${e}`)
    return null
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('Reformation scraper starting (sitemap + JSON-LD mode)...')
  const urls = await collectProductUrls(MAX_PRODUCTS)
  if (urls.length === 0) {
    console.error(`No product URLs found — check ${SITEMAP_URL}`)
    process.exit(1)
  }

  const products: ScrapedProduct[] = []
  for (let i = 0; i < urls.length; i++) {
    console.log(`\n[${i + 1}/${urls.length}] ${urls[i]}`)
    const product = await scrapeProductPage(urls[i])
    if (product) {
      products.push(product)
      console.log(
        `  ✓ ${product.name} — ${product.image_urls.length} images, ${product.size_range?.length ?? 0} sizes, ` +
          `model ${product.model_height_cm ?? '?'}cm/${product.model_size ?? '?'}, material: ${product.material ?? 'n/a'}`
      )
    }
    await sleep(400)
  }

  if (products.length === 0) {
    console.error('No products scraped — the Reformation PDP structure may have changed.')
    process.exit(1)
  }

  saveProducts(BRAND, products)
}

run().catch(console.error)
