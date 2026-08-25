// Env is loaded here, not just in the server entry point, because the ingest,
// vision and eval CLIs all import `db` directly — without it DATABASE_URL would
// be undefined for them and the pool would silently fall back to libpq defaults.
//
// The path is resolved from this file rather than left to dotenv's default,
// which reads ./.env relative to the process CWD. `pnpm --filter backend <cmd>`
// runs with CWD=backend/, so the default would miss the repo-root .env.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import dotenv from 'dotenv'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
dotenv.config({ path: path.join(REPO_ROOT, '.env') })

import pg from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { Database } from './types.js'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.')
}

/**
 * pg returns NUMERIC as a string to avoid precision loss. That's the right
 * default for money, but natural_ratio and the ELO scores are small floats we
 * compare arithmetically, so they're parsed at the boundary instead of scattering
 * Number() calls through the ranking code. price_cents is an integer column and
 * is unaffected.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)))
// int8 (bigserial ids) also arrives as a string; these are row counts and ids
// far below 2^53, so narrowing to number is safe and keeps the types simple.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)))

/**
 * TLS is opt-in rather than inferred.
 *
 * Railway's private network is not TLS-terminated and the ParadeDB container
 * serves plaintext, so defaulting to `require` would break the ordinary
 * deployment. Providers that do need TLS set DATABASE_SSL explicitly.
 *
 *   unset / 'disable'  no TLS — local docker-compose, Railway private network
 *   'require'          TLS, certificate not verified. The usual hosted case,
 *                      where the CA is the provider's own and unpinned.
 *   'verify-full'      TLS with full chain verification
 */
const sslMode = process.env.DATABASE_SSL ?? 'disable'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'disable' ? undefined : { rejectUnauthorized: sslMode === 'verify-full' },
  // The daily refresh runs ingest and vision extraction concurrently against
  // the same pool; the default of 10 is enough but being explicit documents it.
  max: 10,
  idleTimeoutMillis: 30_000,
  // Without a bound here an unreachable database makes /api/health hang until
  // the OS TCP timeout, so the platform records a healthcheck *timeout* instead
  // of the 503 the handler is written to return.
  connectionTimeoutMillis: 10_000,
})

/**
 * Idle-client errors must be handled or they are fatal.
 *
 * `pg.Pool` emits 'error' when a connection sitting idle in the pool drops —
 * Postgres restarting, a network blip, a provider's maintenance window. That is
 * an EventEmitter 'error' with no listener, so Node terminates the process.
 *
 * Measured, not theorised: stopping the local ParadeDB container while the
 * server was idle killed it outright, and /api/health could not answer 503
 * because there was nothing left running to answer. In a deployment this is a
 * crash loop every time the database restarts, which on Railway is every
 * redeploy of the database service.
 *
 * Logging and swallowing is correct here. The client is already gone and pg has
 * discarded it; the next checkout opens a fresh connection, and if the database
 * really is down that attempt fails at the request, where the error belongs.
 */
pool.on('error', (err) => {
  console.error(
    JSON.stringify({ level: 'error', stage: 'pg_pool', message: err.message }),
  )
})

export const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
