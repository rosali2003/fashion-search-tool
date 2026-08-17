/**
 * Everlane scraper — Shopify storefront JSON, no browser needed.
 *
 * everlane.com is a Shopify store with `/products.json` left open, so the whole
 * catalog comes back as structured data: title, body_html, per-variant price and
 * size, the full image gallery, and a tag list.
 *
 * Two things about the feed shape drive the code below:
 *
 * 1. It is ALL-GENDER. There is no womens collection endpoint —
 *    /collections/womens/products.json and /collections/women/products.json both
 *    return an empty array; only /collections/all/products.json is populated.
 *    Gender lives in the tag list instead ('female' / 'male'), measured at
 *    167 female to 82 male on the first page of 250.
 * 2. Tags also carry `category: dresses` and `fabric: cashmere`, which is a free
 *    coarse signal for the two fields the deterministic normaliser cares most
 *    about. The fibre percentages in body_html are still preferred when present,
 *    because "fabric: cotton" loses the blend.
 */

import { parsePrice, saveProducts, sleep, downloadImages } from './utils.js'
import { normalizeSizes } from './types.js'
import { stripHtml, extractFibers } from './jsonld.js'
import type { ScrapedProduct } from './types.js'

const BRAND = 'everlane'
const BASE_URL = 'https://www.everlane.com'
const PAGE_SIZE = 250 // Shopify's hard maximum for this endpoint
const MAX_PRODUCTS = 100

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: `${BASE_URL}/`,
}

/**
 * Non-garment `category:` tags, taken from the live vocabulary rather than
 * guessed. The full observed set for women's products is: sweaters, knit tops,
 * dresses, woven tops, bottoms, denim, outerwear, bags, accessories,
 * flats + other — plus a sizeable untagged bucket, handled below.
 *
 * These are excluded because the corpus is clothing, and a product shot of a
 * tote has no body in it for the vision pass to read drape or fit from.
 */
const EXCLUDED_CATEGORIES = new Set(['bags', 'accessories', 'flats + other'])

/**
 * Roughly 5% of women's products carry no `category:` tag at all, and that
 * bucket is genuinely mixed: it holds a Cashmere Slim Crew Sweater and a Classic
 * Jean Short alongside knee-highs, chunky socks and a snood. Dropping the whole
 * bucket loses real garments, so uncategorised products are filtered by name
 * instead — only the items that are unambiguously not clothing.
 */
// The trailing `s?` is load-bearing: retail titles are plural ("Knee-Highs",
// "Chunky Socks"), so a bare \b after the singular never matches.
const NON_GARMENT_NAME_RE =
  /\b(sock|knee[- ]high|tight|snood|beanie|scarf|hat|cap|belt|tote|bag|glove|mitten|earring|necklace|bracelet|sunglasses|gift card)s?\b/i

// ── Shopify response shapes (only the fields used) ────────────────────────────

interface ShopifyVariant {
  price: string
  option1?: string | null
  option2?: string | null
  available?: boolean
}

interface ShopifyProduct {
  id: number
  title: string
  handle: string
  body_html: string
  product_type: string
  tags: string[]
  variants: ShopifyVariant[]
  options?: Array<{ name: string; values: string[] }>
  images: Array<{ src: string }>
}

interface ShopifyResponse {
  products: ShopifyProduct[]
}

// ── Tag helpers ───────────────────────────────────────────────────────────────

/** Read a `prefix: value` tag, e.g. `category: dresses` -> `dresses`. */
function tagValue(tags: string[], prefix: string): string | null {
  const hit = tags.find((t) => t.toLowerCase().startsWith(`${prefix}:`))
  return hit ? hit.slice(hit.indexOf(':') + 1).trim().toLowerCase() : null
}

function isWomens(tags: string[]): boolean {
  const lower = tags.map((t) => t.toLowerCase())
  if (lower.includes('female')) return true
  // Unisex products are genuinely womenswear too, but only when not also tagged
  // male-only — Everlane tags a handful of items both ways.
  return lower.includes('unisex') && !lower.includes('male')
}

