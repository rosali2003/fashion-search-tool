/**
 * Madewell scraper — Playwright, because Akamai fronts the whole site.
 *
 * Every plain HTTP request is refused: `curl https://www.madewell.com/` returns
 * an Akamai "Access Denied" page, and so does robots.txt. The existing stealth
 * browser gets through unmodified — verified at HTTP 200 with a fully populated
 * category page — so no new anti-bot machinery is needed here.
 *
 * The PDP serves a clean schema.org Product block that already contains the
 * product's own six gallery images, so extraction reads structured data and
 * never touches the DOM gallery. That matters: the page carries 92 <img> tags,
 * most of them navigation and seasonal campaign art, which is precisely the
 * shape of the Aritzia regression documented in aritzia.ts.
 */

import { createBrowser, createStealthPage } from './browser.js'
import { sleep, randomDelay, parsePrice, slugify, downloadImages, saveProducts } from './utils.js'
import { normalizeSizes } from './types.js'
import { readJsonLd, offerList, stripHtml, decodeEntities, extractFibers } from './jsonld.js'
import type { JsonLdProduct } from './jsonld.js'
import type { ScrapedProduct } from './types.js'
import type { Page } from 'playwright'

const BRAND = 'madewell'
const BASE_URL = 'https://www.madewell.com'
const LISTING_PATHS = [
  '/womens/clothing',
  '/womens/clothing/dresses',
  '/womens/clothing/jeans',
  '/womens/clothing/sweaters',
  '/womens/clothing/tops',
]
const MAX_PRODUCTS = 50

/**
 * Product URLs look like
 *   /p/womens/clothing/dresses/casual-dresses/<slug>/<STYLE>/?ccode=<COLOR>
 *
 * STYLE identifies the garment and ccode the colourway. Both are kept: each
 * colourway is its own catalog row, so the pair is the identity.
 */
const PRODUCT_URL_RE = /\/p\/womens\/[^?]*\/([A-Z]{2}\d{3})\/?(?:\?.*)?$/

interface ProductId {
  style: string
  ccode: string | null
}

function parseProductUrl(href: string): ProductId | null {
  const m = href.match(PRODUCT_URL_RE)
  if (!m) return null
  const ccode = href.match(/[?&]ccode=([A-Z0-9]+)/i)?.[1] ?? null
  return { style: m[1], ccode }
}

async function collectProductUrls(limit: number): Promise<string[]> {
  const browser = await createBrowser()
  const seen = new Set<string>()
  const urls: string[] = []

  try {
    for (const path of LISTING_PATHS) {
      if (urls.length >= limit) break
      const listingUrl = `${BASE_URL}${path}`
      console.log(`Navigating to ${listingUrl}`)

      const page = await createStealthPage(browser)
      try {
        const resp = await page
          .goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
          .catch(() => null)
        if (!resp || resp.status() >= 400) {
          console.warn(`  skipping ${path} (HTTP ${resp?.status() ?? 'error'})`)
          continue
        }
        await sleep(4000)

        for (let i = 0; i < 6; i++) {
          await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5))
          await sleep(1200)
        }

        const hrefs = await page.$$eval('a[href]', (els) =>
          [...new Set(els.map((el) => (el as HTMLAnchorElement).href))]
        )

        for (const href of hrefs) {
          const id = parseProductUrl(href)
          if (!id) continue
          const key = `${id.style}:${id.ccode ?? ''}`
          if (seen.has(key)) continue
          seen.add(key)
          urls.push(href)
          if (urls.length >= limit) break
        }
        console.log(`  total unique product URLs so far: ${urls.length}`)
      } finally {
        await page.context().close()
      }
      await randomDelay(1500, 3000)
    }
  } finally {
    await browser.close()
  }

  return urls
}

// ── Sizes ─────────────────────────────────────────────────────────────────────

/**
 * Sizes out of the structured data, when there are any.
 *
 * As of writing there are none: Madewell's `isVariantOf` ProductGroup carries
 * only @type/@id/name/description/url/sku, and `offers` is a single Offer with
 * no size on it. This returns an empty array today and is kept because the
 * ProductGroup is exactly where sizes would appear if Madewell ever populates
 * `hasVariant` — at which point this starts working with no other change.
 * Written defensively in the style of uniqlo.ts:85, so a shape change yields
 * nothing rather than throwing.
 */
