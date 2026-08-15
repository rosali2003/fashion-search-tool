/**
 * Q5 — "pick your preferred aesthetic" — as a scoring rule set.
 *
 * This file exists because Q5 arrived from the product plan with a destination
 * (`style_cluster`) but no consumer. An onboarding answer nothing reads is worse
 * than no question at all: the user reasonably expects tapping "minimal" to
 * change what they see, and `options.ts` documents that invariant as the reason
 * the vocabularies live in one shared place. So Q5 either scores garments or it
 * does not get asked.
 *
 * The same declared-heuristic posture as stylingRules.ts applies, and for the
 * same reason: these are conventional readings of what "classic" or "eclectic"
 * looks like, not facts about clothing. People disagree with them. They are kept
 * in one reviewable file, shown to the user as the reason a garment surfaced, and
 * progressively overridden by ELO once real choices accumulate.
 *
 * WHY THESE SIGNALS. Aesthetic is scored from `pattern`, `details`, `silhouette`
 * and `primary_fiber` — all deterministic normaliser output, none of it vision.
 * That is deliberate: vision geometry describes how a garment sits on a body,
 * which is what stylingRules.ts already reasons about. Taste is a different
 * question and answering it from the same inputs would make the two components
 * covary and double-count.
 *
 * COVERAGE, measured on the 355 active products rather than assumed:
 *   pattern    null on 181 (51%)   solid 61 · floral 28 · striped 24 · ribbed 22
 *   silhouette null on 200 (56%)
 *   details    27 distinct values, button-front 54 · zip-front 45 · self-tie 43
 *
 * Half the catalog is therefore silent on pattern, which is exactly why a garment
 * no rule speaks to must score neutral rather than zero. See `aestheticFit`.
 */

export interface AestheticSignals {
  pattern?: string | null
  silhouette?: string | null
  primary_fiber?: string | null
  neckline?: string | null
  details?: string[]
}

type SignalKey = keyof AestheticSignals

export interface AestheticRule {
  /** The Q5 answer this rule fires for. */
  cluster: string
  prefer?: Partial<Record<SignalKey, string[]>>
  avoid?: Partial<Record<SignalKey, string[]>>
  /** Shown to the user as the reason a garment matched their aesthetic. */
  because: string
}

export const AESTHETIC_RULES: readonly AestheticRule[] = [
  {
    cluster: 'minimal',
    prefer: {
      pattern: ['solid'],
      silhouette: ['slim', 'shift', 'boxy', 'sheath'],
      details: ['zip-front', 'raw-hem', 'open-back'],
    },
    avoid: {
      pattern: ['floral', 'graphic', 'lace', 'checked', 'geometric'],
      details: ['rhinestones', 'sequins', 'pearls', 'embroidery', 'ruffle', 'lace-trim'],
    },
    because: 'an unbroken solid and a clean line, with no applied ornament',
  },
  {
    cluster: 'classic',
    prefer: {
      pattern: ['solid', 'striped', 'checked'],
      silhouette: ['a-line', 'shift', 'slim', 'sheath'],
      details: ['button-front', 'pleated', 'pockets', 'cuffed', 'belted'],
      neckline: ['collared'],
      primary_fiber: ['cotton', 'linen', 'wool', 'silk', 'cashmere'],
    },
    avoid: {
      pattern: ['graphic'],
      details: ['rhinestones', 'sequins', 'cut-out', 'corset-back', 'backless'],
    },
    because: 'traditional shirting details and a natural fibre, cut to last',
  },
  {
    cluster: 'casual',
    prefer: {
      pattern: ['striped', 'ribbed', 'graphic', 'textured'],
      silhouette: ['relaxed', 'oversized', 'wide-leg', 'boxy'],
      details: ['drawstring', 'elastic-waist', 'pockets', 'half-button', 'drop-shoulder', 'cuffed'],
      primary_fiber: ['cotton'],
    },
    avoid: {
      details: ['sequins', 'rhinestones', 'pearls', 'corset-back', 'backless', 'open-back'],
      silhouette: ['mermaid', 'sheath'],
    },
    because: 'relaxed volume and pull-on ease in an everyday cotton',
  },
  {
    cluster: 'eclectic',
    prefer: {
      pattern: ['floral', 'lace', 'pointelle', 'geometric', 'graphic', 'checked'],
      silhouette: ['bubble', 'mermaid', 'a-line'],
      details: [
        'ruched', 'shirred', 'smocked', 'cut-out', 'lace-trim', 'slit', 'self-tie',
        'ruffle', 'embroidery', 'rhinestones', 'pearls', 'sequins', 'corset-back',
        'high-low', 'puff-sleeve', 'backless',
      ],
    },
    avoid: {
      pattern: ['solid'],
    },
    because: 'pattern and applied detail doing the talking',
  },
]

