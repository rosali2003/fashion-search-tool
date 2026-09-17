import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { sql } from 'kysely'

import { db } from './db/index.js'
import { rateLimit } from './rateLimit.js'
import auth from './routes/auth.js'
import { appOrigin, protectMutations } from './auth/security.js'

import search from './routes/search.js'
import images from './routes/images.js'
import users from './routes/users.js'
import { describeLlm } from './llm/client.js'

const app = new Hono().basePath('/api')
app.use('*', protectMutations)

// One structured line per request. This is the observability the daily refresh
// and the eval harness both read from, so it stays machine-parseable.
app.use('*', async (c, next) => {
  const started = Date.now()
  await next()
  console.log(
    JSON.stringify({
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - started,
    }),
  )
})

/**
 * A search must never 500 because a downstream dependency is slow. The per-stage
 * fallbacks live in the search pipeline; this is the last resort for anything
 * unanticipated, so the client always receives JSON rather than an HTML error page.
 */
app.onError((err, c) => {
  console.error(JSON.stringify({ level: 'error', path: c.req.path, message: err.message, stack: err.stack }))
  return c.json({ error: 'Internal error' }, 500)
})

/**
 * The platform healthcheck gates whether a new deployment receives traffic, so
 * it has to fail when the app cannot actually serve a search — and every search
 * is a database query. Returning `{ok:true}` unconditionally let a deploy go
 * green with Postgres unreachable, which is the failure this is here to catch.
 *
 * Bounded by connectionTimeoutMillis in db/index.ts; without that this handler
 * would hang rather than answer.
 */
app.get('/health', async (c) => {
  try {
    await sql`select 1`.execute(db)
    return c.json({ ok: true, db: 'up' })
  } catch (err) {
    return c.json({ ok: false, db: 'down', error: (err as Error).message }, 503)
  }
})

// Only the LLM-spending route is limited. /health must stay unthrottled so a
// platform healthcheck is never mistaken for abuse, and /images is static bytes.
//
// One registration, not two: Hono's `/search/*` already matches the bare
// `/search` the client posts to, so adding an exact-path `app.use('/search')`
// alongside it runs the middleware twice per request and silently halves the
// effective limit.
app.use('/search/*', rateLimit)

app.route('/search', search)
app.route('/images', images)
app.route('/users', users)
app.route('/auth', auth)

const port = Number(process.env.PORT ?? 3000)
appOrigin()
serve({ fetch: app.fetch, port })
console.log(`Backend running on http://localhost:${port}`)
// Which model is live should never be a mystery when reading logs.
console.log(describeLlm())
