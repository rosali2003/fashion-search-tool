/**
 * Sézane scraper — attaches to a Chrome you launched yourself. macOS only.
 *
 * ── Why this one is different ────────────────────────────────────────────────
 *
 * sezane.com sits behind DataDome, which refused every automated approach tried:
 *
 *   Playwright chromium, headless            403
 *   Playwright chromium, headed              403
 *   Playwright channel:'chrome', headless    403
 *   Playwright channel:'chrome', headed      403
 *   connectOverCDP + page.goto()             403
 *   connectOverCDP + location.href assign    403
 *
 * What works is navigating the tab the way a person does. With the same
 * CDP-attached Chrome, driving the address bar through AppleScript loads the
 * page normally, and CDP then reads the DOM without complaint. DataDome is
 * blocking CDP-INITIATED NAVIGATION, not CDP attachment.
 *
 * So: AppleScript navigates, CDP reads. Product URLs come from sitemap-us.xml,
 * which is plain-fetchable and not behind the wall at all.
 *
 * ── Running it ───────────────────────────────────────────────────────────────
 *
 *   1. Quit Chrome, then relaunch it with the debugging port open:
 *        /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *          --remote-debugging-port=9222
 *   2. pnpm scrape:sezane
 *
 * This is deliberately NOT in ALL_BRANDS (scrapers/src/run.ts). `pnpm refresh`
 * runs unattended from launchd, and this scraper needs a human-launched browser,
 * so including it would fail the nightly run every night.
 *
 * It is also the most fragile scraper in the repo: DataDome changes its
 * detection regularly, and the day it starts fingerprinting CDP attachment this
 * approach stops working. It fails loudly rather than emitting empty products.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium, type Browser, type Page } from 'playwright'
import { parsePrice, saveProducts, sleep, randomDelay, downloadImages } from './utils.js'
import { normalizeSizes } from './types.js'
import { readJsonLd, offerList, stripHtml, decodeEntities, extractFibers } from './jsonld.js'
import type { ScrapedProduct } from './types.js'

const execFileAsync = promisify(execFile)

const BRAND = 'sezane'
const BASE_URL = 'https://www.sezane.com'
const SITEMAP_URL = `${BASE_URL}/sitemap-us.xml`
const CDP_ENDPOINT = process.env.SEZANE_CDP_URL ?? 'http://127.0.0.1:9222'
const MAX_PRODUCTS = 50

/**
 * Sézane sells furniture, tableware and beauty out of the same sitemap
 * (`001-bedside-table`, `001-pitcher-and-jug`, `1960s-solid-oak-sideboard`).
 * Only clothing belongs in the corpus.
 */
