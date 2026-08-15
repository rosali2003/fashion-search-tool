/**
 * Circuit breaker for LLM calls.
 *
 * `withFallback` already guarantees a search never *fails* because the provider
 * is down. It does not stop the search being slow: measured with a valid key on
 * an unpaid OpenAI account, every request burned 1,500ms on the expansion
 * timeout plus ~2,200ms of SDK retries on the rerank before falling back —
 * turning a 110ms search into a 4,000ms one while producing byte-identical
 * results.
 *
 * Retrying is correct for a blip and pointless for a wall. The distinction this
 * makes is between:
 *
 *   TERMINAL   401/403, or a quota/billing 429. No number of retries fixes an
 *              unpaid account. Trip immediately on the first occurrence.
 *   TRANSIENT  timeouts, 5xx, plain rate limits. Trip only after several in a
 *              row, because one slow call should not disable the feature.
 *
 * While open, the call is skipped entirely and the fallback returns in
 * microseconds. After a cooldown the breaker half-opens and lets one call
 * through to test the water.
 */

export type FailureKind = 'terminal' | 'transient'

/** Consecutive transient failures before the circuit opens. */
const TRANSIENT_THRESHOLD = 3

/**
 * How long to stay open. Terminal failures get a long cooldown because they need
 * human action — adding credits, fixing a key — and retrying every minute just
 * reintroduces the latency this exists to remove.
 */
const COOLDOWN_MS: Record<FailureKind, number> = {
  terminal: 10 * 60_000,
  transient: 30_000,
}

interface State {
  consecutive: number
  openUntil: number
  lastKind: FailureKind | null
  lastDetail: string
}

const circuits = new Map<string, State>()

const stateFor = (key: string): State =>
  circuits.get(key) ??
  (circuits.set(key, { consecutive: 0, openUntil: 0, lastKind: null, lastDetail: '' }),
  circuits.get(key)!)

/**
 * Classify a provider error.
 *
 * Deliberately matches on message text as well as status: both SDKs surface the
 * useful distinction ("insufficient_quota", "no credits remaining") in the
 * message, while the status alone conflates an unpaid account with a burst of
 * traffic.
 */
export function classify(err: unknown): FailureKind {
  const status = (err as { status?: number })?.status
  const message = err instanceof Error ? err.message : String(err)

  if (status === 401 || status === 403) return 'terminal'
  if (/invalid[_ ]api[_ ]key|authentication|unauthorized|permission/i.test(message)) {
    return 'terminal'
  }
  // A 429 is ambiguous. Quota and billing exhaustion are terminal; ordinary rate
  // limiting is transient and will pass.
  if (status === 429 || /\b429\b/.test(message)) {
    return /insufficient[_ ]quota|no credits|billing|exceeded your current quota|payment/i.test(
      message,
    )
      ? 'terminal'
      : 'transient'
  }
  return 'transient'
}

/** Whether calls for this key are currently suppressed. */
export function isOpen(key: string): boolean {
  const s = circuits.get(key)
  if (!s) return false
  if (s.openUntil === 0) return false
  if (Date.now() < s.openUntil) return true

  // Cooldown elapsed: half-open. Let the next call through, but keep the failure
  // count so a single further failure re-trips immediately rather than needing
  // to climb the transient threshold again.
  s.openUntil = 0
  return false
}

/** Why the circuit is open, for the degradation detail shown to the client. */
export function openReason(key: string): string {
  const s = circuits.get(key)
  if (!s?.lastKind) return 'circuit open'
  const secs = Math.max(0, Math.ceil((s.openUntil - Date.now()) / 1000))
  return `circuit open after ${s.lastKind} failure (${s.lastDetail}); retrying in ${secs}s`
}

export function recordSuccess(key: string): void {
  const s = circuits.get(key)
  if (!s) return
  s.consecutive = 0
  s.openUntil = 0
  s.lastKind = null
}

export function recordFailure(key: string, err: unknown): void {
  const s = stateFor(key)
  const kind = classify(err)
  s.consecutive += 1
  s.lastKind = kind
  s.lastDetail = (err instanceof Error ? err.message : String(err)).slice(0, 120)

  const trip = kind === 'terminal' || s.consecutive >= TRANSIENT_THRESHOLD
  if (trip) {
    s.openUntil = Date.now() + COOLDOWN_MS[kind]
    console.warn(
      JSON.stringify({
        level: 'warn',
        circuit: key,
        opened: true,
        kind,
        cooldown_ms: COOLDOWN_MS[kind],
        detail: s.lastDetail,
      }),
    )
  }
}

/** Test seam — the breaker is process-global state. */
export function resetCircuits(): void {
  circuits.clear()
}
