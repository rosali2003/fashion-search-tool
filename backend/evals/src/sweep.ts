/**
 * Field-boost sweep.
 *
 *   pnpm --filter backend exec tsx evals/src/sweep.ts
 *
 * Grids the four query-time field boosts and re-measures the golden set for each
 * combination. Runs entirely against BM25 with no LLM in the loop, which is why
 * ~200 configurations finish in well under a minute: each is a query, not an
 * index rebuild, because boosts are applied via pdb.boost() at query time.
 *
 * k1 and b are absent from the grid on purpose — Tantivy hardcodes them and
 * pg_search exposes no override. See src/search/config.ts.
 *
 * READ THE WARNING IT PRINTS. With 26 queries the standard error on nDCG@10 is
 * around ±0.07, so the difference between the top few configurations is usually
 * noise. Prefer a configuration that is good across every slice over the one with
 * the best mean.
 */
import { db } from '../../src/db/index.js'
import { bm25Search } from '../../src/search/repository.js'
import { capBrandShare } from '../../src/search/diversity.js'
import { CANDIDATE_LIMIT, RERANK_WINDOW } from '../../src/search/config.js'
import * as config from '../../src/search/config.js'
import { loadGolden } from './golden.js'
import { mean, ndcgAt, recallAt, stderr } from './metrics.js'

const TITLE = [2, 3, 4]
const ATTRS = [1.5, 2.5, 3.5]
const MATERIAL = [1, 2, 3]
const BODY = [0.5, 1]

interface Row {
  title: number
  attrs: number
  material: number
  body: number
  ndcg: number
  ndcgSe: number
  recall: number
  worstSlice: number
  gates: number
}

async function main(): Promise<void> {
  const cases = loadGolden()
  const rows: Row[] = []

  // The boost object is read per query by the repository, so mutating it between
  // runs is enough — no index work, no reconnection.
  const boosts = config.FIELD_BOOSTS as unknown as Record<string, number>
  const original = { ...boosts }

  const total = TITLE.length * ATTRS.length * MATERIAL.length * BODY.length
  console.log(`sweeping ${total} configurations over ${cases.length} cases\n`)
  const started = Date.now()

  for (const title of TITLE) {
    for (const attrs of ATTRS) {
      for (const material of MATERIAL) {
        for (const body of BODY) {
          boosts.title = title
          boosts.attrs = attrs
          boosts.material = material
          boosts.body = body

          const ndcgs: (number | null)[] = []
          const recalls: (number | null)[] = []
          const bySlice = new Map<string, (number | null)[]>()
          let gates = 0

          for (const c of cases) {
            const candidates = await bm25Search({ query: c.query, brands: c.brands })
            const ranked = capBrandShare(candidates, RERANK_WINDOW).map((r) => r.product_url)
            const candidateUrls = candidates.map((r) => r.product_url)

            const n = ndcgAt(ranked, c.judgments, 10)
            ndcgs.push(n)
            recalls.push(recallAt(candidateUrls, c.judgments, CANDIDATE_LIMIT))
            bySlice.set(c.slice, [...(bySlice.get(c.slice) ?? []), n])

            if (c.gate) {
              const idx = ranked.indexOf(c.gate.url)
              if (idx !== -1 && idx + 1 <= c.gate.k) gates++
            }
          }

          // The minimum slice mean, so a config that wins on average by wrecking
          // one query type is visibly worse rather than invisibly better.
          const sliceMeans = [...bySlice.values()]
            .map((v) => mean(v))
            .filter((v): v is number => v !== null)

          rows.push({
            title, attrs, material, body,
            ndcg: mean(ndcgs) ?? 0,
            ndcgSe: stderr(ndcgs) ?? 0,
            recall: mean(recalls) ?? 0,
            worstSlice: Math.min(...sliceMeans),
            gates,
          })
        }
      }
    }
  }

  Object.assign(boosts, original)

  // Rank by recall first: it is the ceiling on everything downstream, and a
  // configuration that retrieves the right products but orders them slightly
  // worse is recoverable by the reranker. The reverse is not.
  rows.sort((a, b) => b.recall - a.recall || b.ndcg - a.ndcg)

  console.log('  title attrs material body | recall@120  nDCG@10   worst-slice  gates')
  console.log('  ' + '-'.repeat(72))
  for (const r of rows.slice(0, 12)) {
    console.log(
      `  ${String(r.title).padStart(5)} ${String(r.attrs).padStart(5)} ${String(r.material).padStart(8)} ${String(r.body).padStart(4)} |` +
        `   ${r.recall.toFixed(3)}     ${r.ndcg.toFixed(3)}      ${r.worstSlice.toFixed(3)}      ${r.gates}`,
    )
  }

  const best = rows[0]
  const se = best.ndcgSe
  console.log(`\nswept in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(`
NOTE: nDCG@10 standard error is ±${se.toFixed(3)} at n=${cases.length}. Any difference
smaller than about ${(2 * se).toFixed(2)} between configurations is noise, so do not chase the
top row on nDCG alone — compare the worst-slice column too, and prefer a
configuration that is uniformly decent.

Winner by recall@120, to paste into src/search/config.ts:

export const FIELD_BOOSTS = {
  title: ${best.title},
  attrs: ${best.attrs},
  material: ${best.material},
  body: ${best.body},
} as const
`)
}

try {
  await main()
} finally {
  await db.destroy()
}
