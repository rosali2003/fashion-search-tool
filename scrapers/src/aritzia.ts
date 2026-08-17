/**
 * Aritzia scraper
 *
 * Listing categories live under /us/en/... (the old /en-US/... paths now 404).
 * Aritzia has no Product JSON-LD, so the product page is scraped from the DOM:
 *   - name        : <h1>
 *   - price        : price block (sale price preferred)
 *   - description  : product copy block / meta description
 *   - material     : revealed by expanding the "Details" accordion (e.g. "97% cotton, 3% elastane")
 *   - images       : Cloudinary gallery shots on assets.aritzia.com
 */

import { createBrowser, createStealthPage } from './browser.js'
import { sleep, randomDelay, parsePrice, slugify, downloadImagesViaPage, saveProducts } from './utils.js'
import { FIBER_RE } from './jsonld.js'
import type { ScrapedProduct } from './types.js'
import type { Page } from 'playwright'

const BRAND = 'aritzia'
const BASE_URL = 'https://www.aritzia.com'
// A few women's categories — kept small and resilient (missing ones are skipped).
const LISTING_PATHS = [
  '/us/en/new',
  '/us/en/clothing/dresses',
  '/us/en/clothing/shirts-blouses',
  '/us/en/clothing/pants',
  '/us/en/clothing/sweaters',
]
const MAX_PRODUCTS = 50

// Reduce a product URL to its canonical form (drop the ?color= variant query) so
// the same garment in five colours collapses to one entry.
function canonicalUrl(href: string): string | null {
  const m = href.match(/\/product\/[^?#]*\/(\d+)\.html/)
  if (!m) return null
  return href.split('?')[0]
}

async function collectProductUrls(limit: number): Promise<string[]> {
  const browser = await createBrowser()
  const seen = new Set<string>() // by product id
  const urls: string[] = []

  try {
    for (const path of LISTING_PATHS) {
      if (urls.length >= limit) break
      const listingUrl = `${BASE_URL}${path}`
      console.log(`Navigating to ${listingUrl}`)

      // Fresh context per listing — Aritzia sticky-blocks a session after its
      // first page load, so reusing one context yields links from only one
      // category.
      const page = await createStealthPage(browser)
      try {
        const resp = await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null)
        if (!resp || resp.status() >= 400) {
          console.warn(`  skipping ${path} (HTTP ${resp?.status() ?? 'error'})`)
          continue
        }
        await sleep(2500)

        for (let i = 0; i < 6; i++) {
          await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5))
          await sleep(1200)
        }

        const hrefs = await page.$$eval('a[href*="/product/"]', (els) =>
          [...new Set(els.map((el) => (el as HTMLAnchorElement).href))]
        )

        for (const href of hrefs) {
          const canon = canonicalUrl(href)
          if (!canon) continue
          const id = canon.match(/\/(\d+)\.html/)?.[1]
          if (!id || seen.has(id)) continue
          seen.add(id)
          urls.push(canon)
          if (urls.length >= limit) break
        }
        console.log(`  total unique product URLs so far: ${urls.length}`)
      } finally {
        await page.context().close()
      }
    }
  } finally {
    await browser.close()
  }

  return urls
}

// Aritzia rate-limits rapid PDP navigation and serves a block page whose <h1> is
// just the site name. Detect that so we can back off and retry.
function isBlockPage(name: string): boolean {
  return !name || /aritzia\.com/i.test(name) || name.toLowerCase() === 'aritzia'
}