function readSizes(ld: JsonLdProduct | null): string[] {
  const groups: JsonLdProduct[] = [ld?.isVariantOf, ld].filter(Boolean) as JsonLdProduct[]
  for (const g of groups) {
    const variants = g.hasVariant
    if (variants?.length) {
      const sizes = normalizeSizes(variants.map((v) => v.size ?? null))
      if (sizes.length) return sizes
    }
    const offerSizes = normalizeSizes(offerList(g.offers).map((o) => o.size ?? null))
    if (offerSizes.length) return offerSizes
  }
  return []
}

/**
 * Fit signal from the page copy.
 *
 * Madewell's size list is a custom portal widget that renders its options only
 * after a real interaction, and clicking it did not reliably populate them. So
 * size_range is left empty here, as it already is for Aritzia and Gap, and the
 * fit information that IS reliably on the page is captured instead:
 *
 *   - The length run (Standard / Short / Tall / Petite / Plus). The comment on
 *     ScrapedProduct.size_range notes that across all 298 products in the
 *     original corpus, ZERO mentioned petite or tall — and the onboarding
 *     questionnaire asks for height. This is the first real source of that.
 *   - Garment measurements, e.g. `10 5/8" rise, 21 3/4" leg opening, 30" inseam`.
 */
const MEASUREMENT_RE = /\d+(?:\s+\d+\/\d+)?"\s*(?:rise|inseam|leg opening|length|bust|waist|hip)[^.\n]{0,80}/i

/**
 * Length options must be read from the buy panel only, NOT the whole page.
 *
 * Madewell's global navigation contains category links named Short, Petite,
 * Tall and Plus. Scanning the document for those tokens gave every product the
 * identical "Short, Petite, Tall, Plus" — a fabricated attribute that looks like
 * real fit data. The buy panel runs from the colour name to the size control, so
 * the slice between the product's price and "Size Chart" / "ADD TO BAG" is the
 * only region where these words describe THIS garment.
 */
function lengthsFromPanel(text: string): string[] {
  const end = text.search(/Size Chart|ADD TO BAG/i)
  if (end < 0) return []
  const panel = text.slice(Math.max(0, end - 300), end)

  return [
    ...new Set(
      panel
        .split('\n')
        .map((l) => l.trim())
        // Uppercase only: the buy panel renders STANDARD / SHORT / TALL, while
        // the navigation renders them title-cased.
        .filter((l) => /^(STANDARD|SHORT|TALL|PETITE|PLUS)$/.test(l))
        .map((l) => l[0] + l.slice(1).toLowerCase())
    ),
  ]
}

function fitNotesFrom(text: string): string | null {
  const notes: string[] = []

  const lengths = lengthsFromPanel(text)
  if (lengths.length > 0) notes.push(`Available lengths: ${lengths.join(', ')}.`)

  const measurement = text.match(MEASUREMENT_RE)
  if (measurement) notes.push(measurement[0].trim())

  return notes.length > 0 ? notes.join(' ').slice(0, 400) : null
}

// ── Images ────────────────────────────────────────────────────────────────────

/** Madewell serves the gallery at whatever size the tile asked for; ask for a big one. */
function upscale(url: string): string {
  return url.replace(/\bwid=\d+/, 'wid=1400').replace(/\bhei=\d+/, 'hei=1779')
}

/**
 * Gallery images for this product only.
 *
 * The JSON-LD `image` array is already product-scoped, which is why it is
 * preferred. The DOM fallback filters on the style code, but scoped to the
 * `www.madewell.com/images/` path rather than by substring: a bat.bing.com
 * tracking pixel carries the style code in a query parameter and passes a naive
 * `includes(style)` test.
 */
