import { Hono } from 'hono'
import { getCookie, deleteCookie } from 'hono/cookie'
import { db } from '../db/index.js'
import { currentSession, revokeSession, issueSession, saveChallenge, loadChallenge, emptyChallenge, resolveAccount, cleanupAuth } from '../auth/repository.js'
import { cookieOptions, randomToken, normalizeEmail, readObject, GOOGLE_COOKIE, EMAIL_COOKIE, LINK_COOKIE } from '../auth/security.js'
import { providers, googleEnabled, emailEnabled, redirectUri } from '../auth/providers.js'
import { allowEmail, takeLimit } from '../auth/limits.js'

const auth = new Hono()

auth.use('*', async (context, next) => {
  context.header('Cache-Control', 'no-store')
  context.header('Referrer-Policy', 'no-referrer')
  await next()
})

auth.get('/session', async context => {
  const session = await currentSession(context)
  const link = await loadChallenge(context, LINK_COOKIE, 'link', session)
  return context.json({ googleEnabled: googleEnabled(), emailEnabled: emailEnabled(),
    linkingEmail: link?.email ?? null,
    user: session ? { id: session.user_id, name: session.display_name, authenticated: Boolean(session.email) } : null,
  })
})

auth.post('/logout', async context => {
  await revokeSession(context)
  return context.json({ ok: true })
})

auth.put('/name', async context => {
  const session = await currentSession(context)
  if (!session?.email) return context.json({ error: 'Sign in to update your name' }, 401)
  const body = await readObject(context)
  if (!body || typeof body.name !== 'string' || body.name.trim().length > 80) return context.json({ error: 'Use a name of 80 characters or fewer' }, 400)
  await db.updateTable('users').set({ display_name: body.name.trim() || null }).where('id', '=', session.user_id).execute()
  return context.json({ ok: true })
})

auth.get('/google', async context => {
  if (!googleEnabled()) return context.redirect('/?auth=unavailable')
  if (context.req.header('sec-fetch-site') === 'cross-site') return context.redirect('/?auth=failed')
  const session = await currentSession(context)
  if (session?.email) return context.redirect('/')
  if (!await takeLimit('google:start:global', 500, 3600)) return context.redirect('/?auth=unavailable')
  try {
    await cleanupAuth()
    const verifier = randomToken()
    const nonce = randomToken()
    const state = await saveChallenge(context, GOOGLE_COOKIE, { ...emptyChallenge, kind: 'google',
      verifier, nonce, session_hash: session?.token_hash ?? null })
    return context.redirect(await providers.googleStart(state, verifier, nonce))
  } catch {
    console.warn(JSON.stringify({ stage: 'auth', event: 'google_start_failed' }))
    return context.redirect('/?auth=failed')
  }
})

auth.get('/google/callback', async context => {
  const state = context.req.query('state')
  if (!googleEnabled() || !state || state !== getCookie(context, GOOGLE_COOKIE)) return context.redirect('/?auth=failed')
  const session = await currentSession(context)
  const pending = await loadChallenge(context, GOOGLE_COOKIE, 'google', session)
  deleteCookie(context, GOOGLE_COOKIE, cookieOptions(0))
  if (!pending?.verifier || !pending.nonce || session?.email) return context.redirect('/?auth=failed')
  const consumed = await db.deleteFrom('auth_challenges').where('token_hash', '=', pending.token_hash).returning('token_hash').executeTakeFirst()
  if (!consumed) return context.redirect('/?auth=failed')
  if (context.req.query('error')) return context.redirect('/?auth=cancelled')
  try {
    const url = new URL(redirectUri())
    url.search = new URL(context.req.url).search
    const identity = await providers.googleFinish(url, state, pending.verifier, pending.nonce)
    const result = await db.transaction().execute(transaction => resolveAccount(transaction, { ...identity, emailProven: false }, session))
    if ('needsLink' in result) {
      if (!emailEnabled()) return context.redirect('/?auth=link_unavailable')
      await saveChallenge(context, LINK_COOKIE, { ...emptyChallenge, kind: 'link', email: identity.email,
        google_subject: identity.subject, session_hash: session?.token_hash ?? null })
      return context.redirect('/?auth=link')
    }
    await issueSession(context, result.userId)
    return context.redirect('/?auth=success')
  } catch {
    console.warn(JSON.stringify({ stage: 'auth', event: 'google_callback_failed' }))
    return context.redirect('/?auth=failed')
  }
})

