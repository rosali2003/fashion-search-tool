import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('accounts')
    .addColumn('user_id', 'uuid', column => column.primaryKey().references('users.id').onDelete('cascade'))
    .addColumn('email', 'text', column => column.notNull().unique())
    .addColumn('google_subject', 'text', column => column.unique())
    .execute()
  await db.schema.createTable('sessions')
    .addColumn('token_hash', 'text', column => column.primaryKey())
    .addColumn('user_id', 'uuid', column => column.notNull().references('users.id').onDelete('cascade'))
    .addColumn('expires_at', 'timestamptz', column => column.notNull())
    .execute()
  await db.schema.createIndex('sessions_user_idx').on('sessions').column('user_id').execute()
  await db.schema.createTable('auth_challenges')
    .addColumn('token_hash', 'text', column => column.primaryKey())
    .addColumn('kind', 'text', column => column.notNull())
    .addColumn('session_hash', 'text')
    .addColumn('email', 'text')
    .addColumn('google_subject', 'text')
    .addColumn('verifier', 'text')
    .addColumn('nonce', 'text')
    .addColumn('provider_sid', 'text')
    .addColumn('attempts', 'integer', column => column.notNull().defaultTo(0))
    .addColumn('expires_at', 'timestamptz', column => column.notNull())
    .execute()
  await db.schema.createTable('auth_limits')
    .addColumn('key', 'text', column => column.primaryKey())
    .addColumn('hits', 'integer', column => column.notNull())
    .addColumn('expires_at', 'timestamptz', column => column.notNull())
    .execute()
  for (const table of ['sessions', 'auth_challenges', 'auth_limits']) {
    await db.schema.createIndex(`${table}_expiry_idx`).on(table).column('expires_at').execute()
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['auth_limits', 'auth_challenges', 'sessions', 'accounts']) {
    await db.schema.dropTable(table).execute()
  }
}
