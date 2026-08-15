import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { callTool, llmAvailable, missingKeyHint, MODEL, type Usage } from './client.js'
import { withFallback, type Guarded } from './guard.js'
import { SYNONYMS, expandAll } from '../normalize/synonyms.js'
import {
  CATEGORY, SUBCATEGORY, NECKLINE, SLEEVE_LENGTH, LENGTH, SILHOUETTE,
  PATTERN, DETAILS, OCCASION, COLORS, FIBER, FABRIC, coerce, coerceMany,
} from '../normalize/vocab.js'

/**
 * Query expansion.
 *
 * This is the single highest-leverage stage in a lexical retrieval system,
 * because vocabulary mismatch is BM25's only structural weakness and expansion is
 * the only thing that addresses it. A user typing "high collar" scores zero
 * against a product whose copy says "turtle neck", no matter how the index is
 * tuned.
 *
 * Bump when the prompt or the schema changes: the cache key includes it, so a
 * prompt edit invalidates old entries instead of serving stale expansions.
 */
export const EXPANSION_VERSION = 1

export interface Expansion {
  /** Extra surface forms to search, at a discounted boost. */
  terms: string[]
  /** Vocabulary attributes the query implies. Never used as a hard filter. */
  attributes: Record<string, string | string[]>
  /** True when the query contains a negation BM25 cannot represent. */
  hasNegation: boolean
  /** Terms the user explicitly excluded, e.g. "not floral". */
  negatedTerms: string[]
}

export const emptyExpansion = (): Expansion => ({
  terms: [], attributes: {}, hasNegation: false, negatedTerms: [],
})

const SYSTEM = `You expand fashion search queries into the vocabulary that retail product copy actually uses.

You are feeding a BM25 keyword index. It has no semantics: it can only match words that literally appear in a product's text. Your job is to supply the words the catalog is likely to use for what the shopper described.

Rules:
- Output surface forms, not concepts. "high collar" -> "turtle neck", "mock neck", "funnel neck", "stand collar".
- Include the garment type in plain retail terms.
- For vague or mood queries ("something cozy for the weekend"), output the concrete garment and occasion words a product page would use: "hoodie", "fleece", "sweatpants", "lounge", "relaxed".
- Do NOT invent attributes the shopper did not ask for. Expanding "linen shirt" with "floral" is wrong.
- If the query contains a negation ("no sleeves", "not floral", "without buttons"), set hasNegation and put the excluded concept in negatedTerms. Never put a negated term in terms.
- Keep terms to at most 20 entries.`

/** The tool schema is generated from the vocabulary, never hand-written. */
function schema(): Record<string, unknown> {
  const enumArray = (values: readonly string[]) => ({
    type: 'array',
    items: { type: 'string', enum: [...values] },
  })
  return {
    type: 'object',
    properties: {
      terms: {
        type: 'array',
        items: { type: 'string' },
        description: 'Surface forms to add to the search. Lowercase, 1-3 words each.',
      },
      category: { type: 'string', enum: [...CATEGORY] },
      subcategory: { type: 'string', enum: [...SUBCATEGORY] },
      neckline: { type: 'string', enum: [...NECKLINE] },
      sleeve_length: { type: 'string', enum: [...SLEEVE_LENGTH] },
      length: { type: 'string', enum: [...LENGTH] },
      silhouette: { type: 'string', enum: [...SILHOUETTE] },
      pattern: { type: 'string', enum: [...PATTERN] },
      details: enumArray(DETAILS),
      occasion: enumArray(OCCASION),
      colors: enumArray(COLORS),
      fibers: enumArray(FIBER),
      fabric: enumArray(FABRIC),
      hasNegation: { type: 'boolean' },
      negatedTerms: { type: 'array', items: { type: 'string' } },
    },
    required: ['terms'],
  }
}

interface RawExpansion {
  terms?: unknown
  hasNegation?: unknown
  negatedTerms?: unknown
  [k: string]: unknown
}

/**
 * Validate the model's output.
 *
 * Attribute values are coerced against the controlled vocabulary and dropped when
 * unrecognised, so a hallucinated facet cannot reach the ranking stage. Free-text
 * `terms` are length-capped instead — they only ever widen a disjunctive query, so
 * an odd one costs a little precision rather than correctness.
 */
