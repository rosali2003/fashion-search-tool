import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../src/ingest/load.js'
import type { GoldenCase } from './metrics.js'

/**
 * Loading the golden set lives here rather than in run.ts because run.ts is a
 * CLI with a top-level `await main()` and a `db.destroy()` in its finally block.
 * Importing it as a library ran the entire eval and tore down the connection pool
 * before the caller had issued a single query.
 */
export const GOLDEN_FILE = path.join(REPO_ROOT, 'backend/evals/golden/queries.json')

export function loadGolden(): GoldenCase[] {
  return JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as GoldenCase[]
}
