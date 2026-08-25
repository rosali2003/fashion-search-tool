import { Hono } from 'hono'
import { bm25Search, countMatchingFilters, type Candidate } from '../search/repository.js'
import { capBrandShare } from '../search/diversity.js'
import { imageUrlFor } from './imageUrl.js'
import { applyTypeGate } from '../search/typeGate.js'
import { RERANK_WINDOW, RESULT_LIMIT, PAGE_SIZE } from '../search/config.js'
import { expandQuery, expansionToText } from '../llm/expand.js'
import { rerank } from '../llm/rerank.js'
import { labels } from '../llm/guard.js'
import { emptyUsage, addUsage, costUsd, type Usage } from '../llm/client.js'
import { loadPreferences } from '../preferences/repository.js'
import { scoreForUser } from '../preferences/affinity.js'
import { guidanceFor } from '../preferences/stylingRules.js'
import { aestheticGuidance } from '../preferences/aestheticRules.js'

const search = new Hono()

const MAX_QUERY_CHARS = 300

export interface SearchResult {
  id: number
  brand: string
  name: string
  price_cents: number | null
  material_badge: string | null
  material_full: string | null
  image_url: string | null
  product_url: string
  attributes: string[]
  /** Why this matched the query. Null when reranking was unavailable. */
  reason: string | null
  /** Why this suits *this shopper*, from the styling rules. Null when anonymous. */
  styling_reason: string | null
  /** Why this fits the shopper's declared aesthetic. Null when Q5 was skipped. */
  aesthetic_reason: string | null
}

function attributesOf(c: Candidate): string[] {
  return [
    c.subcategory ?? c.category,
    c.silhouette, c.neckline, c.sleeve_length, c.length, c.rise,
    ...c.details.slice(0, 2),
  ].filter((v): v is string => Boolean(v))
}

function materialBadge(c: Candidate): string | null {
  if (!c.material_clean) return null
  const first = c.material_clean.split(',')[0]?.trim()
  if (!first) return null
  return first.length <= 24 ? first : (c.primary_fiber ?? null)
}

function toResult(
  c: Candidate,
  reason: string | null,
  stylingReason: string | null,
  aestheticReason: string | null,
): SearchResult {
  return {
    id: c.id,
    brand: c.brand,
    name: [c.name, c.name_variant].filter(Boolean).join(' · '),
    price_cents: c.price_cents,
    material_badge: materialBadge(c),
    material_full: c.material_clean,
    image_url: imageUrlFor(c.image_hashes),
    // UTM tagging so outbound clicks are attributable in the brand's own analytics.
    product_url: `${c.product_url}${c.product_url.includes('?') ? '&' : '?'}utm_source=ink&utm_medium=referral`,
    attributes: attributesOf(c),
    reason,
    styling_reason: stylingReason,
    aesthetic_reason: aestheticReason,
  }
}

