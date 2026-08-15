import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, linkSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { OUTPUT_ROOT } from './load.js'

/**
 * Content-addressed image store at output/images/<hash[0:2]>/<hash>.<ext>.
 *
 * Two problems this solves.
 *
 * First, portability: the scraped JSON stores absolute host paths
 * ("/Users/rosali/pprojects/..."), which break for anyone who clones the repo or
 * moves it. Only hashes are persisted to the database.
 *
 * Second, and the reason it matters under a daily cron: the scrapers re-download
 * every image on every run. At 348 MB per run that compounds to ~124 GB/year for
 * a catalog whose images essentially never change. Addressing by content hash
 * makes a repeat download a no-op and lets the vision extractor cache on the
 * image set rather than re-paying per crawl.
 *
 * Files are hard-linked, not copied, so the store costs no additional disk while
 * the original run directories still exist.
 */
export const IMAGE_STORE = path.join(OUTPUT_ROOT, 'images')

const VALID_EXT = new Set(['jpg', 'jpeg', 'png', 'webp'])

function extOf(file: string): string {
  const raw = path.extname(file).replace('.', '').toLowerCase()
  return VALID_EXT.has(raw) ? raw : 'jpg'
}

export function storePathFor(hash: string, ext = 'jpg'): string {
  return path.join(IMAGE_STORE, hash.slice(0, 2), `${hash}.${ext}`)
}

/** Resolve a hash to an on-disk path, trying each permitted extension. */
export function resolveStored(hash: string): string | null {
  for (const ext of VALID_EXT) {
    const p = storePathFor(hash, ext)
    if (existsSync(p)) return p
  }
  return null
}

export interface IngestImagesResult {
  hashes: string[]
  linked: number
  missing: number
}

/**
 * Hash each local image and place it in the store.
 *
 * Missing files are counted and skipped rather than throwing: six Gap products
 * currently have no primary image because two products both named "CloseKnit
 * Jersey T-Shirt" collide on `slugify(name)` and overwrite each other's folder.
 * A whole ingest run must not fail over that.
 */
export function ingestImages(localPaths: string[]): IngestImagesResult {
  const hashes: string[] = []
  let linked = 0
  let missing = 0

  for (const src of localPaths) {
    if (!src || !existsSync(src)) {
      missing++
      continue
    }
    const bytes = readFileSync(src)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const ext = extOf(src)
    const dest = storePathFor(hash, ext)

    if (!existsSync(dest)) {
      mkdirSync(path.dirname(dest), { recursive: true })
      try {
        linkSync(src, dest)
      } catch {
        // Cross-device, or the source is on a different filesystem.
        copyFileSync(src, dest)
      }
      linked++
    }
    // De-duplicate within a product: several brands list the same asset twice.
    if (!hashes.includes(hash)) hashes.push(hash)
  }

  return { hashes, linked, missing }
}

/**
 * Cache key for vision extraction. Sorted so image order changes — which happen
 * whenever a brand reshuffles its gallery — don't force a needless re-extraction.
 */
export function imageSetHash(hashes: string[]): string | null {
  if (hashes.length === 0) return null
  return createHash('sha256').update([...hashes].sort().join(':')).digest('hex')
}
