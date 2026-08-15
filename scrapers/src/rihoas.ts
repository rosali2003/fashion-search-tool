/**
 * Rihoas scraper
 * Tries the Shopify JSON API first (/products.json) — no browser needed, returns all images
 * Falls back to Playwright if not a Shopify store
 */

import { createBrowser, createStealthPage } from './browser.js'
import { sleep, randomDelay, parsePrice, slugify, downloadImages, saveProducts } from './utils.js'
import { normalizeSizes } from './types.js'
import type { ScrapedProduct } from './types.js'

const BRAND = 'rihoas'
const BASE_URL = 'https://www.rihoas.com'
const MAX_PRODUCTS = 100

// ── Shopify API path ──────────────────────────────────────────────────────────

interface ShopifyImage {
  src: string
  alt: string | null
}

interface ShopifyProduct {
  id: number
  title: string
  handle: string
  body_html: string
  vendor: string
  product_type: string
  tags: string[]
  variants: Array<{ price: string; option1?: string | null; option2?: string | null; available?: boolean }>
  /** Shopify option sets, e.g. [{ name: 'Size', values: ['S','M','L'] }]. */
  options?: Array<{ name: string; values: string[] }>
  images: ShopifyImage[]
}

interface ShopifyResponse {
  products: ShopifyProduct[]
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function extractMaterial(body: string): string | null {
  // Rihoas product copy is line-structured (<p>- Fabric: Polyester 95%, ...</p>),
  // so split on block/break tags and inspect each line individually rather than
  // flattening everything first (which makes a greedy regex run on forever).
  const lines = body
    .split(/<\/?(?:p|li|br|div)[^>]*>/i)
    .map((l) => stripHtml(l).replace(/^[-•\s]+/, '').trim())
    .filter(Boolean)

  // Prefer a real composition line (contains a % and a fibre keyword like
  // "Fabric:" / "Material:" / "Composition:"). Fall back to any such label.
  const labelRe = /^(?:fabric|material|composition)\s*:/i
  const composition = lines.find((l) => labelRe.test(l) && /\d+%/.test(l))
  if (composition) return composition.replace(labelRe, '').trim()

  const labelled = lines.find((l) => labelRe.test(l))
  if (labelled) return labelled.replace(labelRe, '').trim()

  // Last resort: any line that lists a fibre percentage (e.g. "Polyester 95%").
  const pct = lines.find((l) => /\d+%/.test(l) && /cotton|polyester|polyamide|spandex|elastane|nylon|wool|linen|viscose|rayon|silk|acrylic/i.test(l))
  return pct ?? null
}

async function scrapeViaShopifyApi(maxProducts: number): Promise<ScrapedProduct[] | null> {
  const allProducts: ScrapedProduct[] = []
  let page = 1
  const limit = 250

  while (allProducts.length < maxProducts) {
    const url = `${BASE_URL}/products.json?limit=${limit}&page=${page}`
    let data: ShopifyResponse

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          Accept: 'application/json',
        },
      })
      if (!res.ok) return null  // not a Shopify store or API disabled
      data = (await res.json()) as ShopifyResponse
    } catch {
      return null
    }

    if (!data.products?.length) break

    for (const item of data.products) {
      if (allProducts.length >= maxProducts) break

      const productUrl = `${BASE_URL}/products/${item.handle}`
      const priceStr = item.variants[0]?.price ?? ''
      const priceCents = priceStr ? Math.round(parseFloat(priceStr) * 100) : null

      // All images from Shopify include every product photo (main + "on-model" swipe)
      const imageUrls = item.images.map((img) => img.src)

      const description = stripHtml(item.body_html)
      const material = extractMaterial(item.body_html)

      // Size range comes free from the Shopify payload already being fetched.
      // Prefer the declared option set; fall back to the per-variant options,
      // which is what products with a single implicit option look like.
      const sizeOption = item.options?.find((o) => /size/i.test(o.name))
      const sizes = sizeOption
        ? normalizeSizes(sizeOption.values)
        : normalizeSizes(item.variants.flatMap((v) => [v.option1, v.option2]))

      const slug = item.handle
      console.log(`  Processing: ${item.title} (${imageUrls.length} images)`)
      const localPaths = await downloadImages(imageUrls, BRAND, slug, productUrl)

      allProducts.push({
        brand: BRAND,
        name: item.title,
        description: description || null,
        material,
        price_cents: priceCents,
        product_url: productUrl,
        image_urls: imageUrls,
        local_image_paths: localPaths,
        scraped_at: new Date().toISOString(),
        size_range: sizes,
      })
    }

    if (data.products.length < limit) break
    page++
  }

  return allProducts
}

