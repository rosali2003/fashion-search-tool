/**
 * Eval runner.
 *
 *   pnpm --filter backend eval                 retrieval only, deterministic, $0
 *   pnpm --filter backend eval -- --gate       exit non-zero on a failed gate
 *   pnpm --filter backend eval -- --verbose    per-case breakdown
 *   pnpm --filter backend eval -- --baseline   overwrite results/baseline.json
 *   pnpm --filter backend eval -- --assert-corpus
 *
 * Retrieval-only is the default and the only mode that may be used to tune BM25:
 * you cannot tune retrieval against a stochastic reranker, because the noise from
 * the LLM swamps the effect of a boost change.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { db } from '../../src/db/index.js'
import { REPO_ROOT } from '../../src/ingest/load.js'
import { bm25Search } from '../../src/search/repository.js'
import { capBrandShare } from '../../src/search/diversity.js'
import { CANDIDATE_LIMIT, FIELD_BOOSTS, RERANK_WINDOW } from '../../src/search/config.js'
import {
  mean, mrrTop, ndcgAt, precisionAt, recallAt, stderr, zeroResultBehaviour,
  type GoldenCase,
} from './metrics.js'
import { loadGolden } from './golden.js'

const RESULTS_DIR = path.join(REPO_ROOT, 'backend/evals/results')

export interface CaseResult {
  id: string
  slice: string
  query: string
  ndcg10: number | null
  recall120: number | null
  recall10: number | null
  precision10: number | null
  mrr10: number | null
  zeroBehaviour: number | null
  gatePassed: boolean | null
  gateRank: number | null
  candidates: number
  topUrls: string[]
  candidateUrls: string[]
  ms: number
}

export interface EvalSummary {
  at: string
  boosts: typeof FIELD_BOOSTS
  candidateLimit: number
  cases: number
  ndcg10: number | null
  ndcg10_stderr: number | null
  recall120: number | null
  recall10: number | null
  precision10: number | null
  mrr10: number | null
  zeroBehaviour: number | null
  gatesPassed: number
  gatesTotal: number
  perSlice: Record<string, { n: number; ndcg10: number | null; recall120: number | null }>
  perBrandRecall: Record<string, number>
}

/** Verify every judged product still resolves and is active. */
async function assertCorpus(cases: GoldenCase[]): Promise<boolean> {
  const urls = [...new Set(cases.flatMap((c) => c.judgments.map((j) => j.url)))]
  const rows = await db
    .selectFrom('products')
    .select(['product_url', 'is_active'])
    .where('product_url', 'in', urls)
    .execute()

  const found = new Map(rows.map((r) => [r.product_url, r.is_active]))
  const missing = urls.filter((u) => !found.has(u))
  const inactive = urls.filter((u) => found.get(u) === false)

  const total = await db
    .selectFrom('products')
    .select(({ fn }) => fn.countAll<number>().as('n'))
    .where('is_active', '=', true)
    .executeTakeFirst()

  console.log(`corpus: ${Number(total?.n ?? 0)} active products, ${urls.length} judged urls`)
  if (missing.length) {
    console.error(`  ${missing.length} judged urls NOT FOUND:`)
    for (const u of missing.slice(0, 10)) console.error(`    ${u}`)
  }
  if (inactive.length) {
    // Under a daily cron, a product going out of stock is deactivated. Silently
    // scoring against a deactivated product degrades every metric invisibly.
    console.error(`  ${inactive.length} judged urls are DEACTIVATED (re-grade or re-scrape):`)
    for (const u of inactive.slice(0, 10)) console.error(`    ${u}`)
  }
  return missing.length === 0 && inactive.length === 0
}

async function runCase(c: GoldenCase): Promise<CaseResult> {
  const started = Date.now()
  const candidates = await bm25Search({ query: c.query, brands: c.brands })
  const ranked = capBrandShare(candidates, RERANK_WINDOW)
  const rankedUrls = ranked.map((r) => r.product_url)
  const candidateUrls = candidates.map((r) => r.product_url)

  let gatePassed: boolean | null = null
  let gateRank: number | null = null
  if (c.gate) {
    const idx = rankedUrls.indexOf(c.gate.url)
    gateRank = idx === -1 ? null : idx + 1
    gatePassed = gateRank !== null && gateRank <= c.gate.k
  }

  return {
    id: c.id,
    slice: c.slice,
    query: c.query,
    ndcg10: ndcgAt(rankedUrls, c.judgments, 10),
    // Recall is measured over the full candidate window, not the top 10: it is
    // the ceiling the reranker has to work within.
    recall120: recallAt(candidateUrls, c.judgments, CANDIDATE_LIMIT),
    recall10: recallAt(rankedUrls, c.judgments, 10),
    precision10: precisionAt(rankedUrls, c.judgments, 10),
    mrr10: mrrTop(rankedUrls, c.judgments, 10),
    zeroBehaviour: c.judgments.length === 0 ? zeroResultBehaviour(rankedUrls) : null,
    gatePassed,
    gateRank,
    candidates: candidates.length,
    topUrls: rankedUrls.slice(0, 10),
    candidateUrls,
    ms: Date.now() - started,
  }
}

