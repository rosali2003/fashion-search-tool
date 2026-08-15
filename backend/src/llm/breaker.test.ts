import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { classify, isOpen, openReason, recordFailure, recordSuccess, resetCircuits } from './breaker.js'

beforeEach(resetCircuits)

const err = (message: string, status?: number) =>
  Object.assign(new Error(message), status === undefined ? {} : { status })

test('billing and quota exhaustion is terminal, plain rate limiting is not', () => {
  // The distinction that motivated this file: an unpaid account never recovers
  // by retrying, a rate limit does.
  assert.equal(
    classify(err('429 You have no credits remaining. Add credits to continue using the API.', 429)),
    'terminal',
  )
  assert.equal(classify(err('429 insufficient_quota', 429)), 'terminal')
  assert.equal(classify(err('429 Rate limit reached, please slow down', 429)), 'transient')
})

test('auth failures are terminal', () => {
  assert.equal(classify(err('401 Incorrect API key provided', 401)), 'terminal')
  assert.equal(classify(err('403 Forbidden', 403)), 'terminal')
  assert.equal(classify(err('invalid_api_key')), 'terminal')
})

test('timeouts and server errors are transient', () => {
  assert.equal(classify(err('timed out after 1500ms')), 'transient')
  assert.equal(classify(err('500 Internal Server Error', 500)), 'transient')
  assert.equal(classify(err('529 Overloaded', 529)), 'transient')
})

test('a terminal failure trips the circuit on the first occurrence', () => {
  assert.equal(isOpen('rerank'), false)
  recordFailure('rerank', err('429 You have no credits remaining.', 429))
  assert.equal(isOpen('rerank'), true, 'no point retrying an unpaid account')
  assert.match(openReason('rerank'), /terminal/)
})

test('a single transient failure does not disable the feature', () => {
  recordFailure('expansion', err('timed out after 1500ms'))
  assert.equal(isOpen('expansion'), false, 'one slow call is not an outage')
  recordFailure('expansion', err('timed out after 1500ms'))
  assert.equal(isOpen('expansion'), false)
  recordFailure('expansion', err('timed out after 1500ms'))
  assert.equal(isOpen('expansion'), true, 'three in a row is')
})

test('a success resets the transient count', () => {
  recordFailure('expansion', err('timeout'))
  recordFailure('expansion', err('timeout'))
  recordSuccess('expansion')
  recordFailure('expansion', err('timeout'))
  recordFailure('expansion', err('timeout'))
  assert.equal(isOpen('expansion'), false, 'the counter restarted after the success')
})

test('circuits are independent per stage', () => {
  // Reranking failing must not disable expansion — they have different
  // token budgets and can fail independently.
  recordFailure('rerank', err('429 no credits', 429))
  assert.equal(isOpen('rerank'), true)
  assert.equal(isOpen('expansion'), false)
})

test('the circuit half-opens after its cooldown', async () => {
  recordFailure('expansion', err('timeout'))
  recordFailure('expansion', err('timeout'))
  recordFailure('expansion', err('timeout'))
  assert.equal(isOpen('expansion'), true)

  // Transient cooldown is 30s; rather than wait, verify the mechanism by
  // checking that isOpen() re-closes once the deadline passes.
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 31_000
    assert.equal(isOpen('expansion'), false, 'cooldown elapsed, let one call through')
  } finally {
    Date.now = realNow
  }
})

test('openReason names the cause so the degradation detail is actionable', () => {
  recordFailure('rerank', err('429 You have no credits remaining.', 429))
  const reason = openReason('rerank')
  assert.match(reason, /no credits/, 'the operator needs to know it is billing, not a bug')
  assert.match(reason, /retrying in \d+s/)
})

test('an unknown circuit is closed', () => {
  assert.equal(isOpen('never-seen'), false)
  assert.equal(openReason('never-seen'), 'circuit open')
})