// ── Playwright fallback ───────────────────────────────────────────────────────

async function collectProductUrlsPlaywright(limit: number): Promise<string[]> {
  const browser = await createBrowser()
  const page = await createStealthPage(browser)
  const urls: string[] = []

  try {
    await page.goto(`${BASE_URL}/collections/all`, { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(2000)

    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2))
      await sleep(1200)
    }

    const hrefs = await page.$$eval('a[href*="/products/"]', (els) =>
      [...new Set(els.map((el) => (el as HTMLAnchorElement).href))]
    )

    for (const href of hrefs) {
      urls.push(href)
      if (urls.length >= limit) break
    }
  } finally {
    await browser.close()
  }

  return urls
}

async function scrapeProductPagePlaywright(
  page: Awaited<ReturnType<typeof createStealthPage>>,
  url: string
): Promise<ScrapedProduct | null> {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(1200)

    const name = await page
      .$eval('h1, .product__title, .product-title', (el) => el.textContent?.trim() ?? '')
      .catch(() => '')
    if (!name) return null

    const priceText = await page
      .$eval('.price, .product__price, [class*="price"]', (el) => el.textContent?.trim() ?? '')
      .catch(() => '')

    const description = await page
      .$eval('.product__description, .product-description, [class*="description"]', (el) =>
        el.textContent?.trim() ?? ''
      )
      .catch(() => null)

    const material = description ? extractMaterial(description) : null

    // Collect all gallery images (Shopify themes put them in .product-media-gallery or similar)
    const imageUrls: string[] = await page.evaluate(() => {
      const imgs = Array.from(
        document.querySelectorAll<HTMLImageElement>(
          '.product-media-gallery img, .product__media img, [class*="gallery"] img, [class*="carousel"] img'
        )
      )
      const seen = new Set<string>()
      const result: string[] = []
      for (const img of imgs) {
        const src = img.dataset.src || img.dataset.lazySrc || img.src || ''
        if (!src || src.includes('svg')) continue
        // Use srcset largest variant if available
        const srcset = img.srcset
        const candidate = srcset
          ? srcset.split(',').pop()?.trim().split(' ')[0] ?? src
          : src
        const clean = candidate.split('?')[0]
        if (!seen.has(clean)) {
          seen.add(clean)
          result.push(candidate)
        }
      }
      return result
    })

    // Swipe to next carousel image if only 1 found
    if (imageUrls.length < 2) {
      const next = await page.$('[aria-label*="next" i], .slider__next, [class*="next-slide"]')
      if (next) {
        await next.click()
        await sleep(700)
        const more = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLImageElement>('[class*="gallery"] img, [class*="carousel"] img'))
            .map(img => img.dataset.src || img.src || '')
            .filter(s => s && !s.includes('svg'))
        )
        for (const u of more) {
          if (!imageUrls.some(x => x.split('?')[0] === u.split('?')[0])) imageUrls.push(u)
        }
      }
    }

    const slug = url.split('/products/')[1]?.split('?')[0] ?? slugify(name)
    const localPaths = await downloadImages(imageUrls, BRAND, slug, url)

    return {
      brand: BRAND,
      name,
      description: description ?? null,
      material,
      price_cents: parsePrice(priceText),
      product_url: url,
      image_urls: imageUrls,
      local_image_paths: localPaths,
      scraped_at: new Date().toISOString(),
    }
  } catch (e) {
    console.warn(`  ✗ Failed: ${url}: ${e}`)
    return null
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function run() {
  console.log('Rihoas scraper starting...')
  console.log('Trying Shopify JSON API...')

  let products = await scrapeViaShopifyApi(MAX_PRODUCTS)

  if (products && products.length > 0) {
    console.log(`Shopify API worked! Got ${products.length} products.`)
  } else {
    console.log('Shopify API unavailable — falling back to Playwright...')
    const urls = await collectProductUrlsPlaywright(MAX_PRODUCTS)
    if (urls.length === 0) {
      console.error('No product URLs found.')
      process.exit(1)
    }

    const browser = await createBrowser()
    const page = await createStealthPage(browser)
    products = []

    try {
      for (let i = 0; i < urls.length; i++) {
        console.log(`\n[${i + 1}/${urls.length}] ${urls[i]}`)
        const product = await scrapeProductPagePlaywright(page, urls[i])
        if (product) {
          products.push(product)
          console.log(`  ✓ ${product.name} — ${product.image_urls.length} images`)
        }
        await randomDelay(1000, 2500)
      }
    } finally {
      await browser.close()
    }
  }

  saveProducts(BRAND, products)
}

run().catch(console.error)
