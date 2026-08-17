/**
 * Run all scrapers sequentially.
 * Usage:
 *   tsx src/run.ts                  # all brands
 *   tsx src/run.ts aritzia gap      # specific brands
 */

import { execSync } from 'child_process'
import path from 'path'

// tsx lives in node_modules/.bin, which isn't necessarily on PATH when this
// orchestrator is launched, so resolve the local binary explicitly.
const scrapersRoot = new URL('..', import.meta.url).pathname
const tsxBin = path.join(scrapersRoot, 'node_modules', '.bin', 'tsx')

// `sezane` is deliberately absent. It attaches to a Chrome the user launched by
// hand (see the header of sezane.ts), so it cannot run in the unattended cron
// this orchestrator backs — it would fail the nightly run every night. Scrape it
// with `pnpm scrape:sezane` when you want it.
const ALL_BRANDS = [
  'rihoas',
  'uniqlo',
  'gap',
  'aritzia',
  'everlane',
  'skims',
  'reformation',
  'madewell',
] as const
type Brand = typeof ALL_BRANDS[number]

const requested = process.argv.slice(2) as Brand[]
const brands = requested.length > 0
  ? requested.filter(b => (ALL_BRANDS as readonly string[]).includes(b))
  : [...ALL_BRANDS]

if (brands.length === 0) {
  console.error(`Unknown brand(s). Valid: ${ALL_BRANDS.join(', ')}`)
  process.exit(1)
}

// Share a single run timestamp across all child scrapers so they write into the
// same output/<timestamp>/ directory instead of one folder each.
const runTimestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
process.env.SCRAPE_TIMESTAMP = runTimestamp

console.log(`Running scrapers: ${brands.join(', ')}`)
console.log(`Output → output/${runTimestamp}/\n`)

for (const brand of brands) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${brand.toUpperCase()}`)
  console.log('='.repeat(60))
  try {
    execSync(`"${tsxBin}" src/${brand}.ts`, {
      stdio: 'inherit',
      cwd: scrapersRoot,
    })
  } catch (e) {
    console.error(`Scraper for ${brand} failed — continuing with next brand`)
  }
}

console.log('\nAll scrapers done. Check output/ for JSON files and output/images/ for photos.')
