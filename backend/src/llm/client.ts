import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { activeModel, envVarFor, specFor, type Provider } from './models.js'
import { toStrictSchema } from './strictSchema.js'

/**
 * Provider-agnostic LLM client.
 *
 * Every LLM interaction in this system is the same shape: a system prompt, some
 * text, optionally some images, and a JSON schema the answer must satisfy. That
 * shape maps cleanly onto both providers, so `callTool` is the only place either
 * SDK appears and the four calling stages know nothing about which is in use.
 *
 * Provider is derived from the model id via the registry in models.ts, so it can
 * never disagree with the model being called.
 */

export { activeModel as MODEL_FN }

/** The model in use for this process. Read once so logs stay consistent. */
export const MODEL = activeModel()
export const SPEC = specFor(MODEL)
export const PROVIDER: Provider = SPEC.provider

let anthropicClient: Anthropic | null = null
let openaiClient: OpenAI | null = null

/** Whether the key for the *active* model's provider is present. */
export function llmAvailable(): boolean {
  return Boolean(process.env[envVarFor(PROVIDER)])
}

/** Which providers have a usable key, regardless of which model is selected. */
export function availableProviders(): Provider[] {
  const out: Provider[] = []
  if (process.env.ANTHROPIC_API_KEY) out.push('anthropic')
  if (process.env.OPENAI_API_KEY) out.push('openai')
  return out
}

function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set')
  // maxRetries 1: the search path has a 1.5-6s budget, so the SDK's default of
  // two retries with backoff guarantees a timeout and hides the real status code
  // from the circuit breaker's classifier. Repeated failure is the breaker's job.
  anthropicClient ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 })
  return anthropicClient
}

function openai(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set')
  openaiClient ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 1 })
  return openaiClient
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  calls: number
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, calls: 0 })

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    calls: a.calls + (b.calls ?? 0),
  }
}

/** Cost of usage under the active model's pricing. */
export function costUsd(u: Usage, model = MODEL): number {
  const spec = specFor(model)
  return (
    (u.inputTokens / 1_000_000) * spec.inputPerMtok +
    (u.outputTokens / 1_000_000) * spec.outputPerMtok
  )
}

/** Provider-neutral image. Encoding differs per provider; callers don't care. */
export interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  base64: string
}

export interface CallToolOptions {
  system: string
  text: string
  images?: ImageInput[]
  /** Used as the tool name (Anthropic) or the schema name (OpenAI). */
  toolName: string
  toolDescription: string
  schema: Record<string, unknown>
  /**
   * Budget for the visible response. On reasoning models this is shared with
   * invisible reasoning tokens, so it needs headroom beyond the JSON size —
   * exceeding it yields `finish_reason: length` and unparseable output.
   */
  maxTokens: number
  /**
   * Run this call on a specific model instead of the process default.
   *
   * Stages are different problems and do not all need the same model: vision
   * extraction measurably fails on gpt-5-nano and succeeds on gpt-5-mini, while
   * text extraction is fine on nano. See `modelForStage` in models.ts.
   */
  model?: string
  /** Override the model's default reasoning effort for this call. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  /**
   * Per-request retry count.
   *
   * The clients default to 1 because the search path has a 1.5-6s budget and the
   * SDK's backoff outlives it. Ingest is the opposite case: nobody is waiting, and
   * a 429 that says "try again in 1.9s" should simply be waited out. The SDK
   * already honours Retry-After, so raising this is all that is needed —
   * hand-rolled backoff would only reimplement it worse.
   */
  retries?: number
}

async function callAnthropic<T>(o: CallToolOptions): Promise<{ result: T; usage: Usage }> {
  const model = o.model ?? MODEL
  const spec = specFor(model)
  const content: Anthropic.ContentBlockParam[] = [
    ...(o.images ?? []).map(
      (img): Anthropic.ImageBlockParam => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
      }),
    ),
    { type: 'text', text: o.text },
  ]

  const res = await anthropic().messages.create(
    {
    model,
    max_tokens: o.maxTokens,
    ...(spec.supportsTemperature ? { temperature: 0 } : {}),
    system: o.system,
    tools: [
      {
        name: o.toolName,
        description: o.toolDescription,
        input_schema: o.schema as Anthropic.Tool['input_schema'],
      },
    ],
    // Forcing the tool is what makes this reliable: without it the model may
    // answer in prose and the sanitizer sees nothing.
    tool_choice: { type: 'tool', name: o.toolName },
    messages: [{ role: 'user', content }],
    },
    o.retries === undefined ? undefined : { maxRetries: o.retries },
  )

  const block = res.content.find((b) => b.type === 'tool_use')
  if (!block || block.type !== 'tool_use') throw new Error('model returned no tool_use block')

  return {
    result: block.input as T,
    usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, calls: 1 },
  }
}

