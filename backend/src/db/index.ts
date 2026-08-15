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

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // The daily refresh runs ingest and vision extraction concurrently against
  // the same pool; the default of 10 is enough but being explicit documents it.
  max: 10,
  idleTimeoutMillis: 30_000,
})

export const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
