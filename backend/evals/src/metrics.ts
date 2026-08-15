/**
 * Retrieval metrics.
 *
 * nDCG is the primary measure because it is the only one that uses graded
 * relevance, and grades are unavoidable here: the canary query has no perfect
 * answer in the catalog, so a binary relevant/irrelevant judgment would either
 * discard the best available match or overstate it.
 *
 * Recall@k over the candidate window is reported alongside, and it is the metric
 * that tunes field boosts — it is a hard ceiling on everything downstream. If a
 * relevant product is not in the 120 candidates, no reranker can recover it.
 */

export interface Judgment {
  url: string
  grade: number
  name?: string
}

export interface GoldenCase {
  id: string
  query: string
  slice: string
  brands?: string[]
  note?: string
  judgments: Judgment[]
  gate?: { url: string; k: number }
}

/** Gain is exponential in grade, so a 3 is meaningfully better than two 2s. */
const gain = (grade: number): number => (grade > 0 ? 2 ** grade - 1 : 0)

const dcg = (grades: number[]): number =>
  grades.reduce((sum, g, i) => sum + gain(g) / Math.log2(i + 2), 0)

/**
 * nDCG@k. Returns null when a case has no judgments — the zero-result cases,
 * which are scored by a different criterion (see zeroResultBehaviour) and must
 * not be averaged in as either 0 or 1.
 */
export function ndcgAt(rankedUrls: string[], judgments: Judgment[], k: number): number | null {
  if (judgments.length === 0) return null

  const byUrl = new Map(judgments.map((j) => [j.url, j.grade]))
  const actual = rankedUrls.slice(0, k).map((u) => byUrl.get(u) ?? 0)

  const ideal = judgments
    .map((j) => j.grade)
    .sort((a, b) => b - a)
    .slice(0, k)

  const idealDcg = dcg(ideal)
  if (idealDcg === 0) return null
  return dcg(actual) / idealDcg
}

/**
 * Recall@k over judgments at or above `minGrade`.
 *
 * Defaults to grade 2 — "right garment type with at least one matching
 * attribute". Grade-1 items are adjacent rather than correct, so including them
 * would flatter the number.
 */
export function recallAt(
  rankedUrls: string[],
  judgments: Judgment[],
  k: number,
  minGrade = 2,
): number | null {
  const relevant = judgments.filter((j) => j.grade >= minGrade).map((j) => j.url)
  if (relevant.length === 0) return null
  const found = new Set(rankedUrls.slice(0, k))
  return relevant.filter((u) => found.has(u)).length / relevant.length
}

/** Reciprocal rank of the first grade-3 result. Noisy at n=25; reported, not gated. */
export function mrrTop(rankedUrls: string[], judgments: Judgment[], k = 10): number | null {
  const best = new Set(judgments.filter((j) => j.grade === 3).map((j) => j.url))
  if (best.size === 0) return null
  const idx = rankedUrls.slice(0, k).findIndex((u) => best.has(u))
  return idx === -1 ? 0 : 1 / (idx + 1)
}

export function precisionAt(rankedUrls: string[], judgments: Judgment[], k: number): number | null {
  if (judgments.length === 0) return null
  const byUrl = new Map(judgments.map((j) => [j.url, j.grade]))
  const top = rankedUrls.slice(0, k)
  if (top.length === 0) return 0
  return top.filter((u) => (byUrl.get(u) ?? 0) >= 2).length / top.length
}

/**
 * For a case with no relevant products: did the system stay quiet?
 *
 * There is no correct ranking to measure, so the only meaningful question is
 * whether it returned confident garbage. Scored as the share of the top 5 that
 * is *not* returned — 1.0 for an empty result set, 0.0 for a full one.
 */
export function zeroResultBehaviour(rankedUrls: string[], k = 5): number {
  return 1 - Math.min(rankedUrls.length, k) / k
}

export const mean = (xs: (number | null)[]): number | null => {
  const vals = xs.filter((x): x is number => x !== null)
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length
}

/**
 * Standard error of a mean.
 *
 * Reported alongside nDCG because 25 queries is a small sample: the SE is
 * typically around ±0.05, which means a 0.02 "improvement" from a boost sweep is
 * noise. Printing it next to the number is what stops it being over-read.
 */
export function stderr(xs: (number | null)[]): number | null {
  const vals = xs.filter((x): x is number => x !== null)
  if (vals.length < 2) return null
  const m = vals.reduce((a, b) => a + b, 0) / vals.length
  const variance = vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length - 1)
  return Math.sqrt(variance / vals.length)
}
