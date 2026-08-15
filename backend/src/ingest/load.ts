import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateScraped, type ScrapedProduct } from './types.js'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const OUTPUT_ROOT = path.join(REPO_ROOT, 'output')

/**
 * The newest run directory under output/.
 *
 * Run directories are named from a timestamp (`RUN_TIMESTAMP` in
 * scrapers/src/utils.ts), so lexicographic order is chronological order — with
 * one caveat: the existing corpus lives in a hand-renamed `2026-06-28-legacy`
 * directory, which still sorts correctly by date prefix.
 */
export function latestRunDir(): string {
  if (!existsSync(OUTPUT_ROOT)) {
    throw new Error(`No output/ directory at ${OUTPUT_ROOT}. Run \`pnpm scrape:all\` first.`)
  }
  const dirs = readdirSync(OUTPUT_ROOT)
    .filter((d) => {
      const full = path.join(OUTPUT_ROOT, d)
      if (!statSync(full).isDirectory()) return false
      // `images` is the content-addressed store, not a run.
      if (d === 'images') return false
      return readdirSync(full).some((f) => f.endsWith('_products.json'))
    })
    .sort()

  const newest = dirs.at(-1)
  if (!newest) throw new Error(`No run directories with *_products.json under ${OUTPUT_ROOT}`)
  return path.join(OUTPUT_ROOT, newest)
}

export interface BrandFile {
  brand: string
  file: string
  products: ScrapedProduct[]
}

/** Read and validate every `<brand>_products.json` in a run directory. */
export function loadRun(runDir: string, brands?: string[]): BrandFile[] {
  if (!existsSync(runDir)) throw new Error(`Run directory not found: ${runDir}`)

  const files = readdirSync(runDir)
    .filter((f) => f.endsWith('_products.json'))
    .sort()

  const out: BrandFile[] = []
  for (const file of files) {
    const brand = file.replace(/_products\.json$/, '').toLowerCase()
    if (brands && brands.length > 0 && !brands.includes(brand)) continue

    const full = path.join(runDir, file)
    const parsed: unknown = JSON.parse(readFileSync(full, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array`)

    const products = parsed.map((row, i) => validateScraped(row, `${file}[${i}]`))

    // The brand field inside the records is authoritative; the filename is only
    // a hint. Flag mismatches rather than trusting either silently.
    for (const p of products) {
      if (p.brand.toLowerCase() !== brand) {
        throw new Error(
          `${file}: record brand "${p.brand}" does not match filename brand "${brand}"`,
        )
      }
    }

    out.push({ brand, file: full, products })
  }

  if (out.length === 0) {
    throw new Error(`No matching *_products.json in ${runDir}${brands ? ` for brands ${brands.join(',')}` : ''}`)
  }
  return out
}