/**
 * Recall per brand, measured over the *candidate window* rather than the top 10.
 *
 * This metric exists to detect retrieval skew — one brand's documents being
 * systematically penalised by BM25 length normalisation, which cannot be tuned
 * away because Tantivy hardcodes b. Measuring it at 10 conflates that with an
 * artefact of the golden set: cases like "triangle bikini set" have 6 relevant
 * products competing for 10 slots, so recall@10 is capped well below 1.0 even
 * when retrieval is perfect. Measuring at the window answers the question the
 * metric is named for.
 */
async function perBrandRecall(cases: GoldenCase[], results: CaseResult[]): Promise<Record<string, number>> {
  const urls = [...new Set(cases.flatMap((c) => c.judgments.filter((j) => j.grade >= 2).map((j) => j.url)))]
  if (urls.length === 0) return {}

  const rows = await db
    .selectFrom('products')
    .select(['product_url', 'brand'])
    .where('product_url', 'in', urls)
    .execute()
  const brandOf = new Map(rows.map((r) => [r.product_url, r.brand]))

  const total: Record<string, number> = {}
  const hit: Record<string, number> = {}

  cases.forEach((c, i) => {
    const retrieved = new Set(results[i].candidateUrls)
    for (const j of c.judgments) {
      if (j.grade < 2) continue
      const b = brandOf.get(j.url)
      if (!b) continue
      total[b] = (total[b] ?? 0) + 1
      if (retrieved.has(j.url)) hit[b] = (hit[b] ?? 0) + 1
    }
  })

  return Object.fromEntries(
    Object.keys(total).sort().map((b) => [b, (hit[b] ?? 0) / total[b]]),
  )
}

function fmt(v: number | null, digits = 3): string {
  return v === null ? '  n/a' : v.toFixed(digits).padStart(5)
}

export async function runEval(cases: GoldenCase[]): Promise<{ summary: EvalSummary; results: CaseResult[] }> {
  const results: CaseResult[] = []
  for (const c of cases) results.push(await runCase(c))

  const bySlice: EvalSummary['perSlice'] = {}
  for (const slice of [...new Set(cases.map((c) => c.slice))]) {
    const rs = results.filter((r) => r.slice === slice)
    bySlice[slice] = {
      n: rs.length,
      ndcg10: mean(rs.map((r) => r.ndcg10)),
      recall120: mean(rs.map((r) => r.recall120)),
    }
  }

  const gates = results.filter((r) => r.gatePassed !== null)

  const summary: EvalSummary = {
    at: new Date().toISOString(),
    boosts: FIELD_BOOSTS,
    candidateLimit: CANDIDATE_LIMIT,
    cases: cases.length,
    ndcg10: mean(results.map((r) => r.ndcg10)),
    ndcg10_stderr: stderr(results.map((r) => r.ndcg10)),
    recall120: mean(results.map((r) => r.recall120)),
    recall10: mean(results.map((r) => r.recall10)),
    precision10: mean(results.map((r) => r.precision10)),
    mrr10: mean(results.map((r) => r.mrr10)),
    zeroBehaviour: mean(results.map((r) => r.zeroBehaviour)),
    gatesPassed: gates.filter((r) => r.gatePassed).length,
    gatesTotal: gates.length,
    perSlice: bySlice,
    perBrandRecall: await perBrandRecall(cases, results),
  }

  return { summary, results }
}