function isGarment(tags: string[], title: string): boolean {
  const category = tagValue(tags, 'category')
  if (category) return !EXCLUDED_CATEGORIES.has(category)
  return !NON_GARMENT_NAME_RE.test(title)
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchPage(page: number): Promise<ShopifyProduct[] | null> {
  const url = `${BASE_URL}/collections/all/products.json?limit=${PAGE_SIZE}&page=${page}`
  try {
    const res = await fetch(url, { headers: COMMON_HEADERS })
    if (!res.ok) {
      console.warn(`  listing page ${page} returned HTTP ${res.status}`)
      return null
    }
    const data = (await res.json()) as ShopifyResponse
    return data.products ?? []
  } catch (e) {
    console.warn(`  listing page ${page} failed: ${e}`)
    return null
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function scrapeEverlane(maxProducts: number): Promise<ScrapedProduct[]> {
  const products: ScrapedProduct[] = []
  const seenHandles = new Set<string>()
  let page = 1
  let scanned = 0

  while (products.length < maxProducts) {
    const batch = await fetchPage(page)
    if (batch === null) break
    if (batch.length === 0) break // past the end of the catalog

    for (const item of batch) {
      if (products.length >= maxProducts) break
      scanned++

      if (!isWomens(item.tags) || !isGarment(item.tags, item.title)) continue
      if (seenHandles.has(item.handle)) continue
      seenHandles.add(item.handle)

      const productUrl = `${BASE_URL}/products/${item.handle}`

      // Title format is "90s Baggy Cargo Pant | Olive" — the colourway is part of
      // the name, which is what we want: each colourway is its own catalog row.
      const name = item.title.trim()

      const description = stripHtml(item.body_html) || null

      // Prefer real fibre percentages from the copy; fall back to the coarse
      // `fabric:` tag, which at least says "cashmere" when the copy does not.
      const fabricTag = tagValue(item.tags, 'fabric')
      const material = extractFibers(description) ?? (fabricTag ? fabricTag : null)

      const priceStr = item.variants[0]?.price ?? ''
      const priceCents = priceStr ? parsePrice(priceStr) : null

      // Sizes: the declared option set when present, else the per-variant options.
      const sizeOption = item.options?.find((o) => /size/i.test(o.name))
      const sizes = sizeOption
        ? normalizeSizes(sizeOption.values)
        : normalizeSizes(item.variants.flatMap((v) => [v.option1, v.option2]))

      // Shopify image URLs are already scoped to this product — no filtering
      // needed, unlike the retailers whose galleries share a page with
      // recommendation tiles.
      const imageUrls = item.images.map((i) => i.src).slice(0, 8)

      console.log(`  Processing: ${name} (${imageUrls.length} images)`)
      const localPaths = await downloadImages(imageUrls, BRAND, item.handle, productUrl)

      products.push({
        brand: BRAND,
        name,
        description,
        material,
        price_cents: priceCents,
        product_url: productUrl,
        image_urls: imageUrls,
        local_image_paths: localPaths,
        scraped_at: new Date().toISOString(),
        size_range: sizes,
      })

      await sleep(120)
    }

    if (batch.length < PAGE_SIZE) break // last page
    page++
  }

  console.log(`\nScanned ${scanned} catalog entries to find ${products.length} women's garments.`)
  return products
}

async function run() {
  console.log('Everlane scraper starting (Shopify JSON mode)...')
  const products = await scrapeEverlane(MAX_PRODUCTS)

  if (products.length === 0) {
    console.error('No products scraped — the Everlane Shopify feed may have closed.')
    console.error(`Check: ${BASE_URL}/collections/all/products.json?limit=1`)
    process.exit(1)
  }

  saveProducts(BRAND, products)
}

run().catch(console.error)
