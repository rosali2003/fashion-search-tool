import { createHash, randomBytes } from 'node:crypto'
import type { Context, Next } from 'hono'

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('base64url')
export const randomToken = (): string => randomBytes(32).toString('base64url')
export const SESSION_COOKIE = 'ink_session'
export const GOOGLE_COOKIE = 'ink_google'
export const EMAIL_COOKIE = 'ink_email'
export const LINK_COOKIE = 'ink_link'

export function appOrigin(): string {
  if (process.env.NODE_ENV === 'production' && !process.env.APP_ORIGIN) throw new Error('APP_ORIGIN is required')
  const url = new URL(process.env.APP_ORIGIN ?? 'http://localhost:5173')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) {
    throw new Error('APP_ORIGIN must use HTTPS, except localhost')
  }
  return url.origin
}

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: appOrigin().startsWith('https:'), sameSite: 'Lax' as const, path: '/', maxAge }
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

export function isTrustedMutation(request: Request): boolean {
  const origin = request.headers.get('origin')
  return (!origin || origin === appOrigin()) && request.headers.get('sec-fetch-site') !== 'cross-site'
    && request.headers.get('content-type')?.split(';')[0].trim() === 'application/json'
}

export async function protectMutations(context: Context, next: Next) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) && !isTrustedMutation(context.req.raw)) {
    return context.json({ error: 'Request must be same-origin JSON' }, 403)
  }
  await next()
}

export async function readObject(context: Context): Promise<Record<string, unknown> | null> {
  const body: unknown = await context.req.json().catch(() => null)
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
}