const SKIP_SLUG_RE =
  /table|pitcher|jug|sideboard|chair|lamp|cushion|candle|vase|bowl|plate|mug|rug|mirror|frame|book|perfume|fragrance|shoe|sneaker|boot|sandal|heel|loafer|ballerina|bag|tote|pouch|wallet|belt|jewel|earring|necklace|bracelet|ring-|scarf|hat|glove|sock|gift-card/i

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/xml,text/xml,*/*',
}

// ── URL collection (plain fetch — the sitemap is not DataDome-guarded) ────────

async function collectProductUrls(limit: number): Promise<string[]> {
  console.log(`Fetching sitemap ${SITEMAP_URL}`)
  const res = await fetch(SITEMAP_URL, { headers: COMMON_HEADERS })
  if (!res.ok) throw new Error(`sitemap returned HTTP ${res.status}`)
  const xml = await res.text()

  const all = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim())
  const urls = all.filter((u) => /\/us-en\/product\//.test(u) && !SKIP_SLUG_RE.test(u))

  console.log(`  ${all.length} sitemap entries, ${urls.length} clothing product URLs`)
  return urls.slice(0, limit)
}

// ── Browser attach ────────────────────────────────────────────────────────────

async function attach(): Promise<Browser> {
  try {
    const res = await fetch(`${CDP_ENDPOINT}/json/version`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch {
    console.error(
      `\nNo Chrome listening on ${CDP_ENDPOINT}.\n\n` +
        'Quit Chrome, then relaunch it with the debugging port open:\n\n' +
        '  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n\n' +
        'then run this scraper again.\n'
    )
    process.exit(1)
  }

  // Chrome with no open tab exposes no page target, and connectOverCDP then
  // fails with "Browser context management is not supported" — which says
  // nothing about the actual cause. Check first and say the useful thing.
  try {
    const targets = (await (await fetch(`${CDP_ENDPOINT}/json/list`, { signal: AbortSignal.timeout(4000) })).json()) as unknown[]
    if (!Array.isArray(targets) || targets.length === 0) {
      console.error(
        `\nChrome is listening on ${CDP_ENDPOINT} but has no open tab.\n` +
          'Open any tab in that window, then run this scraper again.\n'
      )
      process.exit(1)
    }
  } catch {
    // Non-fatal: if the probe itself fails, let connectOverCDP report.
  }

  return chromium.connectOverCDP(CDP_ENDPOINT)
}

/**
 * Navigate by driving the address bar, because page.goto() is what DataDome
 * refuses.
 *
 * The tab is addressed by its exact current URL rather than by index or
 * frontmost-ness, which matters for two reasons. AppleScript addresses Chrome by
 * bundle, so if a second Chrome instance is running it may reach the user's
 * everyday browser instead of ours — and steering someone's real tab to a
 * scraper URL would be unacceptable. Matching on a URL only our tab holds means
 * the wrong-instance case raises "could not find the tab" and stops, instead of
 * hijacking. That is also why the tab is parked on a unique sentinel first: a
 * bare about:blank could easily collide with a tab the user has open.
 */
async function navigateViaUi(currentUrl: string, targetUrl: string): Promise<void> {
  const script = `
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t is "${currentUrl}" then
            set URL of t to "${targetUrl}"
            return "ok"
          end if
        end repeat
      end repeat
      return "not-found"
    end tell`

  const { stdout } = await execFileAsync('osascript', ['-e', script])
  if (stdout.trim() === 'not-found') {
    throw new Error(`could not find the tab at ${currentUrl} to navigate`)
  }
}

/** DataDome's interstitial: the title is the bare domain and the body is empty. */
async function isBlocked(page: Page): Promise<boolean> {
  const title = await page.title().catch(() => '')
  if (!/^sezane\.com$/i.test(title.trim())) return false
  const len = await page.evaluate(() => document.body.innerText.trim().length).catch(() => 0)
  return len === 0
}

/** Poll until the tab has settled on the target URL with content rendered. */
async function waitForLoad(page: Page, targetUrl: string, timeoutMs = 25000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(1000)
    const url = page.url()
    if (!url.startsWith(targetUrl.split('?')[0])) continue
    const ready = await page
      .evaluate(() => document.readyState === 'complete' && document.body.innerText.trim().length > 200)
      .catch(() => false)
    if (ready) return true
  }
  return false
}

// ── Extraction ────────────────────────────────────────────────────────────────

interface Extracted {
  name: string
  description: string | null
  priceText: string
  sizes: string[]
  images: string[]
  bodyText: string
  hiddenText: string
}

/**
 * Read the PDP.
 *
 * Sézane publishes a schema.org Product block, so name, description and price
 * come from there. Images and sizes do not: the structured data carries a single
 * hero image and no sizes at all, so both are read from the DOM — with the
 * scoping rules below, which are the whole difficulty of this page.
 */
