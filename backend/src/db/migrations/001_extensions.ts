import { sql, type Kysely } from 'kysely'

/**
 * pg_search provides real BM25 ranking (Tantivy) inside Postgres.
 *
 * Verified against the pinned image paradedb/paradedb:0.23.1-pg17. The DDL and
 * query surface differ between pg_search releases — see 004_products_bm25.ts for
 * the version-specific notes before bumping the image tag.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_search`.execute(db)
  // gen_random_uuid() for the users table.
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Deliberately not dropping pg_search: other objects depend on it, and
  // dropping an extension that a BM25 index still references fails anyway.
  await sql`DROP EXTENSION IF EXISTS pgcrypto`.execute(db)
}
