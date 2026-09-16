/**
 * Brand registry CLI.
 *
 *   pnpm brands list                       every brand, cadence, last crawl, next due
 *   pnpm brands due                        slugs due for a scrape, one per line
 *   pnpm brands set <slug> '<interval>'    change a cadence: '3 days', '2 weeks', '1 month'
 *   pnpm brands enable <slug> | disable <slug>
 *
 * `due` prints nothing but slugs on stdout so scripts/refresh.ts can feed them
 * straight to the scrapers. Everything human-facing goes to stderr.
 */
import { sql } from 'kysely'
import { db } from '../db/index.js'

/**
 * A brand counts as due this many hours before its cadence strictly elapses.
 *
 * The cron fires once a day at a randomised minute. Without slack, a brand
 * scraped at 03:14 with a 7-day cadence is not yet due when the cron runs at
 * 03:05 seven days later, gets picked up the day after, and every cycle drifts
 * one day later than intended. Half a day of slack absorbs that.
 */
const DUE_SLACK = '12 hours'

const dueCondition = sql<boolean>`
  enabled and (last_scraped_at is null or last_scraped_at + refresh_frequency <= now() + ${DUE_SLACK}::interval)
`

async function list(): Promise<void> {
  const rows = await db
    .selectFrom('brands')
    .select([
      'slug',
      'refresh_frequency',
      'last_scraped_at',
      'enabled',
      sql<string | null>`(last_scraped_at + refresh_frequency)::text`.as('next_due'),
      dueCondition.as('due'),
      'notes',
    ])
    .orderBy('slug')
    .execute()

  const fmt = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—')
  console.error(
    `${'brand'.padEnd(12)} ${'every'.padEnd(10)} ${'last scraped'.padEnd(17)} ${'next due'.padEnd(17)} state`,
  )
  for (const r of rows) {
    const state = !r.enabled ? 'disabled' : r.due ? 'DUE' : 'ok'
    console.error(
      `${r.slug.padEnd(12)} ${r.refresh_frequency.padEnd(10)} ${fmt(r.last_scraped_at).padEnd(17)} ${fmt(r.next_due).padEnd(17)} ${state.padEnd(8)}` +
        (r.notes ? `  ${r.notes}` : ''),
    )
  }
}

async function due(): Promise<void> {
  const rows = await db.selectFrom('brands').select('slug').where(dueCondition).orderBy('slug').execute()
  for (const r of rows) console.log(r.slug)
}

async function set(slug: string | undefined, interval: string | undefined): Promise<void> {
  if (!slug || !interval) throw new Error("usage: brands set <slug> '<interval>'")
  const res = await db
    .updateTable('brands')
    .set({ refresh_frequency: interval })
    .where('slug', '=', slug)
    .executeTakeFirst()
  if (Number(res.numUpdatedRows) === 0) throw new Error(`no brand '${slug}'`)
  console.error(`${slug}: refresh_frequency = ${interval}`)
}

async function toggle(slug: string | undefined, enabled: boolean): Promise<void> {
  if (!slug) throw new Error(`usage: brands ${enabled ? 'enable' : 'disable'} <slug>`)
  const res = await db.updateTable('brands').set({ enabled }).where('slug', '=', slug).executeTakeFirst()
  if (Number(res.numUpdatedRows) === 0) throw new Error(`no brand '${slug}'`)
  console.error(`${slug}: ${enabled ? 'enabled' : 'disabled'}`)
}

const [cmd, ...rest] = process.argv.slice(2)
try {
  if (cmd === 'list') await list()
  else if (cmd === 'due') await due()
  else if (cmd === 'set') await set(rest[0], rest[1])
  else if (cmd === 'enable') await toggle(rest[0], true)
  else if (cmd === 'disable') await toggle(rest[0], false)
  else {
    console.error('usage: brands list | due | set <slug> <interval> | enable <slug> | disable <slug>')
    process.exitCode = 1
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await db.destroy()
}
