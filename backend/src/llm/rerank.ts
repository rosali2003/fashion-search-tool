import { callTool, llmAvailable, missingKeyHint, type Usage } from './client.js'
import { modelForStage } from './models.js'
import { withFallback, type Guarded } from './guard.js'
import type { Candidate } from '../search/repository.js'

/**
 * LLM reranking.
 *
 * BM25 decides which products are candidates; this decides their order and
 * explains each one. It gets the user's original words — never the expansion —
 * because expansion deliberately widens intent and reranking needs to narrow it
 * back to what was actually asked.
 *
 * It also receives the styling guidance that applies to this user, so the
 * explanation can be about fit rather than only about keywords. That guidance is
 * computed from reviewable rules in preferences/stylingRules.ts, not invented
 * here — the model applies stated advice to observed garment geometry, it does not
 * decide what flatters whom.
 */

export interface RerankedItem {
  index: number
  reason: string | null
}

/** Compact candidate representation. ~90 tokens each, so 60 fit comfortably. */
function compact(c: Candidate, i: number): string {
  const attrs = [
    c.subcategory ?? c.category, c.silhouette, c.neckline, c.sleeve_length,
    c.length, c.rise, c.fit, c.pattern, ...c.colors.slice(0, 2), ...c.details.slice(0, 4),
  ].filter(Boolean)

  const geometry = [
    c.v_rise && `rise:${c.v_rise}`,
    c.v_waist_position && `waist:${c.v_waist_position}`,
    c.v_hem_break && `hem:${c.v_hem_break}`,
    c.v_shoulder_treatment && `shoulder:${c.v_shoulder_treatment}`,
    c.v_volume && `volume:${c.v_volume}`,
    c.v_drape && `drape:${c.v_drape}`,
  ].filter(Boolean)

  const price = c.price_cents === null ? '' : ` $${(c.price_cents / 100).toFixed(0)}`
  const snippet = (c.description_clean ?? '').slice(0, 160)

  return [
    `[${i}] ${c.brand} · ${c.name}${price}`,
    `    attrs: ${attrs.join(' · ')}`,
    c.material_clean ? `    material: ${c.material_clean}` : '',
    geometry.length ? `    geometry: ${geometry.join(' ')}` : '',
    snippet ? `    text: ${snippet}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const SYSTEM = `You rank fashion search results and write one short reason per result.

Rank by how well each candidate matches the shopper's request. Attribute precision matters most: if they asked for a high collar and a tie at the back, a garment with both outranks one with neither, regardless of how similar the words look.

For each result you return, write a reason of at most 90 characters that cites concrete attributes the product actually has. Never write a generic reason like "great match" or "fits your style". If you cannot name a specific attribute, set the reason field to the JSON value null — do not write the word "null" inside the text.

If styling guidance is provided, prefer garments whose geometry satisfies it, and where a guidance rule is the reason a garment suits this shopper, use that rule's wording in your reason.

Return at most 10 results, best first. Omit candidates that do not match; returning fewer good results is better than padding.`

function schema(maxIndex: number): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', minimum: 0, maximum: maxIndex },
            reason: {
              type: ['string', 'null'],
              maxLength: 90,
              description: 'Cites concrete attributes, or null if none can be named.',
            },
          },
          required: ['index'],
        },
      },
    },
    required: ['results'],
  }
}

interface RawRerank {
  results?: unknown
}

/**
 * Validate the model's ordering.
 *
 * Indices out of range or repeated are dropped rather than clamped: a duplicate
 * would silently show the same product twice, and an out-of-range index would
 * throw at the array access.
 */
export function sanitizeRerank(raw: RawRerank, candidateCount: number): RerankedItem[] {
  if (!Array.isArray(raw.results)) return []
  const seen = new Set<number>()
  const out: RerankedItem[] = []

  for (const r of raw.results) {
    if (typeof r !== 'object' || r === null) continue
    const rec = r as Record<string, unknown>
    const index = typeof rec.index === 'number' ? Math.trunc(rec.index) : -1
    if (index < 0 || index >= candidateCount || seen.has(index)) continue
    seen.add(index)

    let reason: string | null = typeof rec.reason === 'string' ? rec.reason.trim() : null

    // Strip a trailing literal "null" the model wrote *into* the string.
    //
    // Observed on gpt-5-nano against a live catalog: "100% cotton T-shirt — not a
    // button shirt, null". The prompt tells it to "return null" when it cannot
    // name an attribute, and under constrained decoding — where the field is a
    // nullable string and emitting the JSON literal means closing the string it
    // has already opened — it satisfies the instruction by writing the word
    // instead. Cheap to catch here, and this is the one chokepoint every reason
    // passes through.
    // `|| null` matters: stripping "null" from a reason that was *only* that word
    // leaves "", which is falsy and so slips past the generic-reason filter below
    // to render as an empty annotation line.
    if (reason) reason = reason.replace(/[,;:\s]*\bnull\b\.?$/i, '').trim() || null

    // Drop generic reasons. A vacuous explanation is worse than none: it looks
    // like the system understood something when it did not.
    if (reason && (reason.length < 8 || /^(good|great|nice|perfect|strong)\b/i.test(reason))) {
      reason = null
    }
    if (reason && reason.length > 90) reason = `${reason.slice(0, 87)}...`

    out.push({ index, reason })
    if (out.length >= 10) break
  }
  return out
}

export interface RerankOptions {
  stylingGuidance?: string[]
  /**
   * Attributes the shopper explicitly excluded, from the query expander.
   *
   * BM25 cannot represent negation at all — "dress with no sleeves" scores the
   * token `sleeve` positively — which is why the negation slice sits at 0.017
   * across every boost configuration tried. The expander has been detecting this
   * all along and nothing consumed it. Passing it here is soft by construction:
   * the model weighs the exclusion, so a mis-parsed negation costs precision
   * rather than silently emptying the results page.
   */
  negatedTerms?: string[]
  timeoutMs?: number
  usage?: (u: Usage) => void
}

/**
 * Rerank candidates, never throwing.
 *
 * The fallback is BM25 order with every reason null — which is why `reason` is
 * nullable throughout the response type rather than an empty string. A UI that
 * renders "" as an empty reason line looks broken; one that checks for null can
 * omit the line entirely.
 */
export async function rerank(
  query: string,
  candidates: Candidate[],
  opts: RerankOptions = {},
): Promise<Guarded<RerankedItem[]>> {
  const identity: RerankedItem[] = candidates
    .slice(0, 10)
    .map((_, i) => ({ index: i, reason: null }))

  if (candidates.length === 0) return { value: [], degraded: null }

  if (!llmAvailable()) {
    return {
      value: identity,
      degraded: { stage: 'rerank', reason: 'unavailable', detail: missingKeyHint() },
    }
  }

  const guidance = opts.stylingGuidance?.length
    ? `\n\nStyling guidance for this shopper:\n${opts.stylingGuidance.map((g) => `- ${g}`).join('\n')}`
    : ''

  const exclusions = opts.negatedTerms?.length
    ? `\n\nThe shopper explicitly does NOT want: ${opts.negatedTerms.join(', ')}.\n` +
      'Rank any candidate carrying an excluded attribute below those that do not. ' +
      'Do not drop it entirely — say so in the reason instead.'
    : ''

  return withFallback(
    'rerank',
    async () => {
      const { result, usage } = await callTool<RawRerank>({
        system: SYSTEM,
        text: `Shopper's request: ${query}${exclusions}${guidance}\n\nCandidates:\n${candidates
          .map((c, i) => compact(c, i))
          .join('\n')}`,
        toolName: 'rank_results',
        toolDescription: 'Return the best candidates in order, each with a specific reason.',
        schema: schema(candidates.length - 1),
        maxTokens: 4000,
        model: modelForStage('rerank'),
      })
      opts.usage?.(usage)
      const items = sanitizeRerank(result, candidates.length)
      // An empty or unusably short ordering is a failure, not a valid answer.
      return items.length === 0 ? identity : items
    },
    identity,
    opts.timeoutMs ?? 6000,
  )
}