async function extract(page: Page): Promise<Extracted> {
  const ldBlocks = await page
    .$$eval('script[type="application/ld+json"]', (els) => els.map((el) => el.textContent ?? ''))
    .catch(() => [] as string[])
  const ld = readJsonLd(ldBlocks, 'Product')

  // NOTE: no named function bindings inside this evaluate body. tsx compiles
  // `const f = () => {}` with an esbuild `__name(...)` wrapper for stack traces,
  // and that helper does not exist in the page, so the whole evaluate dies with
  // "ReferenceError: __name is not defined". Everything here stays inline.
  const dom = await page.evaluate(() => ({
    h1: document.querySelector('h1')?.textContent?.trim() ?? '',
    price: document.querySelector('[class*="price" i]')?.textContent?.trim() ?? '',
    description: document.querySelector('[class*="description" i]')?.textContent?.trim() ?? '',
    // Sizes must come from THIS product's picker only.
    //
    // A bare `[class*="size"]` sweep returns 127 elements, because every
    // recommended product card at the bottom of the page carries its own
    // "quickshop" size list. That produced 34 sizes for a pair of jeans sold in
    // ten — a mix of this garment's waist run, other garments' letter sizes, and
    // shoe sizes from a recommended pair of boots. Excluding the product-card
    // subtrees leaves the real picker
    // (ul.sticky-switch-size-dropdown > li.c-switch__item).
    sizes: Array.from(
      document.querySelectorAll('[class*="size" i] button, [class*="size" i] li, [data-size]')
    )
      .filter(
        (e) =>
          !e.closest('[class*="quickshop" i], [class*="card-product" i], [class*="recommend" i]')
      )
      .map((e) => e.getAttribute('data-size') ?? e.textContent?.trim() ?? '')
      .filter(Boolean),
    // Gallery shots are portrait (w_616,h_822); the editorial banners sharing
    // the page are landscape (w_616,h_346). Sézane's Cloudinary asset ids are
    // random hashes with no product code in them, so there is nothing to match
    // on — but the aspect ratio separates product photography from banner art.
    images: Array.from(
      new Set(
        Array.from(document.querySelectorAll('img'))
          .map((i) => i.currentSrc || i.src || i.getAttribute('data-src') || '')
          .filter((s) => {
            if (!/media\.sezane\.com/.test(s) || !/\.(jpe?g|png|webp)/i.test(s)) return false
            const w = Number(s.match(/[,/]w_(\d+)/)?.[1] ?? 0)
            const h = Number(s.match(/[,/]h_(\d+)/)?.[1] ?? 0)
            return w > 0 && h > w // portrait only
          })
      )
    ),
    bodyText: document.body.innerText,
    // innerText omits collapsed content, and Sézane keeps the fibre composition
    // inside a "DETAILS & COMPOSITION" accordion that starts shut. textContent
    // sees it regardless of whether the panel has been opened.
    hiddenText: (document.body.textContent ?? '').replace(/\s+/g, ' '),
  }))

  const offers = offerList(ld?.offers)
  return {
    name: decodeEntities(ld?.name?.trim() || dom.h1).trim(),
    description: ld?.description ? stripHtml(ld.description) : dom.description || null,
    priceText: String(offers[0]?.price ?? dom.price),
    sizes: normalizeSizes([...offers.map((o) => o.size ?? null), ...dom.sizes]),
    // The DOM gallery is preferred over JSON-LD here, unlike the other scrapers:
    // Sézane's `image` field is a single hero shot, while the page carries the
    // full set. JSON-LD is only the fallback when the gallery reads empty.
    images: (dom.images.length > 0
      ? dom.images
      : Array.isArray(ld?.image)
        ? ld.image
        : ld?.image
          ? [ld.image]
          : []
    ).slice(0, 8),
    bodyText: dom.bodyText,
    hiddenText: dom.hiddenText,
  }
}

