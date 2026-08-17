# Database schema

Postgres 17.9 via `paradedb/paradedb:0.23.1-pg17` (see [docker-compose.yml](./docker-compose.yml)).
Six application tables, all in `public`. Kysely type definitions live in
[`backend/src/db/types.ts`](./backend/src/db/types.ts) and are the compile-time
mirror of what is documented here.

```
postgres://postgres:postgres@localhost:5433/ink
```

Regenerate any section below with `docker exec ink-postgres psql -U postgres -d ink -c "\d <table>"`.

---

## Contents

- [Entity relationships](#entity-relationships)
- [Extensions](#extensions)
- [`products`](#products) — the catalog
- [`users`](#users) / [`user_preferences`](#user_preferences) / [`ab_comparisons`](#ab_comparisons) — the shopper
- [`ingest_runs`](#ingest_runs) / [`expansion_cache`](#expansion_cache) — operational
- [The BM25 index](#the-bm25-index)
- [Migrations](#migrations)

---

## Entity relationships

```mermaid
erDiagram
    users ||--o| user_preferences : "1:1, cascade"
    users ||--o{ ab_comparisons : "logs"
    products ||--o{ ab_comparisons : "winner"
    products ||--o{ ab_comparisons : "loser"

    users {
        uuid id PK
        text display_name
    }
    user_preferences {
        uuid user_id PK,FK
        jsonb brand_scores "ELO projection"
        jsonb material_pref
        jsonb silhouette_pref
        text_array excluded_brands "only hard filter"
    }
    ab_comparisons {
        bigint id PK
        uuid user_id FK
        bigint winner_product_id FK
        bigint loser_product_id FK
        text source "ab | find_similar"
    }
    products {
        bigint id PK
        text product_url UK "natural key"
        text content_hash "skip-unchanged"
        text search_title "BM25 tier 1"
        text search_attrs "BM25 tier 2"
    }
    ingest_runs {
        bigint id PK
        text run_dir
        text brand
    }
    expansion_cache {
        text query_hash PK
    }
```

`ingest_runs` and `expansion_cache` are deliberately unrelated to everything else —
they are operational logs, not domain data, and nothing joins against them.

**`user_preferences` is a derived projection.** The authoritative record of taste is
the append-only `ab_comparisons` log; the three jsonb score maps are what you get by
replaying it. That split exists so a badly chosen `K_FACTOR` can be re-simulated from
history rather than re-gathered from users.

---

## Extensions

Created by [migration 001](./backend/src/db/migrations/001_extensions.ts):

| Extension | Version | Why |
|---|---|---|
| `pg_search` | 0.23.1 | BM25 ranking via Tantivy. The whole retrieval story. |
| `pgcrypto` | 1.3 | `gen_random_uuid()` for `users.id`. |

The ParadeDB image also ships `postgis`, `vector`, `pg_ivm`, `fuzzystrmatch`,
`pg_stat_statements` and the tiger geocoder preinstalled. **None of them are used.**
In particular `vector` is present but unreferenced — retrieval here is lexical end to
end, with no embeddings and no vector index anywhere.

---

## `products`

The catalog. 77 columns, which is a lot, but they fall into eight blocks with
different owners and different lifecycles. Knowing which block a column belongs to
tells you what is allowed to write it.

**Key:** `product_url` (unique). It is the only stable natural key the scrapers emit —
there is no id or SKU field, and 13 `(brand, name)` pairs collide in the corpus.

### Identity and liveness

*Owner: ingest.*

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `bigint` | no | identity | PK |
| `product_url` | `text` | no | — | **unique**; the upsert conflict target |
| `brand` | `text` | no | — | lowercased on write |
| `vendor_sku` | `text` | yes | — | **not** unique — see below |
| `content_hash` | `text` | no | — | sha256 of raw scraper fields only |
| `source_run` | `text` | no | — | run directory that last touched the row |
| `scraped_at` | `timestamptz` | yes | — | from the record, not the ingest clock |
| `first_seen_at` | `timestamptz` | no | `now()` | preserved across updates so "new arrival" stays meaningful |
| `last_seen_at` | `timestamptz` | no | `now()` | set to the **crawl's** timestamp, never the ingest's |
| `is_active` | `boolean` | no | `true` | soft delete; rows are never `DELETE`d |

`content_hash` covers raw scraper fields *only*, never derived values — otherwise a
normaliser change would alter the hash and be indistinguishable from the brand editing
its own copy. A row whose hash and `attributes_version` both match is skipped outright,
which is the mechanism that makes a daily refresh nearly free.

`vendor_sku` carried a unique index on `(brand, vendor_sku)` until migration 005 removed
it. Gap's "Product #544347" is a *style* number shared across colourways, not a product
identifier — 50 Gap products carry only 45 distinct numbers — so the unique index was
rejecting legitimate rows. It is now a plain partial index, useful for grouping
colourways of one style.

Deactivation is guarded twice: a run that returns less than 50% of a brand's active set
skips deactivation entirely (suspected partial scrape), and surviving rows are only
deactivated after `INK_STALE_AFTER_DAYS` (default 7) of going unseen. Each crawl is a
sample, not a census.

### Raw source

*Owner: ingest. Never read by search.*

| Column | Type | Null | Notes |
|---|---|---|---|
| `raw_name` | `text` | no | as scraped |
| `raw_description` | `text` | yes | as scraped |
| `raw_material` | `text` | yes | as scraped |
| `price_cents` | `integer` | yes | indexed as a fast field in BM25 |
| `image_urls` | `text[]` | no | original CDN URLs; kept for provenance |
| `image_hashes` | `text[]` | no | sha256 keys into `output/images/` |

`image_hashes` rather than paths is not a stylistic choice: the scraped JSON stores
absolute host paths that break for anyone who clones the repo. Only hashes are
persisted.

### Cleaned text and fibre

*Owner: ingest (deterministic parse).*

| Column | Type | Null | Notes |
|---|---|---|---|
| `name` | `text` | no | variant split off |
| `name_variant` | `text` | yes | e.g. colourway |
| `description_clean` | `text` | yes | boilerplate stripped |
| `material_clean` | `text` | yes | normalised composition string |
| `fibers` | `jsonb` | no `'[]'` | `{fiber, pct, component, recycled?, organic?}[]` |
| `fiber_names` | `text[]` | no `'{}'` | flattened for filtering |
| `natural_ratio` | `numeric` | yes | main-component fibres only |
| `primary_fiber` | `text` | yes | highest-percentage main fibre |
| `fibers_incomplete` | `boolean` | no `false` | percentages don't sum to 100 |
| `fabric` | `text[]` | no `'{}'` | e.g. `denim`, `jersey` |

Only `component = 'main'` feeds `natural_ratio` — lining and cup fibres are recorded
but excluded, or a cotton dress with a polyester lining would score as half synthetic.

### Facets — text-derived

*Owner: ingest rules first, then the LLM text pass for whatever is still null.*

| Column | Type | Null |
|---|---|---|
| `category`, `subcategory`, `silhouette`, `neckline` | `text` | yes |
| `sleeve_length`, `length`, `rise`, `fit`, `pattern` | `text` | yes |
| `colors`, `details`, `occasion`, `season` | `text[]` | no `'{}'` |

The enrichment pass **never overwrites a value the deterministic rules produced**. The
rules read explicit statements ("Mini Dress", "High Rise") and are more reliable than
inference from marketing prose.

### Sizing

| Column | Type | Null |
|---|---|---|
| `size_range` | `text[]` | no `'{}'` |
| `model_height_cm` | `integer` | yes |
| `model_size` | `text` | yes |
| `fit_notes` | `text` | yes |

### Extraction provenance — text

*Owner: enrich. **Ingest must never write these.***

| Column | Type | Default | Notes |
|---|---|---|---|
| `attributes_source` | `text` | — | `'llm'` once the text pass has run |
| `attributes_model` | `text` | — | which model produced it |
| `attributes_version` | `integer` | `0` | **normaliser** version, owned by ingest |
| `attributes_at` | `timestamptz` | — | |

`attributes_version` is the trap in this block. It shares a prefix with the other three
but not an owner: it marks the *normaliser* version and drives the skip-unchanged check.
An earlier `attributes_*` prefix rule swept it into the enrichment-owned set, so it never
advanced, every row looked stale, and ingest stopped skipping anything.

### Facets — vision-derived

*Owner: enrich vision pass.*

| Column | Type | Notes |
|---|---|---|
| `v_category`, `v_silhouette`, `v_neckline`, `v_sleeve_length`, `v_length`, `v_pattern`, `v_rise` | `text` | mirrors of the text facets |
| `v_colors`, `v_details`, `v_finish_cues` | `text[]` | |
| `v_waist_position`, `v_hem_break`, `v_shoulder_treatment`, `v_neckline_width` | `text` | geometry with no text equivalent |
| `v_volume`, `v_vertical_line`, `v_waist_definition`, `v_drape`, `v_structure` | `text` | geometry with no text equivalent |
| `v_confidence` | `numeric` | |
| `image_set_hash` | `text` | *ingest-owned*: hash of the current image set |
| `vision_image_set_hash` | `text` | *enrich-owned*: the set it actually extracted from |
| `vision_version` | `integer` | prompt version, default `0` |
| `vision_model` | `text` | indexed |
| `vision_at` | `timestamptz` | |
| `attribute_conflicts` | `jsonb` | `{field, text_value, vision_value}[]` |

The two hash columns are a cache, and the reason they are separate: re-extraction is
triggered by `vision_image_set_hash IS DISTINCT FROM image_set_hash`. That predicate is
what turns a daily vision pass from hundreds of thousands of calls a year into a one-time
backfill plus new arrivals.

Text and vision facets are stored in **separate columns and never merged in place**.
Resolution decides what goes into the search fields and what the API returns, but it must
not destroy either input — writing resolved values back once let vision's "collared"
overwrite the name-derived "turtleneck", and corpus recall@120 fell from 0.957 to 0.904.
`attribute_conflicts` records the disagreements that survive.

### Search tiers

*Owner: `renderSearchFields`, rewritten after every extraction.*

| Column | Type | Contents |
|---|---|---|
| `search_title` | `text` | name + variant |
| `search_attrs` | `text` | controlled vocabulary + synonym expansion |
| `search_material` | `text` | composition and fabric terms |
| `search_body` | `text` | marketing prose, truncated |

Four fields rather than one because BM25's `b` (document-length normalisation) is
hardcoded in Tantivy and cannot be tuned. Field decomposition is the substitute: signal
goes in short, length-uniform fields and prose is capped and down-weighted. Query-time
boosts are `title 4.0 · attrs 2.5 · material 1.0 · body 1.0` — see
[`search/config.ts`](./backend/src/search/config.ts).

### Indexes

| Index | Definition |
|---|---|
| `products_pkey` | `btree (id)` |
| `products_product_url_key` | **unique** `btree (product_url)` |
| `products_bm25` | `bm25 (…)` — [detailed below](#the-bm25-index) |
| `products_brand_idx` | `btree (brand)` |
| `products_active_idx` | `btree (is_active)` |
| `products_brand_sku_idx` | `btree (brand, vendor_sku) WHERE vendor_sku IS NOT NULL` |
| `products_vision_model_idx` | `btree (vision_model)` |

---

## `users`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` |
| `display_name` | `text` | yes | — |
| `created_at` | `timestamptz` | no | `now()` |

No auth, no email, no password. The id is handed to the browser and kept in
`localStorage`; possession of the uuid is the entire identity model.

---

## `user_preferences`

One row per user, `user_id` as both PK and FK (`ON DELETE CASCADE`).

| Column | Type | Null | Default | Source |
|---|---|---|---|---|
| `user_id` | `uuid` | no | — | PK / FK → `users.id` |
| `height_cm` | `integer` | yes | — | questionnaire |
| `body_type`, `shoulders`, `torso`, `waist` | `text` | yes | — | questionnaire |
| `fiber_preference` | `numeric` | yes | — | questionnaire, 0..1 |
| `quality_tier` | `text` | yes | — | questionnaire |
| `style_cluster` | `text` | yes | — | questionnaire Q5 |
| `price_min_cents`, `price_max_cents` | `integer` | yes | — | questionnaire Q3 |
| `excluded_brands` | `text[]` | no | `'{}'` | questionnaire |
| `brand_scores` | `jsonb` | no | `'{}'` | ELO projection |
| `material_pref` | `jsonb` | no | `'{}'` | ELO projection |
| `silhouette_pref` | `jsonb` | no | `'{}'` | ELO projection |
| `comparisons_count` | `integer` | no | `0` | |
| `onboarded_at` | `timestamptz` | yes | — | |
| `updated_at` | `timestamptz` | no | `now()` | |

**`excluded_brands` is the only hard filter in the system.** It is applied as a
`must_not` clause inside the BM25 query, which is why preferences load before retrieval
rather than after it. Everything else — fibre, price, silhouette, aesthetic — is a soft
boost in the affinity blend, because natural-fibre content correlates violently with
brand in this catalog and filtering on it would silently delete a third of the corpus.

`style_cluster` is a single text value while its two neighbours are jsonb weight maps.
The asymmetry is deliberate ([migration 008](./backend/src/db/migrations/008_style_cluster.ts)):
the other dimensions are learnable one key at a time from comparisons, but a comparison
says nothing legible about whether a shopper is "minimal" or "eclectic". It is stored as
a declared answer, not an inferred one.

---

## `ab_comparisons`

Append-only. Never updated, never deleted.

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `bigint` | no | identity |
| `user_id` | `uuid` | no | FK → `users.id` `ON DELETE CASCADE` |
| `winner_product_id` | `bigint` | no | FK → `products.id` |
| `loser_product_id` | `bigint` | no | FK → `products.id` |
| `source` | `text` | no | `'ab'` — or `'find_similar'` |
| `created_at` | `timestamptz` | no | `now()` |

Index: `ab_comparisons_user_idx btree (user_id, created_at)`.

Both product FKs are unqualified — no cascade — so a product cannot be hard-deleted
while any comparison references it. That is a second, structural reason products are
soft-deleted via `is_active`.

`source` distinguishes an explicit A/B answer from a "find similar" click, which the
product plan treats as an implicit positive carrying the same ELO step.

---

## `ingest_runs`

One row per brand per ingest run. The operational log behind `pnpm ingest -- --report`.

| Column | Type | Default |
|---|---|---|
| `id` | `bigint` | identity |
| `run_dir` | `text` | — |
| `brand` | `text` | — |
| `seen`, `inserted`, `updated`, `deactivated`, `skipped_unchanged` | `integer` | `0` |
| `llm_calls`, `vision_calls` | `integer` | `0` |
| `cost_usd` | `numeric` | `0` |
| `duration_ms` | `integer` | null |
| `created_at` | `timestamptz` | `now()` |

`cost_usd` and the call counts are here on purpose: the caches are the entire cost
control, so a jump in cost is the signal that one of them stopped working.

---

## `expansion_cache`

Query-expansion results, keyed by a hash that includes the prompt version — so editing
the prompt invalidates old entries instead of serving stale expansions.

| Column | Type | Null | Default |
|---|---|---|---|
| `query_hash` | `text` | no | PK |
| `query_text` | `text` | no | — |
| `expansion` | `jsonb` | no | — |
| `model` | `text` | no | — |
| `hits` | `integer` | no | `0` |
| `created_at` | `timestamptz` | no | `now()` |

---

## The BM25 index

```sql
CREATE INDEX products_bm25 ON products
USING bm25 (
  id, search_title, search_attrs, search_material, search_body,
  brand, category, price_cents, is_active
)
WITH (
  key_field = 'id',
  text_fields = '{
    "search_title":    {"tokenizer":{"type":"default","stemmer":"English"},"record":"position"},
    "search_attrs":    {"tokenizer":{"type":"default","stemmer":"English"},"record":"position"},
    "search_material": {"tokenizer":{"type":"default","stemmer":"English"},"record":"position"},
    "search_body":     {"tokenizer":{"type":"default","stemmer":"English"},"record":"position"},
    "brand":           {"tokenizer":{"type":"raw"},"fast":true},
    "category":        {"tokenizer":{"type":"raw"},"fast":true}
  }',
  numeric_fields = '{"price_cents":{"fast":true}}',
  boolean_fields = '{"is_active":{"fast":true}}'
);
```

Four things here are load-bearing, and all four are version-specific to pg_search 0.23.1:

**`USING bm25`, not `USING paradedb`.** Newer docs show the latter; it errors with
"access method does not exist" on this version.

**The English stemmer is not optional.** The default tokenizer does no stemming — probed
against a row titled "Turtle Tie Shirt", a search for `shirts` returned nothing until the
stemmer was configured explicitly. Every plural/singular mismatch would silently cost
recall.

**`record: 'position'`** is what makes phrase queries (`###`) work — position data is how
"turtle neck" matches as a phrase rather than as two independent terms.

**`brand`, `category`, `price_cents` and `is_active` live inside the index** so filters
can be expressed *within* the `@@@` expression. A SQL `WHERE brand = ANY(...)` sitting
next to `ORDER BY score LIMIT 120` lets the planner take the top 120 by score and only
then filter, silently returning fewer candidates and capping recall.

Field weights are **not** baked in. They are applied per query via `paradedb.boost()`,
because the eval sweep tries ~160 boost combinations and index-time weights would mean
160 index rebuilds instead of 160 queries.

Changing the field configuration is a drop-and-recreate that touches no data — which is
why the index has its own migration.

---

## Migrations

Kysely `FileMigrationProvider`, tracked in `kysely_migration`. Run with `pnpm migrate`
(idempotent).

| # | Name | What it does |
|---|---|---|
| 001 | `extensions` | `pg_search`, `pgcrypto` |
| 002 | `products` | the catalog table |
| 003 | `users` | `users`, `user_preferences`, `ab_comparisons` |
| 004 | `products_bm25` | the BM25 index |
| 005 | `vendor_sku_not_unique` | drops the uniqueness assumption on `(brand, vendor_sku)` |
| 006 | `extraction_model` | `attributes_model`, `vision_model` + index |
| 007 | `image_set_hash` | `image_set_hash`, `vision_image_set_hash` — the vision cache |
| 008 | `style_cluster` | `user_preferences.style_cluster` (questionnaire Q5) |

Down migrations exist for all eight. `001.down` deliberately does not drop `pg_search` —
the BM25 index depends on it and the drop would fail anyway.

---

## Current contents

As of 2026-08-16:

| Table | Rows |
|---|---|
| `products` | 732 (685 active) |
| `ingest_runs` | 67 |
| `users` | 7 |
| `user_preferences` | 7 |
| `expansion_cache` | 7 |
| `ab_comparisons` | 3 |

Catalog by brand (active / total):

| Brand | Active | Total |
|---|---:|---:|
| aritzia | 105 | 105 |
| uniqlo | 100 | 100 |
| rihoas | 100 | 100 |
| everlane | 100 | 100 |
| skims | 97 | 97 |
| reformation | 83 | 83 |
| gap | 50 | 97 |
| madewell | 50 | 50 |

297 products carry vision extraction (`vision_version > 0`), so roughly 390 active
products are still awaiting a vision pass.
