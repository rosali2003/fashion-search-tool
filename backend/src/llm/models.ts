/**
 * Model registry.
 *
 * The one place that knows which provider owns a model and what it costs.
 * Provider is derived from this table, never from a separate env var — a
 * `PROVIDER=openai` setting alongside `MODEL=claude-...` is a configuration that
 * can be wrong, and this shape cannot be.
 *
 * Prices are $ per million tokens and drift. `pnpm enrich` reports actual usage
 * from the API response, so a stale constant here shows up as a cost estimate
 * that disagrees with the logged total rather than as a silent overspend.
 */

export type Provider = 'anthropic' | 'openai'

export interface ModelSpec {
  provider: Provider
  /** $ per million input tokens. */
  inputPerMtok: number
  /** $ per million output tokens. */
  outputPerMtok: number
  /** Whether the model accepts images. Vision extraction refuses without it. */
  vision: boolean
  /**
   * OpenAI reasoning-family models reject `temperature` other than the default.
   * Anthropic accepts 0, which is what we want everywhere else — every call in
   * this system is an extraction or a ranking, none benefit from sampling.
   */
  supportsTemperature: boolean
  /**
   * Reasoning models spend `max_completion_tokens` on internal reasoning BEFORE
   * emitting any visible output, and those tokens are billed as output.
   *
   * Measured on gpt-5-nano for a single-field enum extraction ("is a camisole a
   * top?"): 658 output tokens at the default effort, 640 of them reasoning. At
   * `minimal` the same call costs 17 tokens and returns the same answer. On an
   * 8-product batch the default blew through a 2,000-token budget before
   * producing a single character of JSON, which surfaced as
   * `finish_reason: length`.
   *
   * Every call in this system is schema-constrained extraction against a
   * controlled vocabulary — the enum does the constraining, not deliberation —
   * so `minimal` is the right default. Reranking is the one stage where more
   * thinking might genuinely help; that is an experiment for the eval harness,
   * not an assumption. Undefined for non-reasoning models.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
}

export const MODELS: Record<string, ModelSpec> = {
  // ── Anthropic ──────────────────────────────────────────────────────────────
  'claude-haiku-4-5-20251001': {
    provider: 'anthropic', inputPerMtok: 1.0, outputPerMtok: 5.0,
    vision: true, supportsTemperature: true,
  },
  'claude-sonnet-5': {
    provider: 'anthropic', inputPerMtok: 3.0, outputPerMtok: 15.0,
    vision: true, supportsTemperature: true,
  },
  'claude-opus-5': {
    provider: 'anthropic', inputPerMtok: 15.0, outputPerMtok: 75.0,
    vision: true, supportsTemperature: true,
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  'gpt-5-nano': {
    provider: 'openai', inputPerMtok: 0.05, outputPerMtok: 0.40,
    vision: true, supportsTemperature: false, reasoningEffort: 'minimal',
  },
  'gpt-5-mini': {
    provider: 'openai', inputPerMtok: 0.25, outputPerMtok: 2.00,
    vision: true, supportsTemperature: false, reasoningEffort: 'minimal',
  },
  'gpt-5.4-nano': {
    provider: 'openai', inputPerMtok: 0.20, outputPerMtok: 1.25,
    vision: true, supportsTemperature: false, reasoningEffort: 'minimal',
  },
  'gpt-5.4-mini': {
    provider: 'openai', inputPerMtok: 0.75, outputPerMtok: 4.50,
    vision: true, supportsTemperature: false, reasoningEffort: 'minimal',
  },
  'gpt-5': {
    provider: 'openai', inputPerMtok: 1.25, outputPerMtok: 10.00,
    vision: true, supportsTemperature: false, reasoningEffort: 'minimal',
  },
}

/**
 * The default model.
 *
 * gpt-5-nano: ~17x cheaper per search than claude-haiku-4-5 on this workload,
 * and OpenAI's strict structured outputs guarantee enum conformance by
 * constrained decoding rather than merely encouraging it — which matters here
 * because every extracted value is validated against a controlled vocabulary and
 * an out-of-vocabulary value is dropped rather than surfaced.
 *
 * Whether it is good *enough* at reranking is an open question. Reranking is the
 * only stage doing real judgement, and it is the one to check with
 * `pnpm eval -- --full --repeat 3` before trusting.
 */
export const DEFAULT_MODEL = 'gpt-5-nano'

/**
 * Stages can run different models, because they are different problems.
 *
 * Measured on the same two products, same prompt, same images:
 *
 *   gpt-5-nano   13-28 "details" per garment, confidence 0.14-0.60,
 *                v_hem_break and v_waist_definition null throughout
 *   gpt-5-mini   3 details, confidence 0.60-0.86, geometry populated
 *
 * Strict Structured Outputs guarantee every value is in the vocabulary; they do
 * nothing about a model enumerating the enum instead of describing the photo.
 * Nano is fine for text extraction, where the copy states the answer — it is not
 * fine at reading a garment off an image.
 *
 * Override per stage with INK_MODEL_VISION / INK_MODEL_EXTRACT /
 * INK_MODEL_RERANK / INK_MODEL_EXPAND; each falls back to INK_MODEL.
 */
export type Stage = 'vision' | 'extract' | 'rerank' | 'expand'

const STAGE_DEFAULTS: Partial<Record<Stage, string>> = {
  // The two stages where the cheap model measurably fails.
  //
  // vision — nano emitted 13-29 "details" per garment at confidence ~0.2 with
  //   geometry fields null; mini emits ~3 at ~0.75 with geometry populated.
  //
  // rerank — nano is worse than no reranking at all. On the canary query, BM25
  //   alone puts the correct product first; nano's rerank replaced it with a
  //   peplum top and justified the choice with "has a tie feature? (no tie)" —
  //   it stated the disqualifying fact and ranked the item first regardless. It
  //   also truncated 10 results to 2.
  //
  // Extraction and expansion stay on nano: those are schema-constrained lookups
  // where the enum does the work. Reranking and vision require judgement, and
  // that is what nano does not have.
  vision: 'gpt-5-mini',
  rerank: 'gpt-5-mini',
}

export function modelForStage(stage: Stage): string {
  const envKey = `INK_MODEL_${stage.toUpperCase()}`
  const explicit = process.env[envKey]?.trim()
  if (explicit && MODELS[explicit]) return explicit
  if (explicit) {
    console.warn(
      JSON.stringify({ level: 'warn', message: `${envKey}="${explicit}" is not in the registry; ignoring` }),
    )
  }
  // A stage default only applies when the operator has not pinned INK_MODEL to a
  // different provider — mixing providers silently would be surprising.
  const base = activeModel()
  const preferred = STAGE_DEFAULTS[stage]
  if (preferred && MODELS[preferred] && MODELS[preferred].provider === specFor(base).provider) {
    return preferred
  }
  return base
}

/** Override with INK_MODEL. Falls back to the default when unset or unknown. */
export function activeModel(): string {
  const requested = process.env.INK_MODEL?.trim()
  if (!requested) return DEFAULT_MODEL
  if (!MODELS[requested]) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: `INK_MODEL="${requested}" is not in the registry; using ${DEFAULT_MODEL}`,
        known: Object.keys(MODELS),
      }),
    )
    return DEFAULT_MODEL
  }
  return requested
}

export function specFor(model: string): ModelSpec {
  const spec = MODELS[model]
  if (!spec) throw new Error(`Unknown model "${model}". Add it to MODELS in llm/models.ts.`)
  return spec
}

export const envVarFor = (provider: Provider): string =>
  provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