function report(summary: EvalSummary, results: CaseResult[], verbose: boolean): void {
  const b = summary.boosts
  console.log(`\nboosts  title ${b.title}  attrs ${b.attrs}  material ${b.material}  body ${b.body}`)
  console.log(`cases   ${summary.cases}   candidate window ${summary.candidateLimit}\n`)

  console.log(`  nDCG@10        ${fmt(summary.ndcg10)}  ± ${fmt(summary.ndcg10_stderr)}   <- primary`)
  console.log(`  Recall@120     ${fmt(summary.recall120)}          <- tunes field boosts`)
  console.log(`  Recall@10      ${fmt(summary.recall10)}`)
  console.log(`  Precision@10   ${fmt(summary.precision10)}`)
  console.log(`  MRR@10         ${fmt(summary.mrr10)}`)
  console.log(`  zero-result    ${fmt(summary.zeroBehaviour)}          <- 1.0 = correctly returned nothing`)
  console.log(`  gates          ${summary.gatesPassed}/${summary.gatesTotal}`)

  console.log('\nper slice:')
  for (const [slice, s] of Object.entries(summary.perSlice)) {
    console.log(`  ${slice.padEnd(10)} n=${String(s.n).padStart(2)}  nDCG@10 ${fmt(s.ndcg10)}  Recall@120 ${fmt(s.recall120)}`)
  }

  console.log('\nper brand recall@120 (detects length-normalisation skew):')
  for (const [brand, v] of Object.entries(summary.perBrandRecall)) {
    const flag = v < 0.85 ? '  <- below 0.85' : ''
    console.log(`  ${brand.padEnd(10)} ${fmt(v)}${flag}`)
  }

  const failed = results.filter((r) => r.gatePassed === false)
  if (failed.length > 0) {
    console.log('\nfailed gates:')
    for (const r of failed) {
      console.log(`  ${r.id.padEnd(34)} target at rank ${r.gateRank ?? 'not retrieved'}`)
    }
  }

  if (verbose) {
    console.log('\nper case:')
    for (const r of results) {
      const gate = r.gatePassed === null ? '   ' : r.gatePassed ? ' ok' : 'FAIL'
      console.log(
        `  ${gate} ${r.id.padEnd(34)} nDCG ${fmt(r.ndcg10)}  R@120 ${fmt(r.recall120)}` +
          `  cand ${String(r.candidates).padStart(3)}  ${r.ms}ms`,
      )
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const flag = (f: string) => argv.includes(f)

  const cases = loadGolden()

  if (flag('--assert-corpus')) {
    const ok = await assertCorpus(cases)
    if (!ok) process.exitCode = 1
    return
  }

  // Always sanity-check the corpus first: metrics computed against deactivated
  // products look fine and mean nothing.
  await assertCorpus(cases)

  const { summary, results } = await runEval(cases)
  report(summary, results, flag('--verbose'))

  const baselineFile = path.join(RESULTS_DIR, 'baseline.json')
  if (flag('--baseline')) {
    mkdirSync(RESULTS_DIR, { recursive: true })
    writeFileSync(baselineFile, `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`\nbaseline written -> ${path.relative(REPO_ROOT, baselineFile)}`)
  } else if (existsSync(baselineFile)) {
    const base = JSON.parse(readFileSync(baselineFile, 'utf8')) as EvalSummary
    const d = (a: number | null, bb: number | null) =>
      a === null || bb === null ? '  n/a' : `${a - bb >= 0 ? '+' : ''}${(a - bb).toFixed(3)}`
    console.log(`\nvs baseline (${base.at}):`)
    console.log(`  nDCG@10     ${d(summary.ndcg10, base.ndcg10)}`)
    console.log(`  Recall@120  ${d(summary.recall120, base.recall120)}`)
    console.log(`  gates       ${summary.gatesPassed - base.gatesPassed >= 0 ? '+' : ''}${summary.gatesPassed - base.gatesPassed}`)
  }

  // Append every run so regressions are visible over time.
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(
    path.join(RESULTS_DIR, 'history.jsonl'),
    `${JSON.stringify(summary)}\n`,
    { flag: 'a' },
  )

  if (flag('--gate')) {
    const failures: string[] = []
    if (summary.recall120 !== null && summary.recall120 < 0.95) {
      failures.push(`recall@120 ${summary.recall120.toFixed(3)} < 0.95`)
    }
    if (summary.gatesPassed < summary.gatesTotal) {
      failures.push(`${summary.gatesTotal - summary.gatesPassed} case gate(s) failed`)
    }
    for (const [brand, v] of Object.entries(summary.perBrandRecall)) {
      if (v < 0.85) failures.push(`per-brand recall ${brand} ${v.toFixed(3)} < 0.85`)
    }
    if (failures.length > 0) {
      console.error(`\nGATE FAILED:\n${failures.map((f) => `  ${f}`).join('\n')}`)
      process.exitCode = 1
    } else {
      console.log('\nall gates passed')
    }
  }
}

try {
  await main()
} finally {
  await db.destroy()
}
