import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Hono } from 'hono'
import type { Kysely } from 'kysely'

test('authentication and profile integration', { skip: !process.env.AUTH_TEST_DATABASE_URL }, async suite => {
  const connection = new URL(process.env.AUTH_TEST_DATABASE_URL!)
  const schema = `ink_auth_test_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: connection.href })
  await admin.query(`create schema ${schema}`)
  connection.searchParams.set('options', `-csearch_path=${schema},public`)
  process.env.DATABASE_URL = connection.href
  process.env.DATABASE_SSL = 'disable'
  process.env.APP_ORIGIN = 'http://localhost:5173'
  process.env.GOOGLE_CLIENT_ID = 'test-client'
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
  process.env.TWILIO_ACCOUNT_SID = 'test-account'
  process.env.TWILIO_AUTH_TOKEN = 'test-token'
  process.env.TWILIO_VERIFY_SERVICE_SID = 'test-service'
  const { db } = await import('../db/index.js')
  const migrationDb = db as unknown as Kysely<unknown>
  const { sql } = await import('kysely')
  const { providers } = await import('./providers.js')
  const { hashToken, protectMutations } = await import('./security.js')
  const { takeLimit } = await import('./limits.js')
  const migration = await import('../db/migrations/009_auth.js')
  const originals = { ...providers }
  const sent = new Map<string, string>()
  let googleIdentity = { subject: 'google-new', email: 'google@example.com', name: 'Google Person' }
  providers.sendCode = async email => { const sid = randomUUID(); sent.set(sid, email); return sid }
  providers.checkCode = async (sid, code, email) => sent.get(sid) === email && code === '123456'
  providers.googleStart = async state => `https://accounts.google.com/?state=${state}`
  providers.googleFinish = async () => googleIdentity

  try {
    await sql`create table products (id bigserial primary key, brand text, is_active boolean default true, primary_fiber text, silhouette text)`.execute(db)
    await (await import('../db/migrations/003_users.js')).up(migrationDb)
    await (await import('../db/migrations/008_style_cluster.js')).up(migrationDb)
    await migration.up(migrationDb)
    const app = new Hono().basePath('/api')
    app.use('*', protectMutations)
    app.route('/auth', (await import('../routes/auth.js')).default)
    app.route('/users', (await import('../routes/users.js')).default)
    app.route('/search', (await import('../routes/search.js')).default)
    type Jar = Map<string, string>
    const request = async (jar: Jar, path: string, method = 'GET', body?: object, extra: Record<string, string> = {}) => {
      const response = await app.request(`http://localhost:5173/api${path}`, {
        method, headers: { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
          origin: 'http://localhost:5173', 'content-type': 'application/json', ...extra },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      })
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';')
        const split = pair.indexOf('=')
        const key = pair.slice(0, split)
        const value = pair.slice(split + 1)
        if (value) jar.set(key, value)
        else jar.delete(key)
      }
      return response
    }
    const clearLimits = () => db.deleteFrom('auth_limits').execute()
    const emailLogin = async (jar: Jar, email: string) => {
      await clearLimits()
      assert.equal((await request(jar, '/auth/email/request', 'POST', { email })).status, 200)
      assert.equal((await request(jar, '/auth/email/verify', 'POST', { code: '123456' })).status, 200)
      return (await (await request(jar, '/auth/session')).json()).user
    }
    const googleLogin = async (jar: Jar) => {
      const response = await request(jar, '/auth/google')
      const state = new URL(response.headers.get('location')!).searchParams.get('state')!
      return request(jar, `/auth/google/callback?state=${state}&code=code`)
    }
    const guest: Jar = new Map()
    let guestId: string
    let accountToken: string

    await suite.test('guests can browse and save profiles; a UUID alone grants no access', async () => {
      const session = await (await request(guest, '/auth/session')).json()
      assert.equal(session.user, null)
      assert.equal((await request(guest, '/search', 'POST', { query: '', userId: randomUUID() })).status, 200)
      const created = await request(guest, '/users', 'POST', { heightCm: 170, styleCluster: 'minimal' })
      assert.equal(created.status, 201)
      assert.match(created.headers.get('set-cookie')!, /HttpOnly/)
      guestId = (await created.json()).userId
      assert.equal((await request(guest, `/users/${guestId}`)).status, 200)
      assert.equal((await request(new Map(), `/users/${guestId}`)).status, 401)
      assert.equal((await request(new Map(), `/users/${guestId}/preferences`, 'PUT', {})).status, 401)
      assert.equal((await request(new Map(), `/users/${guestId}/comparisons`, 'POST', { winnerId: 1, loserId: 2 })).status, 401)
      assert.equal((await request(new Map(), `/users/${guestId}/pair`, 'POST', { productIds: [1, 2] })).status, 401)
      assert.equal((await request(new Map(), '/users/options')).status, 200)
      await sql`insert into products (brand, primary_fiber, silhouette) values
        ('Example', 'cotton', 'fitted'), ('Another', 'polyester', 'relaxed')`.execute(db)
      assert.equal((await request(guest, `/users/${guestId}/comparisons`, 'POST', { winnerId: 1, loserId: 2 })).status, 200)
    })

    await suite.test('email verification carries the guest profile and rotates its session', async () => {
      const guestToken = guest.get('ink_session')!
      const user = await emailLogin(guest, 'email@example.com')
      assert.equal(user.id, guestId)
      assert.equal(user.authenticated, true)
      accountToken = guest.get('ink_session')!
      assert.notEqual(accountToken, guestToken)
      const old = new Map([['ink_session', guestToken]])
      assert.equal((await (await request(old, '/auth/session')).json()).user, null)
      const profile = await (await request(guest, `/users/${guestId}`)).json()
      assert.equal(profile.body.height_cm, 170)
      assert.equal(profile.comparisonsCount, 1)
      assert.equal((await db.selectFrom('ab_comparisons').select('user_id').where('user_id', '=', guestId).execute()).length, 1)
      assert.equal((await request(guest, '/auth/name', 'PUT', { name: 'Rosali' })).status, 200)
      assert.equal((await (await request(guest, '/auth/session')).json()).user.name, 'Rosali')
      const saved = await request(guest, '/users', 'POST', { heightCm: 172 })
      assert.equal((await saved.json()).userId, guestId)
    })

    await suite.test('a returning account wins over guest preferences and restores the name', async () => {
      const second: Jar = new Map()
      const otherId = (await (await request(second, '/users', 'POST', { heightCm: 190 })).json()).userId
      const user = await emailLogin(second, 'EMAIL@example.com')
      assert.equal(user.id, guestId)
      assert.equal(user.name, 'Rosali')
      assert.equal((await (await request(second, `/users/${guestId}`)).json()).body.height_cm, 172)
      assert.equal((await request(second, `/users/${otherId}`)).status, 401)
      assert.equal((await request(second, '/auth/logout', 'POST')).status, 200)
      assert.equal((await (await request(second, '/auth/session')).json()).user, null)
      assert.equal((await request(second, `/users/${guestId}`)).status, 401)
      assert.equal((await request(guest, `/users/${guestId}`)).status, 200)
    })

    await suite.test('Google creates an account, transfers guest preferences, and resists callback replay', async () => {
      const browser: Jar = new Map()
      const id = (await (await request(browser, '/users', 'POST', { heightCm: 165 })).json()).userId
      const start = await request(browser, '/auth/google')
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!
      const replay = new Map(browser)
      const callback = `/auth/google/callback?state=${state}&code=code`
      assert.equal((await request(browser, callback)).headers.get('location'), '/?auth=success')
      assert.equal((await request(replay, callback)).headers.get('location'), '/?auth=failed')
      const session = await (await request(browser, '/auth/session')).json()
      assert.equal(session.user.id, id)
      assert.equal(session.user.name, 'Google Person')
      const second: Jar = new Map()
      assert.equal((await googleLogin(second)).headers.get('location'), '/?auth=success')
      assert.equal((await (await request(second, '/auth/session')).json()).user.id, id)
      assert.equal((await emailLogin(new Map(), 'google@example.com')).id, id)
    })

    await suite.test('Google requires an email code before linking an existing email account', async () => {
      googleIdentity = { subject: 'google-email-user', email: 'email@example.com', name: 'Changed Name' }
      const browser: Jar = new Map()
      assert.equal((await googleLogin(browser)).headers.get('location'), '/?auth=link')
      assert.equal((await (await request(browser, '/auth/session')).json()).user, null)
      await clearLimits()
      assert.equal((await request(browser, '/auth/email/request', 'POST', { email: 'attacker@example.com', link: true })).status, 200)
      assert.equal([...sent.values()].at(-1), 'email@example.com')
      assert.equal((await request(browser, '/auth/email/verify', 'POST', { code: '123456' })).status, 200)
      assert.equal((await (await request(browser, '/auth/session')).json()).user.id, guestId)
      assert.equal((await (await request(browser, '/auth/session')).json()).user.name, 'Rosali')
      const next: Jar = new Map()
      assert.equal((await googleLogin(next)).headers.get('location'), '/?auth=success')
      assert.equal((await (await request(next, '/auth/session')).json()).user.id, guestId)
    })

    await suite.test('email challenges reject other browsers, expiry, excess attempts, and concurrent replay', async () => {
      await clearLimits()
      const browser: Jar = new Map()
      assert.equal((await request(browser, '/auth/email/request', 'POST', { email: 'limits@example.com' })).status, 200)
      assert.equal((await request(new Map(), '/auth/email/verify', 'POST', { code: '123456' })).status, 400)
      assert.equal((await request(browser, '/auth/email/request', 'POST', { email: 'limits@example.com' })).status, 429)
      for (let attempt = 0; attempt < 5; attempt++) {
        assert.equal((await request(browser, '/auth/email/verify', 'POST', { code: '000000' })).status, 400)
      }
      assert.equal((await request(browser, '/auth/email/verify', 'POST', { code: '123456' })).status, 400)
      await clearLimits()
      await request(browser, '/auth/email/request', 'POST', { email: 'limits@example.com' })
      await db.updateTable('auth_challenges').set({ expires_at: new Date(0) }).where('token_hash', '=', hashToken(browser.get('ink_email')!)).execute()
      assert.equal((await request(browser, '/auth/email/verify', 'POST', { code: '123456' })).status, 400)
      await clearLimits()
      await request(browser, '/auth/email/request', 'POST', { email: 'limits@example.com' })
      const copy = new Map(browser)
      const results = await Promise.all([request(browser, '/auth/email/verify', 'POST', { code: '123456' }), request(copy, '/auth/email/verify', 'POST', { code: '123456' })])
      assert.equal(results.filter(response => response.status === 200).length, 1)
    })

    await suite.test('provider failures and expired OAuth state preserve the current guest profile', async () => {
      const browser: Jar = new Map()
      const id = (await (await request(browser, '/users', 'POST', { heightCm: 180 })).json()).userId
      const sendCode = providers.sendCode
      const googleFinish = providers.googleFinish
      try {
        providers.sendCode = async () => { throw new Error('Simulated delivery failure') }
        await clearLimits()
        assert.equal((await request(browser, '/auth/email/request', 'POST', { email: 'failure@example.com' })).status, 503)
        providers.googleFinish = async () => { throw new Error('Simulated Google failure') }
        assert.equal((await googleLogin(browser)).headers.get('location'), '/?auth=failed')
        assert.equal((await (await request(browser, '/auth/session')).json()).user.id, id)
        const start = await request(browser, '/auth/google')
        const state = new URL(start.headers.get('location')!).searchParams.get('state')!
        await db.updateTable('auth_challenges').set({ expires_at: new Date(0) }).where('token_hash', '=', hashToken(state)).execute()
        assert.equal((await request(browser, `/auth/google/callback?state=${state}&code=code`)).headers.get('location'), '/?auth=failed')
        assert.equal((await (await request(browser, `/users/${id}`)).json()).body.height_cm, 180)
      } finally {
        providers.sendCode = sendCode
        providers.googleFinish = googleFinish
      }
    })

    await suite.test('concurrent Google registrations resolve to one account', async () => {
      googleIdentity = { subject: 'concurrent-google', email: 'concurrent@example.com', name: 'Concurrent Person' }
      const first: Jar = new Map()
      const second: Jar = new Map()
      const responses = await Promise.all([googleLogin(first), googleLogin(second)])
      assert.ok(responses.every(response => response.headers.get('location') === '/?auth=success'))
      const firstUser = (await (await request(first, '/auth/session')).json()).user
      const secondUser = (await (await request(second, '/auth/session')).json()).user
      assert.equal(firstUser.id, secondUser.id)
      const rows = await db.selectFrom('accounts').select('user_id').where('google_subject', '=', 'concurrent-google').execute()
      assert.equal(rows.length, 1)
    })

    await suite.test('cross-site mutations, cancelled OAuth, expired sessions, and missing providers fail safely', async () => {
      assert.equal((await request(guest, '/auth/logout', 'POST', {}, { origin: 'https://attacker.example' })).status, 403)
      assert.equal((await request(guest, '/users', 'POST', {}, { 'content-type': 'text/plain' })).status, 403)
      assert.equal((await request(new Map(), '/auth/google/callback?state=forged&code=forged')).headers.get('location'), '/?auth=failed')
      const browser: Jar = new Map()
      const start = await request(browser, '/auth/google')
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!
      assert.equal((await request(browser, `/auth/google/callback?state=${state}&error=access_denied`)).headers.get('location'), '/?auth=cancelled')
      await db.updateTable('sessions').set({ expires_at: new Date(0) }).where('token_hash', '=', hashToken(accountToken)).execute()
      assert.equal((await (await request(guest, '/auth/session')).json()).user, null)
      assert.equal((await request(guest, `/users/${guestId}`)).status, 401)
      delete process.env.GOOGLE_CLIENT_SECRET
      delete process.env.TWILIO_AUTH_TOKEN
      const session = await (await request(new Map(), '/auth/session')).json()
      assert.equal(session.googleEnabled, false)
      assert.equal(session.emailEnabled, false)
      assert.equal((await request(new Map(), '/auth/email/request', 'POST', { email: 'test@example.com' })).status, 503)
      assert.equal((await request(new Map(), '/search', 'POST', { query: '' })).status, 200)
    })

    await suite.test('rate limits are atomic across concurrent requests and reset after expiry', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, () => takeLimit('concurrent', 3, 60)))
      assert.equal(results.filter(Boolean).length, 3)
      await db.updateTable('auth_limits').set({ expires_at: new Date(0) }).where('key', '=', hashToken('concurrent')).execute()
      assert.equal(await takeLimit('concurrent', 3, 60), true)
    })

    await suite.test('auth migration can roll back and reapply without deleting existing profiles', async () => {
      await migration.down(migrationDb)
      assert.ok(await db.selectFrom('users').select('id').where('id', '=', guestId).executeTakeFirst())
      await migration.up(migrationDb)
    })
  } finally {
    Object.assign(providers, originals)
    await db.destroy()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
