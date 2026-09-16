import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { providers } from './providers.js'

test('Google validates the ID token and Twilio checks the exact verification', async suite => {
  process.env.APP_ORIGIN = 'http://localhost:5173'
  process.env.GOOGLE_CLIENT_ID = 'test-client'
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
  process.env.TWILIO_ACCOUNT_SID = 'test-account'
  process.env.TWILIO_AUTH_TOKEN = 'test-token'
  process.env.TWILIO_VERIFY_SERVICE_SID = 'test-service'
  const originalFetch = globalThis.fetch
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }
  let overrides: Record<string, unknown> = {}
  let tamper = false
  let twilioStatus = 200
  let twilioResult: Record<string, unknown> = { sid: 'VE-test', status: 'pending' }
  const callback = new URL('http://localhost:5173/api/auth/google/callback?state=test-state&code=test-code')
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    assert.ok(init?.signal)
    if (url.includes('/.well-known/openid-configuration')) return Response.json({
      issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token', jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    })
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] })
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body))
      assert.equal(body.get('code_verifier'), 'test-verifier')
      assert.equal(body.get('redirect_uri'), 'http://localhost:5173/api/auth/google/callback')
      const now = Math.floor(Date.now() / 1000)
      const claims = { iss: 'https://accounts.google.com', aud: 'test-client', sub: 'google-subject',
        iat: now, exp: now + 300, nonce: 'test-nonce', email: 'person@example.com', email_verified: true,
        name: 'Test Person', ...overrides }
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
      const payload = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode(claims)}`
      const signature = sign('RSA-SHA256', Buffer.from(payload), privateKey)
      if (tamper) signature[0] ^= 255
      return Response.json({ token_type: 'Bearer', access_token: 'test-access', id_token: `${payload}.${signature.toString('base64url')}` })
    }
    if (url.startsWith('https://verify.twilio.com/v2/Services/test-service/')) {
      assert.equal(init?.method, 'POST')
      const body = new URLSearchParams(String(init?.body))
      if (url.endsWith('/Verifications')) {
        assert.equal(body.get('Channel'), 'email')
        assert.equal(body.get('To'), 'person@example.com')
      } else {
        assert.equal(body.get('VerificationSid'), 'VE-test')
        assert.equal(body.get('Code'), '123456')
      }
      return Response.json(twilioResult, { status: twilioStatus })
    }
    throw new Error('Unexpected network request in provider test')
  }
  try {
    await suite.test('Google authorization uses PKCE, state, nonce, and minimal identity scopes', async () => {
      const url = new URL(await providers.googleStart('test-state', 'test-verifier', 'test-nonce'))
      assert.equal(url.searchParams.get('state'), 'test-state')
      assert.equal(url.searchParams.get('nonce'), 'test-nonce')
      assert.equal(url.searchParams.get('scope'), 'openid email profile')
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
      assert.ok(url.searchParams.get('code_challenge'))
    })
    await suite.test('valid signed Google tokens expose the name and verified identity', async () => {
      assert.deepEqual(await providers.googleFinish(callback, 'test-state', 'test-verifier', 'test-nonce'), {
        subject: 'google-subject', email: 'person@example.com', name: 'Test Person',
      })
    })
    await suite.test('wrong issuer, audience, nonce, expiry, signature, and unverified email are rejected', async () => {
      for (const change of [{ iss: 'https://attacker.example' }, { aud: 'another-client' },
        { nonce: 'wrong-nonce' }, { exp: 1 }, { email_verified: false }]) {
        overrides = change
        await assert.rejects(providers.googleFinish(callback, 'test-state', 'test-verifier', 'test-nonce'))
      }
      overrides = {}
      tamper = true
      await assert.rejects(providers.googleFinish(callback, 'test-state', 'test-verifier', 'test-nonce'))
      tamper = false
      await assert.rejects(providers.googleFinish(callback, 'wrong-state', 'test-verifier', 'test-nonce'))
    })
    await suite.test('Twilio sends email and accepts only the matching approved verification', async () => {
      assert.equal(await providers.sendCode('person@example.com'), 'VE-test')
      assert.equal(await providers.checkCode('VE-test', '123456', 'person@example.com'), false)
      twilioResult = { status: 'approved', sid: 'VE-test', to: 'person@example.com' }
      assert.equal(await providers.checkCode('VE-test', '123456', 'person@example.com'), true)
      twilioResult = { status: 'approved', sid: 'VE-wrong', to: 'person@example.com' }
      assert.equal(await providers.checkCode('VE-test', '123456', 'person@example.com'), false)
      twilioResult = { status: 'approved', sid: 'VE-test', to: 'someone-else@example.com' }
      assert.equal(await providers.checkCode('VE-test', '123456', 'person@example.com'), false)
      twilioStatus = 404
      assert.equal(await providers.checkCode('VE-test', '123456', 'person@example.com'), false)
      twilioStatus = 500
      await assert.rejects(providers.sendCode('person@example.com'))
      await assert.rejects(providers.checkCode('VE-test', '123456', 'person@example.com'))
    })
  } finally { globalThis.fetch = originalFetch }
})