async function collectImages(page: Page, ld: JsonLdProduct | null, style: string): Promise<string[]> {
  const fromLd = (Array.isArray(ld?.image) ? ld.image : ld?.image ? [ld.image] : []).filter(Boolean)
  if (fromLd.length > 0) return [...new Set(fromLd.map(upscale))].slice(0, 8)

  console.warn('  ! no JSON-LD gallery — falling back to DOM images')
  const fromDom = await page
    .evaluate(
      ({ style }) =>
        [...new Set([...document.querySelectorAll('img')].map((i) => i.currentSrc || i.src))].filter(
          (src) => {
            if (!src) return false
            let u: URL
            try {
              u = new URL(src)
            } catch {
              return false
            }
            // Host- and path-scoped, so a tracker carrying the style code in a
            // query string cannot masquerade as a product photo.
            return (
              u.hostname === 'www.madewell.com' &&
              u.pathname.startsWith('/images/') &&
              u.pathname.toUpperCase().includes(style.toUpperCase())
            )
          }
        ),
      { style }
    )
    .catch(() => [] as string[])

  return [...new Set(fromDom.map(upscale))].slice(0, 8)
}

// ── Product page ──────────────────────────────────────────────────────────────

async function scrapeProductPage(page: Page, url: string): Promise<ScrapedProduct | null> {
  const id = parseProductUrl(url)
  if (!id) return null

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await sleep(4000)

    const ldBlocks = await page.$$eval('script[type="application/ld+json"]', (els) =>
      els.map((el) => el.textContent ?? '')
    )
    const ld = readJsonLd(ldBlocks, 'Product')

    const name = decodeEntities(
      ld?.name?.trim() || (await page.$eval('h1', (el) => el.textContent?.trim() ?? '').catch(() => ''))
    ).trim()
    if (!name) {
      console.warn('  ✗ no product name — likely an Akamai block page')
      return null
    }

    const description = ld?.description ? stripHtml(ld.description) : null

    const priceRaw = offerList(ld?.offers)[0]?.price
    const priceCents = priceRaw !== undefined ? parsePrice(String(priceRaw)) : null

    // One read of the rendered text serves both material and fit.
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '')

    // Madewell usually states composition in the description ("Crafted of 100%
    // cotton dobby, ..."), but not always — several products keep it in the
    // details panel further down the page, so the body text is the fallback.
    const material = extractFibers(description) ?? extractFibers(pageText)

    // Empty for now — see lengthsFromPanel. Kept because Madewell's ProductGroup
    // would be the natural place for it if they ever populate hasVariant.
    const sizes = readSizes(ld)
    const fitNotes = pageText ? fitNotesFrom(pageText) : null

    const style = ld?.sku ?? id.style
    const imageUrls = await collectImages(page, ld, style)
    if (imageUrls.length === 0) {
      console.warn('  ✗ no product images found — skipping')
      return null
    }

    // Style AND colour in the slug. Madewell sells one style across many
    // colourways, each its own row here; slugging on name alone would make them
    // share an image directory and overwrite each other, which is the bug
    // gap.ts:141 was written to fix.
    const slug = `${slugify(name)}-${style}${id.ccode ? `-${id.ccode}` : ''}`
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
      fit_notes: fitNotes,
    }
  } catch (e) {
    console.warn(`  ✗ Failed to scrape ${url}: ${e}`)
    return null
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('Madewell scraper starting (Playwright + JSON-LD mode)...')
  const urls = await collectProductUrls(MAX_PRODUCTS)
  if (urls.length === 0) {
    console.error('No product URLs found — Madewell listing structure may have changed or Akamai is blocking.')
    process.exit(1)
  }

  const browser = await createBrowser()
  const products: ScrapedProduct[] = []

  try {
    for (let i = 0; i < urls.length; i++) {
      console.log(`\n[${i + 1}/${urls.length}] ${urls[i]}`)
      const page = await createStealthPage(browser)
      try {
        const product = await scrapeProductPage(page, urls[i])
        if (product) {
          products.push(product)
          console.log(
            `  ✓ ${product.name} — ${product.image_urls.length} images, material: ${product.material ?? 'n/a'}` +
              `, fit: ${product.fit_notes ?? 'n/a'}`
          )
        }
      } finally {
        await page.context().close()
      }
      await randomDelay(2000, 4000)
    }
  } finally {
    await browser.close()
  }

  if (products.length === 0) {
    console.error('No products scraped — Akamai may have started blocking the stealth browser.')
    process.exit(1)
  }

  saveProducts(BRAND, products)
}

run().catch(console.error)
