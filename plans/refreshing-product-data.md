## Fashion sites refresh their inventory every quarter
This means that I will need to scrape sites periodically to accomodate for this. Brands typically drop new inventory 1-2 months before the season starts. I want to automate this process so I don't have to automatically run the scripts

fall drop happens late July, winter drops early November, spring/summer collections are delivered to stores between January and March

Traditional/wholesale fashion runs on two main season (spring/summer and fall/winter) which are roughly 6 month cycles with pre-collections (resort, pre-fall) filling the gaps.
- fast fashion disrupted the model: Zara produces 24 collections/year, H&M 12-16 pushing new drops to stores on a weekly or bi-weekly basis
- Many DTC/online-only brands do continuous "seasonless" micro-drops rather than following the calendar at all

## Implemented (2026-09-12)

Cadence is per brand, not global: `brands.refresh_frequency` (a Postgres interval).
`pnpm refresh` still runs daily from cron but only scrapes brands whose last crawl is
older than their cadence — see `brands` in [SCHEMA.md](../SCHEMA.md). Seeded values:
rihoas 3d · uniqlo, aritzia, skims, reformation 7d · everlane, gap, madewell 14d ·
sezane 30d (disabled, manual only). Tune with `pnpm brands set`.

Not yet done, from the same conversation: cheap change *detection* (Shopify
`/products.json` `created_at`, sitemap diffs, ETag/HEAD polling) that would trigger a
scrape on a detected drop instead of on a timer. The cadence table is the fallback
either way.