auth.post('/email/request', async context => {
  if (!emailEnabled()) return context.json({ error: 'Email sign-in is unavailable' }, 503)
  const session = await currentSession(context)
  if (session?.email) return context.json({ error: 'You are already signed in' }, 409)
  const body = await readObject(context)
  const link = await loadChallenge(context, LINK_COOKIE, 'link', session)
  if (body?.link === true && !link) return context.json({ error: 'Link request expired. Please start Google sign-in again.' }, 400)
  const email = body?.link === true ? link!.email : normalizeEmail(body?.email)
  if (!email) return context.json({ error: 'Enter a valid email address' }, 400)
  if (!await allowEmail(context, email, 'send')) return context.json({ error: 'Too many requests. Please wait before trying again.' }, 429, { 'Retry-After': '60' })
  try {
    await cleanupAuth()
    const sid = await providers.sendCode(email)
    await saveChallenge(context, EMAIL_COOKIE, { ...emptyChallenge, kind: 'email', email, provider_sid: sid,
      google_subject: body?.link === true ? link!.google_subject : null, session_hash: session?.token_hash ?? null })
    return context.json({ ok: true, retryAfter: 60 })
  } catch {
    console.warn(JSON.stringify({ stage: 'auth', event: 'email_send_failed' }))
    return context.json({ error: 'We could not send your code. Please try again shortly.' }, 503)
  }
})

auth.post('/email/verify', async context => {
  if (!emailEnabled()) return context.json({ error: 'Email sign-in is unavailable' }, 503)
  const session = await currentSession(context)
  if (session?.email) return context.json({ error: 'You are already signed in' }, 409)
  const body = await readObject(context)
  if (typeof body?.code !== 'string' || !/^\d{6}$/.test(body.code)) return context.json({ error: 'Enter the six-digit code' }, 400)
  const challenge = await loadChallenge(context, EMAIL_COOKIE, 'email', session)
  if (!challenge?.email || !challenge.provider_sid) return context.json({ error: 'Code expired. Request a new code.' }, 400)
  if (!await allowEmail(context, challenge.email, 'check')) return context.json({ error: 'Too many attempts. Please try again later.' }, 429)
  const attempt = await db.updateTable('auth_challenges').set(builder => ({ attempts: builder('attempts', '+', 1) }))
    .where('token_hash', '=', challenge.token_hash).where('attempts', '<', 5).where('expires_at', '>', new Date())
    .returning('token_hash').executeTakeFirst()
  if (!attempt) return context.json({ error: 'Too many attempts or code expired. Request a new code.' }, 400)
  try {
    const approved = await providers.checkCode(challenge.provider_sid, body.code, challenge.email)
    if (!approved) return context.json({ error: 'Code is incorrect or expired. Try again or request a new code.' }, 400)
    const result = await db.transaction().execute(async transaction => {
      const consumed = await transaction.deleteFrom('auth_challenges').where('token_hash', '=', challenge.token_hash)
        .where('expires_at', '>', new Date()).returning('token_hash').executeTakeFirst()
      if (!consumed) throw new Error('Challenge already used')
      return resolveAccount(transaction, { email: challenge.email!, subject: challenge.google_subject ?? undefined, emailProven: true }, session)
    })
    if ('needsLink' in result) throw new Error('Email proof required')
    await issueSession(context, result.userId)
    return context.json({ ok: true })
  } catch {
    console.warn(JSON.stringify({ stage: 'auth', event: 'email_verify_failed' }))
    return context.json({ error: 'We could not complete sign-in. Please request a new code.' }, 503)
  }
})

export default auth
