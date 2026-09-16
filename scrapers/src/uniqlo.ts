/**
 * Uniqlo scraper — uses the internal Uniqlo US REST API (no browser needed).
 *
 * Two endpoints are used:
 *   1. Listing  : /products?path=<categoryId>   → product tiles (name, price, main image)
 *   2. Detail   : /products/<id>/price-groups/<pg>/details
 *                 → long description + composition (material) + full image gallery
 *
 * NOTE: `path` must be a NUMERIC category id (e.g. 22210 = Women), not a slug.
 *       Image URLs returned by the API are already absolute.
 */

import { downloadImages, saveProducts, sleep } from './utils.js'
import { normalizeSizes, parseHeightCm } from './types.js'
import type { ScrapedProduct } from './types.js'

const BRAND = 'uniqlo'
const BASE_URL = 'https://www.uniqlo.com'
const API_BASE = `${BASE_URL}/us/api/commerce/v5/en`
const PAGE_SIZE = 36
const MAX_PRODUCTS = 100

// Numeric Uniqlo US category ids. 22210 = Women (≈700 products).
const CATEGORY_IDS = ['22210']

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: `${BASE_URL}/us/en/`,
}

// ── API response shapes (only the fields we use) ──────────────────────────────

interface ApiImage {
  image: string
}

interface ListItem {
  productId: string
  name: string
  priceGroup: string
  prices?: { base?: { value: number } }
  representative?: { color?: { displayCode?: string } }
  images?: { main?: Record<string, ApiImage> }
}

interface ListResponse {
  result: {
    items: ListItem[]
    pagination: { total: number; count: number }
  }
}

interface DetailResponse {
  result: {
    longDescription?: string
    shortDescription?: string
    composition?: string
    images?: {
      main?: Record<string, ApiImage>
      sub?: ApiImage[]
    }
    // Sizing. The detail endpoint is now called with includeModelSize=true (it
    // was explicitly suppressed before). The exact shape is not documented and
    // Uniqlo has moved it between releases, so several plausible locations are
    // typed optionally and read defensively below — a shape change yields null
    // rather than a crashed scrape. VERIFY against a live response the first time
    // this runs; `sizes` is the field most likely to have moved.
    sizes?: Array<UniqloSize>
    summary?: {
      sizes?: Array<UniqloSize>
    }
    modelSize?: {
      height?: string | number
      size?: string
      sizeName?: string
      modelHeight?: string | number
    }
    models?: Array<{ height?: string | number; size?: string }>
    sizeAndFit?: string
  }
}

interface UniqloSize {
  code?: string
  name?: string
  displayCode?: string
  /** Was a label string; now a display-control object. See readSizes. */
  display?: { showFlag?: boolean; chipType?: number }
}

/**
 * Read the size range out of whichever field the API happens to expose.
 *
 * `name` carries the label ("XXS", "M", "28"). `display` used to and no longer
 * does — it is now {showFlag, chipType}, which is what broke this scraper.
 *
 * `displayCode` is deliberately not a fallback even though it looks like one:
 * its values are zero-padded ordinals ("001", "002") that normalizeSize would
 * happily accept as numeric sizes, so every garment would report sizes 1-9.
 * `code` ("SMA001") is safe because normalizeSize rejects it.
 */
function readSizes(detail: DetailResponse['result'] | null): string[] {
  const candidates = detail?.sizes ?? detail?.summary?.sizes ?? []
  return normalizeSizes(candidates.map((s) => s.name ?? s.code))
}