async function scrapeProductPage(page: Page, url: string): Promise<ScrapedProduct | null> {
  try {
    await navigateViaUi(page.url(), url)

    if (!(await waitForLoad(page, url))) {
      if (await isBlocked(page)) throw new Error('DATADOME_BLOCK')
      console.warn('  ✗ page did not finish loading — skipping')
      return null
    }
    if (await isBlocked(page)) throw new Error('DATADOME_BLOCK')

    const data = await extract(page)
    if (!data.name) {
      console.warn('  ✗ no product name — markup may have changed')
      return null
    }
    if (data.images.length === 0) {
      console.warn('  ✗ no product images — skipping')
      return null
    }

    const slug = url.split('/product/')[1]?.replace(/\//g, '-') ?? 'product'
    const localPaths = await downloadImages(data.images, BRAND, slug, url)
    if (localPaths.length === 0) {
      console.warn('  ✗ no image downloaded — skipping')
      return null
    }

    return {
      brand: BRAND,
      name: data.name,
      description: data.description,
      material:
        extractFibers(data.description) ??
        extractFibers(data.bodyText) ??
        extractFibers(data.hiddenText),
      price_cents: parsePrice(data.priceText),
      product_url: url,
      image_urls: data.images,
      local_image_paths: localPaths,
      scraped_at: new Date().toISOString(),
      size_range: data.sizes,
    }
  } catch (e) {
    if (e instanceof Error && e.message === 'DATADOME_BLOCK') throw e
    console.warn(`  ✗ Failed to scrape ${url}: ${e}`)
    return null
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  if (process.platform !== 'darwin') {
    console.error('The Sézane scraper drives Chrome through AppleScript and only runs on macOS.')
    process.exit(1)
  }

  console.log('Sezane scraper starting (CDP attach + UI navigation)...')
  const urls = await collectProductUrls(MAX_PRODUCTS)
  if (urls.length === 0) {
    console.error(`No product URLs found — check ${SITEMAP_URL}`)
    process.exit(1)
  }

  const browser = await attach()
  const context = browser.contexts()[0]
  if (!context) {
    console.error('Attached to Chrome but it has no browsing context — open a window and retry.')
    process.exit(1)
  }

  // Work in a dedicated tab so the user's own tabs are left alone, parked on a
  // sentinel URL unique to this run so AppleScript can address it unambiguously.
  // Navigating to about: is a CDP navigation, but DataDome only guards
  // sezane.com, so it is unaffected.
  const page = await context.newPage()
  const sentinel = `about:blank#ink-sezane-${process.pid}`
  await page.goto(sentinel).catch(() => {})

  const products: ScrapedProduct[] = []

  try {
    // Warm up on the homepage before touching a product page.
    //
    // This is not politeness, it is required: on a Chrome profile with no
    // DataDome clearance cookie, the first navigation straight to a PDP is
    // refused, while the same PDP loads fine once the homepage has been visited
    // and the challenge has resolved. It also happens to be how a person browses.
    console.log('Warming up on the homepage to clear the DataDome challenge...')
    await navigateViaUi(page.url(), `${BASE_URL}/us-en`)
    await waitForLoad(page, `${BASE_URL}/us-en`, 30000)
    if (await isBlocked(page)) throw new Error('DATADOME_BLOCK')
    console.log('  cleared.')
    await randomDelay(2000, 4000)

    for (let i = 0; i < urls.length; i++) {
      console.log(`\n[${i + 1}/${urls.length}] ${urls[i]}`)
      const product = await scrapeProductPage(page, urls[i])
      if (product) {
        products.push(product)
        console.log(
          `  ✓ ${product.name} — ${product.image_urls.length} images, ${product.size_range?.length ?? 0} sizes, material: ${product.material ?? 'n/a'}`
        )
      }
      await randomDelay(2500, 5000)
    }
  } catch (e) {
    if (e instanceof Error && e.message === 'DATADOME_BLOCK') {
      console.error(
        '\nDataDome is blocking this session.\n' +
          'Load https://www.sezane.com/us-en manually in that Chrome window, clear the\n' +
          'challenge, and run again. If it keeps happening, DataDome has likely started\n' +
          'detecting the CDP attachment and this approach no longer works.\n'
      )
    } else {
      throw e
    }
  } finally {
    await page.close().catch(() => {})
    // Detach only — never close a browser the user launched.
    await browser.close().catch(() => {})
  }

  if (products.length === 0) {
    console.error('No products scraped.')
    process.exit(1)
  }

  saveProducts(BRAND, products)
}

run().catch(console.error)
