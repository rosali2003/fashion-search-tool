/**
 * Per-IP rate limiting for the routes that cost money.
 *
 * `POST /api/search` makes up to two paid LLM calls per request — expansion and
 * rerank — and remains available to guests despite optional account sign-in.
 * A public URL therefore exposes a way to spend the
 * operator's API budget at the speed of curl. This is the cheap structural
 * mitigation; the account-level spend cap is the one that actually bounds the
 * loss, and both should exist.
 *
 * Deliberately in-memory and dependency-free. The state is a single Map and the
 * deployment runs one replica, so a shared store would be complexity without a
 * consumer. If replicas are ever added this becomes per-instance — the limit
 * effectively multiplies by the replica count, which degrades the protection
 * rather than breaking correctness.
 */
import type { Context, Next } from 'hono'

/** Requests allowed per IP per window. */
const LIMIT = 20
const WINDOW_MS = 60_000

/**
 * Sliding window of request timestamps per client.
 *
 * A fixed counter reset on a boundary would let a caller send 2x the limit
 * across a boundary; keeping timestamps costs a small array per active IP and
 * removes that edge.
 */
const hits = new Map<string, number[]>()

/**
 * The client IP as seen through however many proxies are in front of us.
 *
 * There are two paths to this service and they do NOT agree on where the real
 * client lands, which is why this is not simply the leftmost x-forwarded-for:
 *
 *   direct to Railway   x-forwarded-for: <client>, <railway-edge>
 *   via the Vercel      x-forwarded-for: <vercel-edge>, <railway-edge>
 *   rewrite             x-vercel-forwarded-for: <client>
 *
 * Vercel REPLACES the leftmost x-forwarded-for with its own edge address rather
 * than prepending the caller, and that address differs from request to request.
 * Keying on x-forwarded-for alone therefore gave every request through
 * inksearch.shop its own bucket — 23 consecutive searches against the public
 * domain never once hit the limit, while the same burst sent straight at Railway
 * 429'd on the 21st. The public path, the only one that matters here, was the
 * unprotected one.
 *
 * x-vercel-forwarded-for is checked first because its presence *is* the signal
 * that the request arrived through the rewrite. Both headers are spoofable by a
 * caller who reaches Railway directly; that is acceptable for a budget guard and
 * would not be for anything security-bearing.
 */
function clientKey(c: Context): string {
  const vercel = c.req.header('x-vercel-forwarded-for')
  if (vercel) return vercel.split(',')[0]!.trim()
  const fwd = c.req.header('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim()
  return c.req.header('cf-connecting-ip') ?? 'unknown'
}

/** Drop timestamps outside the window, and forget clients that have gone quiet. */
function sweep(now: number): void {
  for (const [key, times] of hits) {
    const live = times.filter((t) => now - t < WINDOW_MS)
    if (live.length === 0) hits.delete(key)
    else hits.set(key, live)
  }
}

let lastSweep = 0

export async function rateLimit(c: Context, next: Next): Promise<Response | void> {
  const now = Date.now()

  // Sweeping on a timer would keep the process awake; sweeping on every request
  // is O(clients) per request. Once per window is enough to bound the Map.
  if (now - lastSweep > WINDOW_MS) {
    sweep(now)
    lastSweep = now
  }

  const key = clientKey(c)
  const times = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS)

  if (times.length >= LIMIT) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - times[0]!)) / 1000)
    console.log(
      JSON.stringify({ level: 'warn', stage: 'rate_limit', key, hits: times.length }),
    )
    return c.json(
      { error: 'Too many requests. Try again shortly.' },
      429,
      { 'Retry-After': String(retryAfter) },
    )
  }

  times.push(now)
  hits.set(key, times)
  await next()
}