async function callOpenAI<T>(o: CallToolOptions): Promise<{ result: T; usage: Usage }> {
  const model = o.model ?? MODEL
  const spec = specFor(model)
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    ...(o.images ?? []).map(
      (img): OpenAI.Chat.Completions.ChatCompletionContentPart => ({
        type: 'image_url',
        image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
      }),
    ),
    { type: 'text', text: o.text },
  ]

  const effort = o.reasoningEffort ?? spec.reasoningEffort

  const res = await openai().chat.completions.create(
    {
    model,
    // Newer OpenAI models use max_completion_tokens; max_tokens is rejected.
    max_completion_tokens: o.maxTokens,
    ...(spec.supportsTemperature ? { temperature: 0 } : {}),
    // Reasoning tokens are drawn from the same budget as the answer and billed
    // as output. Left at the default, a trivial enum extraction spent 640 of 658
    // output tokens thinking. See ModelSpec.reasoningEffort.
    ...(effort ? { reasoning_effort: effort } : {}),
    // Structured Outputs rather than function calling. `strict: true` enforces
    // the schema by constrained decoding, which is the whole reason this
    // provider is worth supporting: enum values outside the controlled
    // vocabulary become impossible instead of merely unlikely.
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: o.toolName,
        description: o.toolDescription,
        strict: true,
        schema: toStrictSchema(o.schema) as Record<string, unknown>,
      },
    },
    messages: [
      { role: 'system', content: o.system },
      { role: 'user', content: parts },
    ],
    },
    o.retries === undefined ? undefined : { maxRetries: o.retries },
  )

  const choice = res.choices[0]
  if (choice?.finish_reason === 'length') {
    // Truncated JSON will not parse. Surfacing it as an error lets withFallback
    // degrade cleanly rather than the sanitizer silently returning nothing.
    // Naming the reasoning spend makes the fix obvious: on a reasoning model the
    // budget is usually consumed before the answer starts, not by a long answer.
    const reasoning =
      (res.usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined)
        ?.completion_tokens_details?.reasoning_tokens ?? 0
    throw new Error(
      `response truncated at max_completion_tokens=${o.maxTokens} ` +
        `(reasoning_effort=${effort ?? 'default'}, ${reasoning} reasoning tokens consumed)`,
    )
  }
  const text = choice?.message?.content
  if (!text) throw new Error('model returned empty content')

  return {
    result: JSON.parse(text) as T,
    usage: {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      calls: 1,
    },
  }
}

/**
 * Call the active model with a schema-constrained response.
 *
 * Never called directly from a route — everything in the search path goes
 * through `withFallback` in guard.ts, which is what guarantees a slow or failing
 * provider degrades the response instead of failing the request.
 */
export async function callTool<T>(o: CallToolOptions): Promise<{ result: T; usage: Usage }> {
  const model = o.model ?? MODEL
  const spec = specFor(model)
  if (o.images?.length && !spec.vision) {
    throw new Error(`Model ${model} does not accept images`)
  }
  return spec.provider === 'openai' ? callOpenAI<T>(o) : callAnthropic<T>(o)
}

/** Human-readable reason the active provider is unusable. */
export function missingKeyHint(): string {
  return `${envVarFor(PROVIDER)} not set (model ${MODEL} is a ${PROVIDER} model)`
}

/** One line at startup so the active provider is never a mystery in the logs. */
export function describeLlm(): string {
  const have = availableProviders()
  const ready = llmAvailable()
  return JSON.stringify({
    model: MODEL,
    provider: PROVIDER,
    ready,
    keys_present: have,
    note: ready
      ? undefined
      : `${envVarFor(PROVIDER)} is not set — LLM stages will degrade to BM25-only`,
  })
}
