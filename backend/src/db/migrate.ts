import 'dotenv/config'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'node:url'
import { FileMigrationProvider, Migrator } from 'kysely'
import { db } from './index.js'

const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({
    fs,
    path,
    // fileURLToPath, not `.pathname`: the latter stays percent-ENCODED, so
    // fs.readdir fails the moment the checkout lives under a directory with a
    // space in its name.
    //
    // The folder resolves relative to this module, so it is src/db/migrations
    // under tsx and dist/db/migrations under plain node. That is safe because
    // FileMigrationProvider keys each migration on the filename minus its final
    // extension — `001_extensions.ts` and `001_extensions.js` both record
    // `001_extensions`, so dev and production share one migration history
    // rather than forking into two.
    migrationFolder: fileURLToPath(new URL('migrations', import.meta.url)),
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
