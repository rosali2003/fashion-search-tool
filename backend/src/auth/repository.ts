import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { sql, type Kysely, type Selectable } from 'kysely'
import { db } from '../db/index.js'
import type { Database } from '../db/types.js'
import { cookieOptions, hashToken, randomToken, SESSION_COOKIE, GOOGLE_COOKIE, EMAIL_COOKIE, LINK_COOKIE } from './security.js'

export type Session = { user_id: string; token_hash: string; display_name: string | null; email: string | null }
export type Challenge = Selectable<Database['auth_challenges']>

export async function currentSession(context: Context): Promise<Session | null> {
  const token = getCookie(context, SESSION_COOKIE)
  if (!token) return null
  return await db.selectFrom('sessions').innerJoin('users', 'users.id', 'sessions.user_id')
    .leftJoin('accounts', 'accounts.user_id', 'users.id')
    .select(['sessions.user_id', 'sessions.token_hash', 'users.display_name', 'accounts.email'])
    .where('token_hash', '=', hashToken(token)).where('expires_at', '>', new Date())
    .executeTakeFirst() ?? null
}

export async function revokeSession(context: Context): Promise<void> {
  const token = getCookie(context, SESSION_COOKIE)
  if (token) await db.deleteFrom('sessions').where('token_hash', '=', hashToken(token)).execute()
  for (const cookie of [GOOGLE_COOKIE, EMAIL_COOKIE, LINK_COOKIE]) {
    const challenge = getCookie(context, cookie)
    if (challenge) await db.deleteFrom('auth_challenges').where('token_hash', '=', hashToken(challenge)).execute()
    deleteCookie(context, cookie, cookieOptions(0))
  }
  deleteCookie(context, SESSION_COOKIE, cookieOptions(0))
}

export async function issueSession(context: Context, userId: string): Promise<void> {
  const token = randomToken()
  const maxAge = 60 * 60 * 24 * 30
  await db.insertInto('sessions').values({ token_hash: hashToken(token), user_id: userId, expires_at: new Date(Date.now() + maxAge * 1000) }).execute()
  await revokeSession(context)
  setCookie(context, SESSION_COOKIE, token, cookieOptions(maxAge))
}

export async function requireOwner(context: Context, next: () => Promise<void>) {
  const session = await currentSession(context)
  if (!session || session.user_id !== context.req.param('id')) return context.json({ error: 'Profile access requires its session' }, 401)
  await next()
}

export async function saveChallenge(context: Context, cookie: string, values: Omit<Challenge, 'token_hash' | 'attempts' | 'expires_at'>) {
  const previous = getCookie(context, cookie)
  if (previous) await db.deleteFrom('auth_challenges').where('token_hash', '=', hashToken(previous)).execute()
  const token = randomToken()
  await db.insertInto('auth_challenges').values({ ...values, token_hash: hashToken(token), expires_at: new Date(Date.now() + 600_000) }).execute()
  setCookie(context, cookie, token, cookieOptions(600))
  return token
}

export async function loadChallenge(context: Context, cookie: string, kind: Challenge['kind'], session: Session | null) {
  const token = getCookie(context, cookie)
  if (!token) return null
  const challenge = await db.selectFrom('auth_challenges').selectAll()
    .where('token_hash', '=', hashToken(token)).where('kind', '=', kind)
    .where('expires_at', '>', new Date()).executeTakeFirst()
  return challenge && challenge.session_hash === (session?.token_hash ?? null) ? challenge : null
}

export const emptyChallenge = {
  email: null, google_subject: null, verifier: null, nonce: null, provider_sid: null,
}

export async function emptyPreferences(database: Kysely<Database>, userId: string) {
  await database.insertInto('user_preferences').values({
    user_id: userId, height_cm: null, body_type: null, shoulders: null, torso: null, waist: null,
    fiber_preference: null, quality_tier: null, style_cluster: null, price_min_cents: null,
    price_max_cents: null, onboarded_at: null,
  }).execute()
}

export async function resolveAccount(
  database: Kysely<Database>,
  identity: { email: string; subject?: string; name?: string | null; emailProven: boolean },
  session: Session | null,
): Promise<{ userId: string } | { needsLink: true }> {
  const { email, subject } = identity
  await sql`select pg_advisory_xact_lock(hashtextextended(${`email:${email}`}, 0))`.execute(database)
  if (subject) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`google:${subject}`}, 0))`.execute(database)
    const google = await database.selectFrom('accounts').select('user_id').where('google_subject', '=', subject).executeTakeFirst()
    if (google) return { userId: google.user_id }
  }
  const existing = await database.selectFrom('accounts').selectAll().where('email', '=', email).executeTakeFirst()
  if (existing) {
    if (subject) {
      if (!identity.emailProven) return { needsLink: true }
      if (existing.google_subject && existing.google_subject !== subject) throw new Error('Account already linked')
      await database.updateTable('accounts').set({ google_subject: subject }).where('user_id', '=', existing.user_id).execute()
    }
    return { userId: existing.user_id }
  }
  let userId: string
  if (session && !session.email) {
    await database.selectFrom('users').select('id').where('id', '=', session.user_id).forUpdate().executeTakeFirstOrThrow()
    const claimed = await database.selectFrom('accounts').select('user_id').where('user_id', '=', session.user_id).executeTakeFirst()
    const live = await database.selectFrom('sessions').select('user_id').where('token_hash', '=', session.token_hash)
      .where('expires_at', '>', new Date()).executeTakeFirst()
    if (claimed || !live) throw new Error('Guest session changed')
    userId = session.user_id
    await database.deleteFrom('sessions').where('user_id', '=', userId).execute()
  } else {
    const user = await database.insertInto('users').values({ display_name: null }).returning('id').executeTakeFirstOrThrow()
    userId = user.id
    await emptyPreferences(database, userId)
  }
  await database.insertInto('accounts').values({ user_id: userId, email, google_subject: subject ?? null }).execute()
  if (identity.name) await database.updateTable('users').set({ display_name: identity.name.slice(0, 80) }).where('id', '=', userId).execute()
  return { userId }
}

export async function cleanupAuth(): Promise<void> {
  for (const table of ['auth_challenges', 'auth_limits', 'sessions'] as const) {
    await db.deleteFrom(table).where('expires_at', '<=', new Date()).execute()
  }
}
