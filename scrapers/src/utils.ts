import { writeFileSync, mkdirSync, createWriteStream } from 'fs'
import path from 'path'
import type { ScrapedProduct } from './types.js'

// Every scrape run writes into output/<timestamp>/. When several scrapers are
// launched together (run.ts), the shared timestamp is passed down via the
// SCRAPE_TIMESTAMP env var so they all land in the same directory; a scraper run
// on its own falls back to its own timestamp.
export const RUN_TIMESTAMP =
  process.env.SCRAPE_TIMESTAMP || new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')

const OUTPUT_ROOT = new URL('../../output', import.meta.url).pathname
export const RUN_DIR = path.join(OUTPUT_ROOT, RUN_TIMESTAMP)

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export const randomDelay = (min = 1000, max = 3000) =>
  sleep(Math.floor(Math.random() * (max - min) + min))

export function parsePrice(text: string): number | null {
  const match = text.replace(/,/g, '').match(/\d+\.?\d*/)
  if (!match) return null
  return Math.round(parseFloat(match[0]) * 100)
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

export async function downloadImages(
  urls: string[],
  brand: string,
  slug: string,
  referer: string
): Promise<string[]> {
  const dir = path.join(RUN_DIR, 'images', brand, slug)
  mkdirSync(dir, { recursive: true })

  const localPaths: string[] = []

  for (let i = 0; i < urls.length; i++) {
    const rawUrl = urls[i].split('?')[0]
    const ext = rawUrl.split('.').pop()?.toLowerCase() || 'jpg'
    const validExt = ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'jpg'
    const filename = path.join(dir, `${i + 1}.${validExt}`)

    try {
      const res = await fetch(urls[i], {
        headers: {
          Referer: referer,
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      })

      if (res.ok) {
        const buf = await res.arrayBuffer()
        writeFileSync(filename, Buffer.from(buf))
        localPaths.push(filename)
        console.log(`  ↓ image ${i + 1}/${urls.length}`)
      } else {
        console.warn(`  ✗ image ${i + 1} HTTP ${res.status}: ${urls[i]}`)
      }
    } catch (e) {
      console.warn(`  ✗ image ${i + 1} failed: ${urls[i]}`)
    }

    await sleep(200)
  }

  return localPaths
}

/**
 * Download images through the page's own browser context. Needed for CDNs that
 * 403 direct/programmatic requests (e.g. Aritzia's Cloudinary hotlink protection)
 * but happily serve the bytes to fetch() running on the page's origin.
 */
export async function downloadImagesViaPage(
  page: { evaluate: <T, A>(fn: (arg: A) => T | Promise<T>, arg: A) => Promise<T> },
  urls: string[],
  brand: string,
  slug: string
): Promise<string[]> {
  const dir = path.join(RUN_DIR, 'images', brand, slug)
  mkdirSync(dir, { recursive: true })

  const localPaths: string[] = []

  for (let i = 0; i < urls.length; i++) {
    const rawUrl = urls[i].split('?')[0]
    const ext = rawUrl.split('.').pop()?.toLowerCase() || 'jpg'
    const validExt = ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'jpg'
    const filename = path.join(dir, `${i + 1}.${validExt}`)

    try {
      const base64 = await page.evaluate(async (url) => {
        const res = await fetch(url)
        if (!res.ok) return null
        const buf = await res.arrayBuffer()
        let binary = ''
        const bytes = new Uint8Array(buf)
        for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j])
        return btoa(binary)
      }, urls[i])

      if (base64) {
        writeFileSync(filename, Buffer.from(base64, 'base64'))
        localPaths.push(filename)
        console.log(`  ↓ image ${i + 1}/${urls.length}`)
      } else {
        console.warn(`  ✗ image ${i + 1} failed: ${urls[i]}`)
      }
    } catch (e) {
      console.warn(`  ✗ image ${i + 1} error: ${urls[i]}`)
    }

    await sleep(150)
  }

  return localPaths
}

export function saveProducts(brand: string, products: ScrapedProduct[]): void {
  mkdirSync(RUN_DIR, { recursive: true })
  const file = path.join(RUN_DIR, `${brand}_products.json`)
  writeFileSync(file, JSON.stringify(products, null, 2))
  console.log(`\nSaved ${products.length} products → ${file}`)
}
