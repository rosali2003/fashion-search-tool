/**
 * Gap scraper
 *
 * Listing: women's "Shop All Styles" (cid=1127938). The old cid=1159338 now
 * resolves to an out-of-stock/error page.
 *
 * Gap product pages expose a clean JSON-LD Product block, so name / description /
 * price come from there. Images are taken from the on-page gallery and the fabric
 * composition is read from the "Fabric & care" copy.
 */

import { createBrowser, createStealthPage } from './browser.js'
import { sleep, randomDelay, parsePrice, slugify, downloadImages, saveProducts } from './utils.js'
import { readJsonLd, offerList, stripHtml, FIBER_RE } from './jsonld.js'
import type { ScrapedProduct } from './types.js'
import type { Page } from 'playwright'

const BRAND = 'gap'
const BASE_URL = 'https://www.gap.com'
// Women → Categories → Shop All Styles
const LISTING_URL = `${BASE_URL}/browse/category.do?cid=1127938`
const MAX_PRODUCTS = 50

async function collectProductUrls(limit: number): Promise<string[]> {
  const browser = await createBrowser()
  const page = await createStealthPage(browser)
  const urls: string[] = []
  const seen = new Set<string>()

  try {
    console.log(`Navigating to ${LISTING_URL}`)
    await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(3000)

    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5))
      await sleep(1200)
    }

    const hrefs = await page.$$eval('a[href*="product.do?pid="]', (els) =>
      els.map((el) => (el as HTMLAnchorElement).href)
    )

    for (const href of hrefs) {
      // Canonicalise to just the pid so tracking params / colour links collapse.
      const pid = href.match(/pid=(\d+)/)?.[1]
      if (!pid || seen.has(pid)) continue
      seen.add(pid)
      urls.push(`${BASE_URL}/browse/product.do?pid=${pid}`)
      if (urls.length >= limit) break
    }

    console.log(`Found ${urls.length} product URLs`)
  } finally {
    await browser.close()
  }

  return urls
}

async function scrapeProductPage(page: Page, url: string): Promise<ScrapedProduct | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(3000)

    const ldBlocks = await page.$$eval('script[type="application/ld+json"]', (els) =>
      els.map((el) => el.textContent ?? '')
    )
    const ld = readJsonLd(ldBlocks)

    const name = ld?.name?.trim() || (await page.$eval('h1', (el) => el.textContent?.trim() ?? '').catch(() => ''))
    if (!name) return null

    const description = ld?.description ? stripHtml(ld.description) : null

    // Price from the JSON-LD offers (first offer / single offer).
    const priceText = String(offerList(ld?.offers)[0]?.price ?? '')
    const priceCents = priceText ? parsePrice(priceText) : null

    // Material — read the fabric composition from the page copy.
    const material = await page
      .evaluate((reSource) => {
        const re = new RegExp(reSource, 'i')
        const m = document.body.innerText.match(re)
        return m ? m[0].trim() : null
      }, FIBER_RE.source)
      .catch(() => null)

    // Images — the product gallery on Gap's CDN (webcontent). Take the first few,
    // which are this product's shots (recommendations come later in the DOM).
    const imageUrls: string[] = await page.evaluate(() => {
      const imgs = Array.from(
        document.querySelectorAll<HTMLImageElement>(
          '[class*="product" i] img, [class*="gallery" i] img, [class*="thumb" i] img'
        )
      )
      const seen = new Set<string>()
      const out: string[] = []
      for (const img of imgs) {
        const src = img.src || img.getAttribute('data-src') || ''
        if (!/webcontent/i.test(src)) continue
        const clean = src.split('?')[0]
        if (seen.has(clean)) continue
        seen.add(clean)
        out.push(src)
      }
      return out.slice(0, 6)
    })

    // The pid must be in the slug. Gap sells one style in several colourways under
    // the same name, each with its own product page: three separate pages are all
    // called "CloseKnit Jersey T-Shirt". Slugging on name alone made them share an
    // image folder and overwrite each other, which is why six Gap products ended up
    // with no primary image at all.
    const pid = url.match(/pid=(\d+)/)?.[1]
    const slug = pid ? `${slugify(name)}-${pid}` : slugify(name)
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
    }
  } catch (e) {
    console.warn(`  ✗ Failed to scrape ${url}: ${e}`)
    return null
  }
}

async function run() {
  const urls = await collectProductUrls(MAX_PRODUCTS)
  if (urls.length === 0) {
    console.error('No product URLs found — the Gap category id may have changed (check cid=1127938).')
    process.exit(1)
  }

  const browser = await createBrowser()
  const page = await createStealthPage(browser)
  const products: ScrapedProduct[] = []

  try {
    for (let i = 0; i < urls.length; i++) {
      console.log(`\n[${i + 1}/${urls.length}] ${urls[i]}`)
      const product = await scrapeProductPage(page, urls[i])
      if (product) {
        products.push(product)
        console.log(`  ✓ ${product.name} — ${product.image_urls.length} images, material: ${product.material ?? 'n/a'}`)
      }
      await randomDelay(1500, 3500)
    }
  } finally {
    await browser.close()
  }

  saveProducts(BRAND, products)
}

run().catch(console.error)
