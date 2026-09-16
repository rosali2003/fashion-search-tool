import test from 'node:test'
import assert from 'node:assert/strict'
import { appOrigin, cookieOptions, hashToken, isTrustedMutation, normalizeEmail, randomToken } from './security.js'

test('authentication requires same-origin JSON for cookie-backed mutations', () => {
  const origin = appOrigin()
  const request = (headers: Record<string, string>) => new Request(`${origin}/api/auth/logout`, { method: 'POST', headers })
  assert.equal(isTrustedMutation(request({ origin, 'content-type': 'application/json' })), true)
  assert.equal(isTrustedMutation(request({ origin: 'https://attacker.example', 'content-type': 'application/json' })), false)
  assert.equal(isTrustedMutation(request({ origin, 'content-type': 'text/plain' })), false)
  assert.equal(isTrustedMutation(request({ 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' })), false)
  assert.equal(isTrustedMutation(request({ origin: 'null', 'content-type': 'application/json' })), false)
})

test('email normalization preserves dots and plus aliases and rejects malformed input', () => {
  assert.equal(normalizeEmail(' Person.Name+ink@EXAMPLE.com '), 'person.name+ink@example.com')
  for (const value of [null, {}, '', 'a@@b.com', 'a b@example.com', 'a@example', `${'a'.repeat(250)}@example.com`]) {
    assert.equal(normalizeEmail(value), null)
  }
})

test('session tokens have independent entropy and only hashes are stored', () => {
  const first = randomToken()
  const second = randomToken()
  assert.equal(first.length, 43)
  assert.notEqual(first, second)
  assert.notEqual(hashToken(first), first)
  assert.equal(hashToken(first), hashToken(first))
  assert.equal(cookieOptions(1800).httpOnly, true)
  assert.equal(cookieOptions(1800).sameSite, 'Lax')
  assert.equal(cookieOptions(1800).path, '/')
})