const has = (signals: AestheticSignals, key: SignalKey, values: string[]): boolean => {
  const v = signals[key]
  if (v == null) return false
  if (Array.isArray(v)) return v.some((x) => values.includes(x))
  return values.includes(v)
}

/** The rule for a cluster, or null when the user skipped Q5. */
export function ruleFor(cluster: string | null): AestheticRule | null {
  if (!cluster) return null
  return AESTHETIC_RULES.find((r) => r.cluster === cluster) ?? null
}

export interface AestheticMatch {
  rule: AestheticRule
  /** -1..1. Positive when the garment expresses the aesthetic, negative when it fights it. */
  score: number
  /** How many distinct signals agreed. Gates the user-facing line — see `aestheticReason`. */
  hits: number
}

/**
 * Signals that must agree before the aesthetic line is shown to the user.
 *
 * Scoring and explaining need different bars, which is why this exists.
 *
 * The score is a ratio, so a garment matching one signal and contradicting none
 * scores a perfect 1.0. That is right for ranking — a cotton item genuinely is
 * weak evidence for "classic" and should drift up slightly. It is wrong for
 * copy: it put "traditional shirting details and a natural fibre" under a pair
 * of cotton trousers, and under every other cotton item on the page, until the
 * sentence stopped carrying information at all.
 *
 * Two signals means the garment agreed on cut *and* fabric, or pattern *and*
 * trim — enough for the claim to be about this garment rather than about cotton.
 */
export const REASON_MIN_HITS = 2

/**
 * Score one garment against the user's chosen aesthetic.
 *
 * Returns 0..1 for the affinity blend. A garment whose pattern, silhouette and
 * details are all absent — half this catalog, on the measured coverage above —
 * scores the neutral 0.5 rather than 0. Scoring silence as disapproval would sort
 * the entire un-normalised tail to the bottom of every search, which is the same
 * trap `stylingFit` documents for products awaiting vision extraction.
 */
export function aestheticFit(
  cluster: string | null,
  signals: AestheticSignals,
): { score: number; match: AestheticMatch | null } {
  const rule = ruleFor(cluster)
  if (!rule) return { score: 0.5, match: null }

  let hits = 0
  let misses = 0

  for (const [key, values] of Object.entries(rule.prefer ?? {})) {
    if (has(signals, key as SignalKey, values as string[])) hits++
  }
  for (const [key, values] of Object.entries(rule.avoid ?? {})) {
    if (has(signals, key as SignalKey, values as string[])) misses++
  }

  if (hits === 0 && misses === 0) return { score: 0.5, match: null }

  const score = (hits - misses) / Math.max(1, hits + misses)
  return { score: (score + 1) / 2, match: { rule, score, hits } }
}

/**
 * The user-facing line.
 *
 * Deliberately stricter than the score: a garment can be nudged up the ranking on
 * one weak signal without earning a sentence claiming it suits the shopper's
 * taste. See REASON_MIN_HITS.
 */
export function aestheticReason(match: AestheticMatch | null): string | null {
  if (!match || match.score <= 0) return null
  return match.hits >= REASON_MIN_HITS ? match.rule.because : null
}

/** Guidance line for the rerank prompt, mirroring `guidanceFor` in stylingRules. */
export function aestheticGuidance(cluster: string | null): string[] {
  const rule = ruleFor(cluster)
  if (!rule) return []
  const prefer = Object.values(rule.prefer ?? {}).flat().slice(0, 6).join(', ')
  const avoid = Object.values(rule.avoid ?? {}).flat().slice(0, 4).join(', ')
  const parts = [`the shopper describes their taste as ${rule.cluster}: ${rule.because}`]
  if (prefer) parts.push(`prefer: ${prefer}`)
  if (avoid) parts.push(`avoid: ${avoid}`)
  return [parts.join(' — ')]
}
