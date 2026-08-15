/**
 * Ingest CLI.
 *
 *   pnpm --filter backend ingest
 *   pnpm --filter backend ingest -- --dir output/2026-06-28-legacy
 *   pnpm --filter backend ingest -- --brands gap,uniqlo --report
 *   pnpm --filter backend ingest -- --dry-run
 *
 * Phase A only: deterministic normalisation, no network and no LLM. The LLM text
 * and vision passes are separate commands driven by database predicates, so they
 * are resumable and so this command stays runnable without an API key.
 */
import path from 'node:path'
import { db } from '../db/index.js'
import { loadRun, latestRunDir, REPO_ROOT } from './load.js'
import { normalizeProduct, type NormalizeStats } from './normalize.js'
import { upsertBrand, recordRun, coverageReport } from './upsert.js'

interface Args {
  dir?: string
  brands?: string[]
  dryRun: boolean
  report: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, report: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i]
    else if (a === '--brands') out.brands = argv[++i]?.split(',').map((s) => s.trim().toLowerCase())
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--report') out.report = true
  }
  return out
}

const pct = (n: number, d: number) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1)}%`.padStart(6))

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const runDir = args.dir
    ? path.resolve(REPO_ROOT, args.dir)
    : latestRunDir()

  console.log(`ingest: ${path.relative(REPO_ROOT, runDir)}${args.dryRun ? '  [dry run]' : ''}`)

  const brandFiles = loadRun(runDir, args.brands)
  const sourceRun = path.basename(runDir)
  const stats: NormalizeStats = { imagesLinked: 0, imagesMissing: 0 }

  let totalSeen = 0
  let totalInserted = 0
  let totalUpdated = 0
  let totalSkipped = 0
  let totalDeactivated = 0

  for (const bf of brandFiles) {
    const started = Date.now()
    const rows = bf.products.map((p) => normalizeProduct(p, sourceRun, stats))

    // Within-run duplicate URLs would make the upsert order-dependent. The
    // scrapers dedupe per run, so this is a tripwire rather than an expectation.
    const urls = new Set<string>()
    for (const r of rows) {
      const u = r.product_url as string
      if (urls.has(u)) throw new Error(`${bf.brand}: duplicate product_url in run: ${u}`)
      urls.add(u)
    }

    if (args.dryRun) {
      console.log(`  ${bf.brand.padEnd(8)} ${String(rows.length).padStart(3)} products normalised (not written)`)
      continue
    }

    const s = await upsertBrand(bf.brand, rows)
    const ms = Date.now() - started
    await recordRun(sourceRun, bf.brand, s, { durationMs: ms })

    totalSeen += s.seen
    totalInserted += s.inserted
    totalUpdated += s.updated
    totalSkipped += s.skippedUnchanged
    totalDeactivated += s.deactivated

    const guard = s.deactivationSkipped
      ? '  DEACTIVATION SKIPPED (run had <50% of active products — suspected partial scrape)'
      : ''
    console.log(
      `  ${bf.brand.padEnd(8)} seen ${String(s.seen).padStart(3)}` +
        `  +${s.inserted}  ~${s.updated}  =${s.skippedUnchanged}  -${s.deactivated}  ${ms}ms${guard}`,
    )
  }

  if (!args.dryRun) {
    console.log(
      `\ntotal: seen ${totalSeen}  inserted ${totalInserted}  updated ${totalUpdated}` +
        `  unchanged ${totalSkipped}  deactivated ${totalDeactivated}`,
    )
  }
  console.log(`images: ${stats.imagesLinked} linked into store, ${stats.imagesMissing} missing on disk`)

  if (args.report && !args.dryRun) {
    const c = (await coverageReport()) as Record<string, number>
    const t = Number(c.total)
    console.log(`\ncoverage over ${t} active products (deterministic rules only):`)
    for (const key of [
      'category', 'silhouette', 'neckline', 'details',
      'fibers', 'material_clean', 'natural_ratio', 'images',
    ]) {
      console.log(`  ${key.padEnd(16)} ${pct(Number(c[key]), t)}  (${c[key]})`)
    }
    console.log(`  ${'fibers_incomplete'.padEnd(16)} ${String(c.fibers_incomplete).padStart(6)}`)
    console.log(`  ${'conflicts'.padEnd(16)} ${String(c.conflicts).padStart(6)}`)
    console.log(`  ${'vision_done'.padEnd(16)} ${String(c.vision_done).padStart(6)}`)
  }
}

try {
  await main()
} finally {
  await db.destroy()
}