search.post('/', async (c) => {
  const started = Date.now()

  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400)
  }

  const query = (typeof body.query === 'string' ? body.query : '').trim().slice(0, MAX_QUERY_CHARS)
  const userId = typeof body.userId === 'string' ? body.userId : null
  const brands = Array.isArray(body.brands)
    ? body.brands.filter((b): b is string => typeof b === 'string')
    : []

  if (!query) {
    return c.json({
      results: [],
      meta: { degraded: [], took_ms: 0, total_candidates: 0, empty_reason: 'blank_query' },
    })
  }

  let usage: Usage = emptyUsage()
  const track = (u: Usage) => {
    usage = addUsage(usage, u)
  }

  // Preferences are loaded first: excluded brands are a hard filter inside the
  // BM25 query, so they have to be known before retrieval, not after.
  const prefs = userId ? await loadPreferences(userId).catch(() => null) : null

  // --- 1. expand ---------------------------------------------------------
  const expansion = await expandQuery(query, { usage: track })
  const expandedText = expansionToText(expansion.value)

  // --- 2. retrieve -------------------------------------------------------
  const candidates = await bm25Search({
    query,
    expanded: expandedText,
    brands,
    excludeBrands: prefs?.excludedBrands ?? [],
  })

  if (candidates.length === 0) {
    const meta: Record<string, unknown> = {
      degraded: labels(expansion.degraded),
      took_ms: Date.now() - started,
      total_candidates: 0,
      empty_reason: 'no_matches',
    }
    // Distinguish "your filters are too narrow" from "we have nothing like this".
    if (brands.length > 0) meta.would_match_without_filters = await countMatchingFilters([])
    return c.json({ results: [], meta })
  }

  // --- 3. type gate ------------------------------------------------------
  //
  // Runs before the diversity guard so the rerank window is filled with the
  // right kind of garment. Gating after the window would mean the model spends
  // its 60 slots judging bikini bottoms against jeans, and the diversity cap
  // would be balancing brand share across a set half of which is about to be
  // discarded anyway.
  const intent = expansion.value.attributes
  const gated = applyTypeGate(candidates, {
    category: typeof intent.category === 'string' ? intent.category : null,
    subcategory: typeof intent.subcategory === 'string' ? intent.subcategory : null,
  }, query)

  // --- 4. diversity guard ------------------------------------------------
  const windowed = capBrandShare(gated.kept, RERANK_WINDOW)

  // --- 5. rerank ---------------------------------------------------------
  //
  // The model curates the HEAD; BM25 supplies the tail.
  //
  // `rerank` returns at most 10 items and frequently fewer — gpt-5-mini returned
  // 5 on the canary query, gpt-5-nano returned 2. Treating "not returned by the
  // model" as "not a result" threw away the rest of a 60-candidate window, which
  // is why search pages came back short and why personalisation could only
  // reshuffle the model's handful.
  //
  // Appending the remainder in BM25 order fixes all of that and keeps the same
  // fail-open posture as the rest of the pipeline: an empty or truncated model
  // response degrades to plain BM25 order rather than to a short page.
  // Body-fit guidance and aesthetic guidance are both declared heuristics the
  // model reasons with, so they travel together on the same channel.
  const guidance = prefs
    ? [...guidanceFor(prefs.body), ...aestheticGuidance(prefs.styleCluster)]
    : []
  const reranked = await rerank(query, windowed, {
    stylingGuidance: guidance,
    // Computed on every search and, until now, consumed by nothing.
    negatedTerms: expansion.value.negatedTerms,
    usage: track,
  })

  const reasonByIndex = new Map(reranked.value.map((r) => [r.index, r.reason]))
  const pickedIndices = new Set(reranked.value.map((r) => r.index))
  const orderedCandidates = [
    ...reranked.value.map((r) => windowed[r.index]),
    ...windowed.filter((_c, i) => !pickedIndices.has(i)),
  ]

  // --- 6. preference blend ----------------------------------------------
  //
  // Relevance is the upstream *position*, not the raw BM25 score: mixing a
  // position with an unbounded score would let a single very high scorer dominate
  // regardless of preference. The decay is linear and spans the whole window —
  // see the note on RANK_SCALE in affinity.ts for why a fixed scale breaks once
  // the window is wider than it.
  const scored = scoreForUser(
    orderedCandidates,
    prefs,
    (_c, i) => 1 - i / Math.max(1, orderedCandidates.length),
  ).sort((a, b) => b.finalScore - a.finalScore)

  // --- 7. respond --------------------------------------------------------
  //
  // The window is 60 but the client pages 50 at a time, so stopping at the window
  // edge would yield one full page and a stub. The tail — candidates BM25 found
  // but the diversity guard kept out of the rerank window — is appended in
  // retrieval order behind everything that was actually curated.
  //
  // This is the same head/tail split the rerank step above already relies on,
  // applied one level out: judgement orders what it saw, BM25 orders the rest,
  // and the boundary between them is never interleaved. A tail item cannot
  // outrank a curated one no matter how its affinity scores, because it was
  // never scored against them.
  // Sourced from the gated set, not from `candidates`. Reading the tail off the
  // ungated list would hand back every off-type candidate the gate just removed,
  // one page further down, which is exactly the symptom the gate exists to fix.
  const inWindow = new Set(windowed)
  const tail = gated.kept.filter((c) => !inWindow.has(c))

  const results = [
    ...scored.map((s) => {
      const idx = windowed.indexOf(s.candidate)
      return toResult(
        s.candidate,
        reasonByIndex.get(idx) ?? null,
        s.stylingReason,
        s.aestheticReason,
      )
    }),
    ...tail.map((c) => toResult(c, null, null, null)),
  ].slice(0, RESULT_LIMIT)

  const cost = costUsd(usage)
  console.log(
    JSON.stringify({
      level: 'info', stage: 'search', query_len: query.length,
      candidates: candidates.length, gated_out: gated.dropped, results: results.length,
      degraded: labels(expansion.degraded, reranked.degraded),
      llm_calls: usage.calls, cost_usd: Number(cost.toFixed(6)),
      ms: Date.now() - started,
    }),
  )

  return c.json({
    results,
    meta: {
      degraded: labels(expansion.degraded, reranked.degraded),
      took_ms: Date.now() - started,
      total_candidates: candidates.length,
      // Off-type candidates the gate removed, and whether it fired at all. A
      // zero with type_gated true means the query was already clean; false
      // means there was no type intent, or too little on-type left to trust it.
      type_gated: gated.applied,
      type_gated_out: gated.dropped,
      personalized: prefs !== null,
      // How many of the returned results were actually judged. Past this index
      // the list is raw BM25 order, and the UI says so rather than implying the
      // whole tail was curated.
      curated_count: scored.length,
      page_size: PAGE_SIZE,
    },
  })
})

export default search
