/**
 * Daily refresh: scrape -> ingest -> enrich.
 *
 *   pnpm refresh                 full pipeline
 *   pnpm refresh -- --no-scrape  reuse the newest run directory
 *   pnpm refresh -- --no-enrich  skip the paid passes
 *   pnpm refresh -- --dry-run    report what each stage would do
 *
 * Designed to run unattended from cron, which shapes three things:
 *
 * 1. Per-stage failure isolation. A blocked scrape must not prevent ingest of the
 *    brands that did succeed, and a failed enrich must not lose the crawl.
 * 2. One JSON summary line per run appended to output/refresh.log.jsonl. Cost and
 *    call counts are in it deliberately: the caches are the entire cost control,
 *    so a jump in `cost_usd` is the signal that one stopped working.
 * 3. A non-zero exit on real failure so cron surfaces it rather than silently
 *    succeeding for weeks.
 *
 * Scheduling (macOS launchd). Randomise the minute: hitting four retail sites at
 * exactly the same time daily is the most obvious bot signature available, and
 * Aritzia already sticky-blocks scrapers.
 *
 *   ~/Library/LaunchAgents/com.ink.refresh.plist
 *   StartCalendarInterval { Hour 3, Minute <pick something arbitrary> }
 *   ProgramArguments: /bin/zsh -lc "cd <repo> && pnpm refresh >> output/refresh.out 2>&1"
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOG = path.join(REPO_ROOT, 'output', 'refresh.log.jsonl')

interface StageResult {
  stage: string
  ok: boolean
  ms: number
  code: number | null
  /** Tail of output, kept for the log line so a failure is diagnosable. */
  tail: string
}

function run(stage: string, cmd: string, args: string[]): Promise<StageResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, shell: false })
    let out = ''

    const capture = (chunk: Buffer) => {
      const text = chunk.toString()
      out += text
      process.stdout.write(text)
      // Keep memory bounded on a long scrape.
      if (out.length > 20_000) out = out.slice(-20_000)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)

    child.on('close', (code) => {
      resolve({
        stage,
        ok: code === 0,
        ms: Date.now() - started,
        code,
        tail: out.trim().split('\n').slice(-6).join(' | ').slice(0, 900),
      })
    })
    child.on('error', (err) => {
      resolve({ stage, ok: false, ms: Date.now() - started, code: null, tail: err.message })
    })
  })
}

/** Pull the numbers the log line cares about out of the ingest summary. */
function parseIngest(tail: string): Record<string, number> {
  const m = tail.match(
    /seen (\d+)\s+inserted (\d+)\s+updated (\d+)\s+unchanged (\d+)\s+deactivated (\d+)/,
  )
  if (!m) return {}
  return {
    seen: Number(m[1]),
    inserted: Number(m[2]),
    updated: Number(m[3]),
    unchanged: Number(m[4]),
    deactivated: Number(m[5]),
  }
}

function parseEnrich(tail: string): Record<string, number> {
  const calls = tail.match(/(\d+) calls/)
  const cost = tail.match(/\$([\d.]+)/)
  return {
    llm_calls: calls ? Number(calls[1]) : 0,
    cost_usd: cost ? Number(cost[1]) : 0,
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const has = (f: string) => argv.includes(f)
  const dryRun = has('--dry-run')

  const started = Date.now()
  const stages: StageResult[] = []
  const date = new Date().toISOString()

  console.log(`ink refresh · ${date}${dryRun ? ' [dry run]' : ''}\n`)

  // --- scrape -----------------------------------------------------------
  if (!has('--no-scrape') && !dryRun) {
    console.log('— scraping —')
    stages.push(await run('scrape', 'pnpm', ['scrape:all']))
  }

  // --- ingest -----------------------------------------------------------
  // Runs even when the scrape failed: a partial crawl still has brands worth
  // ingesting, and the 50% deactivation guard inside upsertBrand is what protects
  // the catalog from a half-blocked run.
  console.log('\n— ingesting —')
  const ingestArgs = ['--filter', 'backend', 'ingest', '--', '--report']
  if (dryRun) ingestArgs.push('--dry-run')
  stages.push(await run('ingest', 'pnpm', ingestArgs))

  // --- enrich -----------------------------------------------------------
  if (!has('--no-enrich')) {
    console.log('\n— enriching —')
    const enrichArgs = ['--filter', 'backend', 'enrich']
    if (dryRun) enrichArgs.push('--', '--dry-run')
    const res = await run('enrich', 'pnpm', enrichArgs)
    // A missing API key is an expected state, not a failure: the catalog stays
    // searchable from deterministic extraction alone.
    if (!res.ok && /ANTHROPIC_API_KEY is not set/.test(res.tail)) {
      console.log('  (no API key — skipping enrichment, search still works)')
      res.ok = true
    }
    stages.push(res)
  }

  // --- summary ----------------------------------------------------------
  const ingest = stages.find((s) => s.stage === 'ingest')
  const enrich = stages.find((s) => s.stage === 'enrich')

  const summary = {
    date,
    ok: stages.every((s) => s.ok),
    duration_ms: Date.now() - started,
    stages: Object.fromEntries(stages.map((s) => [s.stage, { ok: s.ok, ms: s.ms }])),
    ...(ingest ? parseIngest(ingest.tail) : {}),
    ...(enrich ? parseEnrich(enrich.tail) : {}),
    failures: stages.filter((s) => !s.ok).map((s) => ({ stage: s.stage, tail: s.tail })),
  }

  mkdirSync(path.dirname(LOG), { recursive: true })
  appendFileSync(LOG, `${JSON.stringify(summary)}\n`)

  console.log('\n— summary —')
  for (const s of stages) {
    console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.stage.padEnd(8)} ${(s.ms / 1000).toFixed(1)}s`)
  }
  console.log(`  logged to ${path.relative(REPO_ROOT, LOG)}`)

  if (!summary.ok) {
    console.error('\nrefresh failed:')
    for (const f of summary.failures) console.error(`  ${f.stage}: ${f.tail}`)
    process.exitCode = 1
  }
}

await main()
