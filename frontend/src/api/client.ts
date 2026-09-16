import type {
  AuthSession, OnboardingInput, OnboardingOptions, PairItem, Profile, SearchResponse,
} from './types.js'

/**
 * API client.
 *
 * Same-origin: Vite proxies /api to localhost:3000 in dev, so there is no base
 * URL to configure and no CORS to handle.
 */

let currentUserId: string | null = null
let sessionVersion = 0

export const getUserId = (): string | null => currentUserId
export const setUserId = (id: string): void => { sessionVersion++; currentUserId = id }
export const clearUserId = (): void => { sessionVersion++; currentUserId = null }

export async function fetchSession(): Promise<AuthSession> {
  const version = ++sessionVersion
  const session = await json<AuthSession>(await fetch('/api/auth/session', { cache: 'no-store' }))
  if (version !== sessionVersion) throw new DOMException('Session changed', 'AbortError')
  currentUserId = session.user?.id ?? null
  return session
}

async function authMutation(path: string, body: object = {}, method = 'POST'): Promise<void> {
  sessionVersion++
  await json(await fetch(`/api/auth/${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  sessionVersion++
}

export async function logout(): Promise<void> {
  await authMutation('logout')
  clearUserId()
}

export const requestEmailCode = (email: string, link: boolean): Promise<void> => authMutation('email/request', { email, link })
export const verifyEmailCode = (code: string): Promise<void> => authMutation('email/verify', { code })
export const updateName = (name: string): Promise<void> => authMutation('name', { name }, 'PUT')

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return (await res.json()) as T
}

/**
 * Search.
 *
 * `signal` is not optional in practice — the pipeline takes seconds when the LLM
 * stages are live, so without aborting the previous request a fast second search
 * can be overwritten by a slow first one arriving later.
 */
export async function search(
  query: string,
  opts: { brands?: string[]; signal?: AbortSignal } = {},
): Promise<SearchResponse> {
  const res = await fetch('/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      brands: opts.brands ?? [],
    }),
    signal: opts.signal,
  })
  return json<SearchResponse>(res)
}

export async function fetchOptions(): Promise<OnboardingOptions> {
  return json<OnboardingOptions>(await fetch('/api/users/options'))
}

export async function createUser(input: OnboardingInput): Promise<string> {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const { userId } = await json<{ userId: string }>(res)
  setUserId(userId)
  return userId
}

export async function fetchProfile(userId: string): Promise<Profile> {
  return json<Profile>(await fetch(`/api/users/${userId}`))
}

export async function suggestPair(userId: string, productIds: number[]): Promise<PairItem[] | null> {
  const res = await fetch(`/api/users/${userId}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productIds }),
  })
  const { pair } = await json<{ pair: PairItem[] | null }>(res)
  return pair
}

export async function recordComparison(
  userId: string,
  winnerId: number,
  loserId: number,
): Promise<{ comparisons: number; profileStable: boolean }> {
  const res = await fetch(`/api/users/${userId}/comparisons`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ winnerId, loserId }),
  })
  return json<{ comparisons: number; profileStable: boolean }>(res)
}

export const formatPrice = (cents: number | null): string =>
  cents === null ? '' : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
