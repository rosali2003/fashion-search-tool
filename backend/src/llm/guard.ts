/**
 * The single chokepoint for every Anthropic call.
 *
 * INVARIANT: nothing in the search request path may `await` an Anthropic call
 * directly. Every one goes through `withFallback`. This is deliberately a
 * greppable rule rather than a convention — search must never 500 because a
 * model provider is slow, and the only way to be sure of that is for there to be
 * exactly one place where a timeout and a catch are guaranteed.
 *
 * To audit: `grep -rn "anthropic\|messages.create" src/ --include=*.ts` should
 * only find client.ts and the modules it backs, never a route.
 */

import { isOpen, openReason, recordFailure, recordSuccess } from './breaker.js'

export interface Degradation {
  /** Stage label, surfaced to the client in `meta.degraded`. */
  stage: string
  reason: 'timeout' | 'error' | 'unavailable' | 'invalid' | 'circuit-open'
  detail?: string
}

export interface Guarded<T> {
  value: T
  degraded: Degradation | null
}

export class Timeout extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`)
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Timeout(ms)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * Run `fn` with a hard timeout, returning `fallback` on any failure.
 *
 * Never throws. The caller always gets a usable value plus, when something went
 * wrong, a `Degradation` describing what — so the response can be honest about
 * being degraded rather than silently worse.
 */
export async function withFallback<T>(
  stage: string,
  fn: () => Promise<T>,
  fallback: T,
  timeoutMs: number,
): Promise<Guarded<T>> {
  // Skip the call entirely while the circuit is open. This is the difference
  // between a degraded search that is still fast and one that pays the full
  // timeout-and-retry cost on every request to reach the same fallback.
  if (isOpen(stage)) {
    return { value: fallback, degraded: { stage, reason: 'circuit-open', detail: openReason(stage) } }
  }

  try {
    const value = await withTimeout(fn(), timeoutMs)
    recordSuccess(stage)
    return { value, degraded: null }
  } catch (err) {
    recordFailure(stage, err)
    const isTimeout = err instanceof Timeout
    const detail = err instanceof Error ? err.message : String(err)
    // Logged as structured JSON so a rise in degradation is visible in the same
    // stream as the request log, rather than only as slower results.
    console.warn(
      JSON.stringify({ level: 'warn', stage, degraded: isTimeout ? 'timeout' : 'error', detail }),
    )
    return {
      value: fallback,
      degraded: { stage, reason: isTimeout ? 'timeout' : 'error', detail },
    }
  }
}

/** Collect degradation labels for the response `meta`. */
export function labels(...ds: (Degradation | null)[]): string[] {
  return ds.filter((d): d is Degradation => d !== null).map((d) => d.stage)
}
