import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

import search from './routes/search.js'
import images from './routes/images.js'
import users from './routes/users.js'
import { describeLlm } from './llm/client.js'

const app = new Hono().basePath('/api')

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

app.get('/health', (c) => c.json({ ok: true }))

app.route('/search', search)
app.route('/images', images)
app.route('/users', users)

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port })
console.log(`Backend running on http://localhost:${port}`)
// Which model is live should never be a mystery when reading logs.
console.log(describeLlm())