async function scrapeProductPage(page: Page, url: string): Promise<ScrapedProduct | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(3000)
    const name = await page.$eval('h1', (el) => el.textContent?.trim() ?? '').catch(() => '')
    if (isBlockPage(name)) {
      console.warn(`  ✗ blocked (anti-bot), skipping ${url}`)
      return null
    }

    // Price — the block may concatenate "$168$134.40" (regular + sale); take the
    // last price token so the sale price wins.
    const priceCents = await page
      .$eval('[class*="price" i], [data-testid*="price" i]', (el) => el.textContent ?? '')
      .then((text) => {
        const tokens = text.match(/\$\s*\d[\d.,]*/g)
        return tokens?.length ? tokens[tokens.length - 1] : ''
      })
      .then((t) => parsePrice(t))
      .catch(() => null)

    // Description — product copy block, falling back to the meta description.
    const description =
      (await page
        .$eval('[class*="description" i], [data-testid*="description" i]', (el) =>
          el.textContent?.trim() ?? ''
        )
        .catch(() => '')) ||
      (await page
        .$eval('meta[name="description"]', (el) => el.getAttribute('content')?.trim() ?? '')
        .catch(() => '')) ||
      null

    // Material — expand the "Details" accordion, then read the composition line.
    let material: string | null = null
    const detailsBtn = await page.$('button:has-text("Details"), button:has-text("Materials"), button:has-text("Fabric")')
    if (detailsBtn) {
      await detailsBtn.click().catch(() => {})
      await sleep(1000)
    }
    material = await page
      .evaluate((reSource) => {
        const re = new RegExp(reSource, 'i')
        for (const line of document.body.innerText.split('\n')) {
          const t = line.trim()
          if (re.test(t) && !/off/i.test(t)) {
            // Drop a leading label like "Content:" / "Shell:" / "Fabric:".
            return t.replace(/^(?:content|fabric|material|shell|composition)\s*:\s*/i, '').slice(0, 200)
          }
        }
        return null
      }, FIBER_RE.source)
      .catch(() => null)

    // Images — Cloudinary gallery shots for THIS product, deduped and capped.
    //
    // Filtering by product id is not optional. An earlier version took the first
    // 8 Cloudinary images in DOM order, which worked until Aritzia put a seasonal
    // campaign banner above the gallery. The August 2026 crawl then captured the
    // same 8 lookbook assets (fa26-week-1-*) for all 49 products — 8 distinct
    // URLs across the whole brand, where June had 384 — and the product gallery
    // was never reached. Vision extraction on that data was worthless, and the
    // model said so unprompted: "these seem to be different garments."
    //
    // Gallery assets embed the product id (product 130356 ->
    // .../s26_a03_130356_36530_on_a), so matching on it is content-based and
    // survives any number of new banners.
    const productId = url.match(/\/(\d+)\.html/)?.[1] ?? null

    const collect = await page.evaluate((pid: string | null) => {
      const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img'))
      const seen = new Set<string>()
      const matched: string[] = []
      const others: string[] = []

      for (const img of imgs) {
        const src = img.currentSrc || img.src || img.getAttribute('data-src') || ''
        if (!/assets\.aritzia\.com\/image\/upload/.test(src)) continue
        const clean = src.split('?')[0]
        if (seen.has(clean)) continue
        seen.add(clean)
        // Force JPEG: Cloudinary's f_auto serves AVIF to Chrome, which would
        // mismatch the .jpg extension we save under.
        const jpg = clean.replace(/\bf_auto\b/, 'f_jpg')
        if (pid && jpg.includes(pid)) matched.push(jpg)
        else others.push(jpg)
      }
      return { matched, others }
    }, productId)

    // Fall back rather than returning nothing, but say so — a silent fallback is
    // how this broke unnoticed the first time.
    const imageUrls = collect.matched.length > 0
      ? collect.matched.slice(0, 8)
      : (console.warn(
          `  ! no gallery image contained product id ${productId ?? '(unknown)'} — ` +
            `falling back to ${Math.min(collect.others.length, 8)} unattributed images`,
        ), collect.others.slice(0, 8))

    const slug = slugify(name)
    const localPaths = await downloadImagesViaPage(page, imageUrls, BRAND, slug)

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
    }
  } catch (e) {
    console.warn(`  ✗ Failed to scrape ${url}: ${e}`)
    return null
  }
}

async function run() {
  const urls = await collectProductUrls(MAX_PRODUCTS)
  if (urls.length === 0) {
    console.error('No product URLs found — Aritzia listing structure may have changed or is blocking.')
    process.exit(1)
  }

  const browser = await createBrowser()
  const products: ScrapedProduct[] = []

  try {
    for (let i = 0; i < urls.length; i++) {
      console.log(`\n[${i + 1}/${urls.length}] ${urls[i]}`)
      // Aritzia sticky-blocks a session after its first product page, so use a
      // fresh context (new cookies/fingerprint) for each product.
      const page = await createStealthPage(browser)
      try {
        const product = await scrapeProductPage(page, urls[i])
        if (product) {
          products.push(product)
          console.log(`  ✓ ${product.name} — ${product.image_urls.length} images, material: ${product.material ?? 'n/a'}`)
        }
      } finally {
        await page.context().close()
      }
      await randomDelay(2000, 4000)
    }
  } finally {
    await browser.close()
  }

  saveProducts(BRAND, products)
}

run().catch(console.error)
