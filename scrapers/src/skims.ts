/**
 * Skims scraper — sitemap + JSON-LD, no browser needed.
 *
 * skims.com is a headless Shopify (Hydrogen) storefront, so the usual Shopify
 * shortcuts do NOT work: /products.json and /collections/all/products.json both
 * 404, and /cart.js returns an empty 204. What does work is plain HTTP:
 *
 *   1. sitemap-products.xml lists every product URL (~3,500), uncontested.
 *   2. Each PDP server-renders a schema.org ProductGroup block whose hasVariant
 *      array carries one Product per size, each with its own offer price.
 *
 * The `size` on each variant is why this reads ProductGroup rather than Product:
 * Skims emits no standalone Product node, and the group is the only place the
 * size range appears.
 */

import { parsePrice, saveProducts, sleep, downloadImages } from './utils.js'
import { normalizeSizes } from './types.js'
import { readJsonLd, jsonLdBlocksFromHtml, offerList, stripHtml, extractFibers } from './jsonld.js'
import type { ScrapedProduct } from './types.js'

const BRAND = 'skims'
const BASE_URL = 'https://skims.com'
const SITEMAP_URL = `${BASE_URL}/sitemap-products.xml`
const MAX_PRODUCTS = 100

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  Referer: `${BASE_URL}/`,
}

/**
 * Handles to skip. Skims sells menswear and non-garment goods out of the same
 * sitemap, and neither belongs in a women's clothing corpus.
 */
const SKIP_HANDLE_RE =
  /(^|-)(mens|men)(-|$)|gift-card|gift-bag|accessories-claw-clip|-candle|-fragrance|-sticker/i

// ── Sitemap ───────────────────────────────────────────────────────────────────

async function collectProductUrls(limit: number): Promise<string[]> {
  console.log(`Fetching sitemap ${SITEMAP_URL}`)
  const res = await fetch(SITEMAP_URL, { headers: COMMON_HEADERS })
  if (!res.ok) throw new Error(`sitemap returned HTTP ${res.status}`)
  const xml = await res.text()

  const all = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim())
  const urls = all.filter((u) => u.includes('/products/') && !SKIP_HANDLE_RE.test(u))

  console.log(`  ${all.length} sitemap entries, ${urls.length} after filtering`)
  return urls.slice(0, limit)
}

// ── Product page ──────────────────────────────────────────────────────────────

/**
 * Asset codes for one garment, most specific first.
 *
 * Variant mpn looks like `TP-LST-4689-MBL-XXS` (style-colour-size), and Skims
 * names its CDN files after the same code
 * (`SKIMS-LOUNGEWEAR-TP-LST-4689-MBL.jpg`). Matching on it is what tells this
 * product's gallery apart from the recommendation tiles on the same page —
 * measured, 15 of a page's images carry the code and the rest are other
 * products entirely.
 *
 * Colour is part of the preferred code because every colourway is its own
 * catalog row here. Filtering on the style alone (`TP-LST-4689`) let the Marble
 * tee pull in Light Heather Grey shots: the two colourways shared 7 of their 8
 * images. The style-only code is kept as a fallback for products whose assets
 * are not colour-suffixed.
 */
function assetCodes(mpn: string | undefined): string[] {
  if (!mpn) return []
  const parts = mpn.split('-')
  const codes: string[] = []
  if (parts.length >= 4) codes.push(parts.slice(0, 4).join('-')) // style + colour
  if (parts.length >= 3) codes.push(parts.slice(0, 3).join('-')) // style only
  return codes
}

function galleryImages(html: string, codes: string[]): string[] {
  const all = [
    ...new Set(
      [...html.matchAll(/https:\/\/cdn\.shopify\.com\/s\/files\/[^"'\\\s)]+?\.(?:jpg|jpeg|png|webp)/gi)]
        .map((m) => m[0])
    ),
  ]

  // Try style+colour first, then style alone.
  let matched: string[] = []
  for (const code of codes) {
    matched = all.filter((u) => u.toUpperCase().includes(code.toUpperCase()))
    if (matched.length > 0) break
  }

  if (matched.length === 0) {
    // Say so rather than silently shipping another product's photos — this is the
    // failure documented at length in aritzia.ts, where a banner change gave 49
    // products the same 8 images and nobody noticed until vision extraction ran.
    console.warn(
      `  ! no image carried code ${codes.join(' or ') || '(none)'} — skipping gallery rather than guessing`
    )
    return []
  }

  // Skims serves the same asset at several widths (`_grande`, `_1024x`, …).
  // Collapse those to one entry each so the gallery is distinct shots.
  const seenBase = new Set<string>()
  const out: string[] = []
  for (const url of matched) {
    const base = url.replace(/_(?:\d+x\d*|grande|large|medium|small|master)(?=\.[a-z]+$)/i, '')
    if (seenBase.has(base)) continue
    seenBase.add(base)
    out.push(url)
  }
  return out.slice(0, 8)
}

async function scrapeProductPage(url: string): Promise<ScrapedProduct | null> {
  try {
    const res = await fetch(url, { headers: COMMON_HEADERS })
    if (!res.ok) {
      console.warn(`  ✗ HTTP ${res.status}`)
      return null
    }
    const html = await res.text()

    const group = readJsonLd(jsonLdBlocksFromHtml(html), 'ProductGroup')
    if (!group?.name) {
      console.warn('  ✗ no ProductGroup JSON-LD — page structure may have changed')
      return null
    }

    const name = group.name.trim()
    const description = group.description ? stripHtml(group.description) : null

    const variants = group.hasVariant ?? []
    const sizes = normalizeSizes(variants.map((v) => v.size ?? null))

    // Price from the first variant's offer; sizes of one garment are one price.
    const priceRaw = offerList(variants[0]?.offers)[0]?.price
    const priceCents = priceRaw !== undefined ? parsePrice(String(priceRaw)) : null

    const imageUrls = galleryImages(html, assetCodes(variants[0]?.mpn))
    if (imageUrls.length === 0) return null

    // Material lives in the page copy, not the structured data.
    const material = extractFibers(stripHtml(html))

    const slug = url.split('/products/')[1]?.split('?')[0] ?? name.toLowerCase()
    const localPaths = await downloadImages(imageUrls, BRAND, slug, url)

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
    }
  } catch (e) {
    console.warn(`  ✗ Failed to scrape ${url}: ${e}`)
    return null
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('Skims scraper starting (sitemap + JSON-LD mode)...')
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
        `  ✓ ${product.name} — ${product.image_urls.length} images, ${product.size_range?.length ?? 0} sizes, material: ${product.material ?? 'n/a'}`
      )
    }
    await sleep(400)
  }

  if (products.length === 0) {
    console.error('No products scraped — the Skims PDP structure may have changed.')
    process.exit(1)
  }

  saveProducts(BRAND, products)
}

run().catch(console.error)