export function sanitize(raw: RawExpansion): Expansion {
  const terms = Array.isArray(raw.terms)
    ? raw.terms
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 1 && t.split(/\s+/).length <= 3)
        .slice(0, 20)
    : []

  const attributes: Record<string, string | string[]> = {}
  for (const f of ['category', 'subcategory', 'neckline', 'sleeve_length', 'length', 'silhouette', 'pattern'] as const) {
    const v = coerce(f, raw[f])
    if (v) attributes[f] = v
  }
  for (const f of ['details', 'occasion', 'colors', 'fabric'] as const) {
    const v = coerceMany(f, raw[f])
    if (v.length) attributes[f] = v
  }
  // `fibers` has no vocab entry under that key; validate against FIBER directly.
  if (Array.isArray(raw.fibers)) {
    const fibers = raw.fibers
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.toLowerCase().trim())
      .filter((x) => (FIBER as readonly string[]).includes(x))
    if (fibers.length) attributes.fibers = [...new Set(fibers)]
  }

  const negatedTerms = Array.isArray(raw.negatedTerms)
    ? raw.negatedTerms
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 10)
    : []

  return {
    terms,
    attributes,
    hasNegation: raw.hasNegation === true || negatedTerms.length > 0,
    negatedTerms,
  }
}

/** Flatten an expansion into the text passed to the discounted BM25 clause group. */
export function expansionToText(e: Expansion): string {
  const attrTerms = Object.values(e.attributes).flatMap((v) => (Array.isArray(v) ? v : [v]))
  // Attribute values go through the same synonym map used at ingest, so the
  // query and the documents meet in the same vocabulary.
  return [...new Set([...e.terms, ...expandAll(attrTerms).split(' ')])].join(' ').trim()
}

/**
 * Deterministic fallback used when the LLM is unavailable.
 *
 * Walks the synonym map for phrases present in the query. Much weaker than the
 * model — it cannot infer that "cozy weekend" implies a hoodie — but it is free,
 * instant, and covers the highest-value case: the canary's "high collar" reaching
 * turtleneck and mock-neck surface forms.
 */
export function expandLexically(query: string): Expansion {
  const q = query.toLowerCase()
  const terms = new Set<string>()
  for (const [canonical, forms] of Object.entries(SYNONYMS)) {
    const hit = forms.some((f) => q.includes(f)) || q.includes(canonical.replace(/-/g, ' '))
    if (hit) for (const f of forms) terms.add(f)
  }
  return { ...emptyExpansion(), terms: [...terms].slice(0, 40) }
}

const cacheKey = (query: string): string =>
  createHash('sha256')
    .update(`${EXPANSION_VERSION}:${query.trim().toLowerCase().replace(/\s+/g, ' ')}`)
    .digest('hex')

async function fromCache(key: string): Promise<Expansion | null> {
  const row = await db
    .selectFrom('expansion_cache')
    .select('expansion')
    .where('query_hash', '=', key)
    .executeTakeFirst()
  if (!row) return null
  await db
    .updateTable('expansion_cache')
    .set((eb) => ({ hits: eb('hits', '+', 1) }))
    .where('query_hash', '=', key)
    .execute()
  return row.expansion as unknown as Expansion
}

async function toCache(key: string, query: string, e: Expansion): Promise<void> {
  await db
    .insertInto('expansion_cache')
    .values({ query_hash: key, query_text: query, expansion: JSON.stringify(e), model: MODEL })
    .onConflict((oc) => oc.column('query_hash').doNothing())
    .execute()
}

export interface ExpandOptions {
  /** Skip the network entirely. Used by the eval harness's frozen mode. */
  offline?: boolean
  timeoutMs?: number
  usage?: (u: Usage) => void
}

/**
 * Expand a query, never throwing.
 *
 * Order: cache, then model, then lexical fallback. The lexical fallback is used
 * rather than "no expansion" when the model is unavailable, because it costs
 * nothing and still recovers the synonym chains that ingest already relies on.
 */
export async function expandQuery(
  query: string,
  opts: ExpandOptions = {},
): Promise<Guarded<Expansion>> {
  const key = cacheKey(query)

  const cached = await fromCache(key).catch(() => null)
  if (cached) return { value: cached, degraded: null }

  if (opts.offline || !llmAvailable()) {
    return {
      value: expandLexically(query),
      degraded: {
        stage: 'expansion',
        reason: 'unavailable',
        detail: opts.offline ? 'offline mode' : missingKeyHint(),
      },
    }
  }

  const guarded = await withFallback(
    'expansion',
    async () => {
      const { result, usage } = await callTool<RawExpansion>({
        system: SYSTEM,
        text: `Query: ${query}`,
        toolName: 'expand_query',
        toolDescription: 'Return retail surface forms and vocabulary attributes for this query.',
        schema: schema(),
        maxTokens: 2000,
      })
      opts.usage?.(usage)
      const e = sanitize(result)
      await toCache(key, query, e).catch(() => undefined)
      return e
    },
    // On failure fall back to lexical rather than to nothing.
    expandLexically(query),
    opts.timeoutMs ?? 1500,
  )

  return guarded
}
