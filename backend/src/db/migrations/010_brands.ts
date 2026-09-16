import { sql, type Kysely } from 'kysely'

/**
 * The brand registry, and with it a per-brand scrape cadence.
 *
 * Until now every brand was scraped on the same nightly cron. That was the wrong
 * shape: fashion does not refresh on one calendar. Legacy wholesale brands run
 * two six-month seasons with pre-collections in the gaps; fast fashion pushes
 * new drops weekly or faster; DTC labels do continuous "seasonless" micro-drops.
 * A daily crawl of a brand that changes quarterly is wasted requests against
 * sites that already block scrapers (Aritzia), while a quarterly crawl of a
 * weekly-drop brand misses almost everything.
 *
 * `refresh_frequency` is a Postgres interval rather than an enum or a day count
 * so that "is this brand due?" is one expression —
 * `last_scraped_at + refresh_frequency <= now()` — and so a cadence reads in the
 * table the way it is said aloud: '7 days', '2 weeks', '1 mon'.
 *
 * `last_scraped_at` is written by ingest from the crawl's own timestamp, not the
 * ingest clock, for the same reason `products.last_seen_at` is: re-ingesting an
 * old run directory must not make a brand look freshly crawled.
 *
 * The seeded frequencies are starting points, not measurements. Tune them with
 * `pnpm brands set <slug> '<interval>'` once each site's real drop pattern is
 * observed in ingest_runs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('brands')
    // Matches products.brand, which is lowercased on write.
    .addColumn('slug', 'text', (c) => c.primaryKey())
    .addColumn('display_name', 'text', (c) => c.notNull())
    .addColumn('site_url', 'text')
    .addColumn('refresh_frequency', sql`interval`, (c) => c.notNull())
    .addColumn('last_scraped_at', 'timestamptz')
    // Off means the cron never scrapes it. Sézane attaches to a Chrome the user
    // launched by hand and cannot run unattended.
    .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('notes', 'text')
    .addCheckConstraint('brands_refresh_frequency_positive', sql`refresh_frequency > interval '0'`)
    .execute()

  await db
    .insertInto('brands' as never)
    .values([
      row('rihoas', 'RIHOAS', 'https://www.rihoas.com', '3 days', 'Fast fashion: near-daily drops.'),
      row('uniqlo', 'Uniqlo', 'https://www.uniqlo.com', '7 days', null),
      row('aritzia', 'Aritzia', 'https://www.aritzia.com', '7 days', 'Sticky-blocks scrapers; keep the cadence gentle.'),
      row('skims', 'SKIMS', 'https://skims.com', '7 days', 'Drop-driven.'),
      row('reformation', 'Reformation', 'https://www.thereformation.com', '7 days', 'Weekly new arrivals.'),
      row('everlane', 'Everlane', 'https://www.everlane.com', '14 days', 'Shopify /products.json — cheap to crawl.'),
      row('gap', 'Gap', 'https://www.gap.com', '14 days', null),
      row('madewell', 'Madewell', 'https://www.madewell.com', '14 days', null),
      {
        ...row('sezane', 'Sézane', 'https://www.sezane.com', '30 days', 'Manual only: attaches to a hand-launched Chrome. Run `pnpm scrape:sezane`.'),
        enabled: false,
      },
    ] as never)
    .execute()

  // Any brand already in the catalog but missing from the seed list gets a row
  // too, so the foreign key below can be added on a database whose scraper set
  // has drifted from this file.
  await sql`
    insert into brands (slug, display_name, refresh_frequency)
    select distinct brand, initcap(brand), interval '7 days'
    from products
    on conflict (slug) do nothing
  `.execute(db)

  // Backfill from the catalog so the first run after this migration only
  // scrapes brands that are genuinely due, rather than everything at once.
  await sql`
    update brands b
    set last_scraped_at = p.last
    from (select brand, max(scraped_at) as last from products group by brand) p
    where p.brand = b.slug
  `.execute(db)

  await db.schema
    .alterTable('products')
    .addForeignKeyConstraint('products_brand_fk', ['brand'], 'brands', ['slug'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('products').dropConstraint('products_brand_fk').execute()
  await db.schema.dropTable('brands').execute()
}

function row(slug: string, display_name: string, site_url: string, refresh_frequency: string, notes: string | null) {
  return { slug, display_name, site_url, refresh_frequency, notes }
}
