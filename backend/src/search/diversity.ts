import { BRAND_CAP_RATIO } from './config.js'
import type { Candidate } from './repository.js'

/**
 * Cap how much of the rerank window any single brand can occupy.
 *
 * This exists because BM25's document-length normalisation cannot be tuned —
 * Tantivy hardcodes `b` — and brand skew in this corpus is a length artefact as
 * much as a relevance one. Rihoas descriptions are structured attribute blocks
 * that pack many matchable tokens into short documents, so they systematically
 * out-score Aritzia's prose. Measured on 7 generic queries before any correction:
 * Rihoas took 52 of 140 top-20 slots against a 34% corpus share, Aritzia 13
 * against 16%.
 *
 * Sweeping `b` from 0.75 to 0.0 moved that by roughly 5 slots out of 140, so the
 * correction is applied explicitly here instead of being left to a parameter that
 * demonstrably doesn't control it.
 *
 * Order within a brand is preserved, and overflow is appended rather than
 * dropped — if a brand genuinely owns a query ("uniqlo heattech"), its extra
 * candidates still reach the reranker, just behind everyone else's.
 */
export function capBrandShare(candidates: Candidate[], window: number): Candidate[] {
  if (candidates.length <= window) return candidates

  const perBrandCap = Math.max(1, Math.floor(window * BRAND_CAP_RATIO))
  const counts = new Map<string, number>()
  const kept: Candidate[] = []
  const overflow: Candidate[] = []

  for (const c of candidates) {
    const n = counts.get(c.brand) ?? 0
    if (n < perBrandCap) {
      counts.set(c.brand, n + 1)
      kept.push(c)
    } else {
      overflow.push(c)
    }
  }

  return [...kept, ...overflow].slice(0, window)
}