/** Read model height and worn size, tolerating string or numeric heights. */
function readModel(detail: DetailResponse['result'] | null): {
  heightCm: number | null
  size: string | null
} {
  const m = detail?.modelSize ?? detail?.models?.[0]
  if (!m) return { heightCm: null, size: null }

  const rawHeight = (m as { height?: string | number; modelHeight?: string | number }).height
    ?? (m as { modelHeight?: string | number }).modelHeight
  const heightCm =
    typeof rawHeight === 'number'
      ? rawHeight >= 120 && rawHeight <= 220
        ? Math.round(rawHeight)
        : null
      : parseHeightCm(rawHeight ?? null)

  const rawSize = (m as { size?: string; sizeName?: string }).size
    ?? (m as { sizeName?: string }).sizeName
  return { heightCm, size: rawSize ? rawSize.trim() : null }
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchListing(categoryId: string, offset: number): Promise<ListResponse['result'] | null> {
  const url = `${API_BASE}/products?path=${encodeURIComponent(
    categoryId
  )}&limit=${PAGE_SIZE}&offset=${offset}&httpFailure=true`

  const res = await fetch(url, { headers: COMMON_HEADERS })
  if (!res.ok) throw new Error(`listing API returned ${res.status}`)
  const data = (await res.json()) as ListResponse
  return data.result ?? null
}

async function fetchDetail(productId: string, priceGroup: string): Promise<DetailResponse['result'] | null> {
  const url = `${API_BASE}/products/${encodeURIComponent(
    productId
  )}/price-groups/${priceGroup}/details?includeModelSize=true&httpFailure=true`

  try {
    const res = await fetch(url, { headers: COMMON_HEADERS })
    if (!res.ok) return null
    const data = (await res.json()) as DetailResponse
    return data.result ?? null
  } catch {
    return null
  }
}

// Strip the <br> / HTML that Uniqlo embeds in composition strings.
function cleanText(html: string | undefined | null): string | null {
  if (!html) return null
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function scrapeUniqlo(maxProducts: number): Promise<ScrapedProduct[]> {
  const products: ScrapedProduct[] = []
  const seenIds = new Set<string>()

  for (const categoryId of CATEGORY_IDS) {
    if (products.length >= maxProducts) break
    console.log(`\nFetching category ${categoryId}...`)

    let offset = 0
    let total = Infinity

    while (products.length < maxProducts && offset < total) {
      let result: ListResponse['result'] | null
      try {
        result = await fetchListing(categoryId, offset)
      } catch (e) {
        console.warn(`  listing error (category ${categoryId}, offset ${offset}): ${e}`)
        break
      }

      if (!result || result.items.length === 0) break
      total = result.pagination.total

      for (const item of result.items) {
        if (products.length >= maxProducts) break
        if (seenIds.has(item.productId)) continue
        seenIds.add(item.productId)

        const productUrl = `${BASE_URL}/us/en/products/${item.productId}.html`

        // Pull detail for description, material, and the on-model gallery.
        const detail = await fetchDetail(item.productId, item.priceGroup)

        // Primary image: the representative colour's main shot from the listing tile.
        const imageUrls: string[] = []
        const repCode = item.representative?.color?.displayCode
        const listingMain = item.images?.main ?? {}
        const primary =
          (repCode && listingMain[repCode]?.image) ||
          Object.values(listingMain)[0]?.image
        if (primary) imageUrls.push(primary)

        // Gallery: the "sub" array from the detail endpoint (on-model / lifestyle shots).
        for (const img of detail?.images?.sub ?? []) {
          if (img.image && !imageUrls.includes(img.image)) imageUrls.push(img.image)
        }

        const description =
          cleanText(detail?.longDescription) ?? cleanText(detail?.shortDescription)
        const material = cleanText(detail?.composition)
        const sizes = readSizes(detail)
        const model = readModel(detail)
        const priceCents = item.prices?.base?.value
          ? Math.round(item.prices.base.value * 100)
          : null

        console.log(`  Processing: ${item.name} (${imageUrls.length} images)`)
        const localPaths = await downloadImages(imageUrls, BRAND, item.productId, productUrl)

        products.push({
          brand: BRAND,
          name: item.name,
          description,
          material,
          price_cents: priceCents,
          product_url: productUrl,
          image_urls: imageUrls,
          local_image_paths: localPaths,
          scraped_at: new Date().toISOString(),
          size_range: sizes,
          model_height_cm: model.heightCm,
          model_size: model.size,
          fit_notes: cleanText(detail?.sizeAndFit) ?? null,
        })

        await sleep(150) // be polite to the detail endpoint
      }

      offset += PAGE_SIZE
    }
  }

  return products
}

async function run() {
  console.log('Uniqlo scraper starting (API mode)...')
  const products = await scrapeUniqlo(MAX_PRODUCTS)

  if (products.length === 0) {
    console.error('No products scraped — the Uniqlo API may have changed.')
    console.error(`Check: ${API_BASE}/products?path=22210&limit=1`)
    process.exit(1)
  }

  saveProducts(BRAND, products)
}

run().catch(console.error)
