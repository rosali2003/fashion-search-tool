import 'dotenv/config'
import { promises as fs } from 'fs'
import path from 'path'
import { FileMigrationProvider, Migrator } from 'kysely'
import { db } from './index.js'

const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({
    fs,
    path,
    migrationFolder: new URL('migrations', import.meta.url).pathname,
  }),
})

const { error, results } = await migrator.migrateToLatest()

results?.forEach((r) => {
  if (r.status === 'Success') console.log(`migration "${r.migrationName}" ran`)
  if (r.status === 'Error') console.error(`migration "${r.migrationName}" failed`)
})

if (error) {
  console.error('Migration failed:', error)
  process.exit(1)
}

await db.destroy()
