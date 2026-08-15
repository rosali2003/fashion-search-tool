# Ink — Handoff

Personal-brand fashion search. Describe a garment in plain language, get matches from
your trusted brands, ranked against your body and taste, each with a line on why it
fits you.

> **This document replaced an earlier version that described pgvector and OpenAI
> `text-embedding-3-small`. That architecture was never built.** Retrieval is BM25.
> If you find other references to embeddings anywhere, they are stale.

---

## Stack

| Layer | Tech |
|---|---|
| Retrieval | **BM25 via ParadeDB `pg_search`** (Tantivy inside Postgres) |
| Database | Postgres 17 from `paradedb/paradedb:0.23.1-pg17`, host port **5433** |
| Query builder | Kysely — except BM25 queries, which are raw SQL in one file |
| LLM | **OpenAI or Anthropic** — `gpt-5-nano` by default; query expansion, reranking, attribute + vision extraction |
| Backend | Node + Hono, run via `tsx`, no build step |
| Frontend | React 18 + Vite, zero runtime dependencies beyond React |
| Tests | `node:test` via tsx — no test framework installed |

**No embeddings, no vector index.** Semantic reach comes from a synonym map applied at
both ingest and query time, plus LLM query expansion.

---

## Running it

```bash
cp .env.example .env          # set OPENAI_API_KEY or ANTHROPIC_API_KEY
docker compose up -d          # ParadeDB on 5433 (local Postgres keeps 5432)
pnpm install
pnpm migrate                  # 7 migrations
pnpm ingest -- --report       # ingests the newest run under output/
pnpm dev:backend              # :3000
pnpm dev:frontend             # :5173
```

The API key is optional. Without one the LLM stages degrade and search still works —
a designed state, not a broken one, and the UI says so honestly.

| Command | What it does |
|---|---|
| `pnpm refresh` | scrape → ingest → enrich. The daily cron entry point |
| `pnpm ingest -- --report` | deterministic ingest, prints facet coverage |
| `pnpm enrich -- --dry-run` | shows what the LLM passes would cost, spends nothing |
| `pnpm eval` | retrieval metrics against the golden set. $0, ~3s |
| `pnpm eval -- --gate` | same, non-zero exit on a failed gate |
| `pnpm test` | 79 unit tests |
| `pnpm --filter backend exec tsx evals/src/sweep.ts` | field-boost sweep |

---

## Current state

**Working end to end.** 355 active products, search + brand filters + personalisation
+ A/B learning + the full daily pipeline. Enrichment has run: 297 products have vision
geometry from `gpt-5-mini`, 272 have LLM text attributes.

Retrieval quality on the 27-case golden set (retrieval only, no LLM):

| Metric | Value |
|---|---|
| nDCG@10 | 0.713 ± 0.074 |
| Recall@120 | 0.957 |
| Case gates | 14/14 |
| Zero-result behaviour | 1.000 |

Per slice: `material` 0.955 · `brand` 0.948 · `attribute` 0.862 · `canary` 0.716 ·
`vague` 0.491 · **`negation` 0.017**.

**The canary query works on retrieval alone.** *"cotton tie-back shirt, high collar,
one tie"* returns `Off White Turtle Tie Regular Sleeve Shirt` at **#1** from BM25 with
no LLM. Note the live `/api/search` path can differ once reranking is on — see the
pooling caveat in Open work.

Models by stage: `expand` and `extract` on **gpt-5-nano**, `rerank` and `vision` on
**gpt-5-mini**. Both stages needing judgement measurably fail on nano.

---

## Architecture

```
scrapers ──► output/<run>/*.json + content-addressed images
                  │
                  │  pnpm ingest         deterministic, offline, idempotent
                  ▼
      normalize ──► rules extraction ──► upsert on product_url
                  │
                  │  pnpm enrich          LLM, resumable, cached
                  ▼
      text attributes + vision geometry ──► reconcile ──► rewrite search fields
                  │
                  ▼
      Postgres: products · users · user_preferences · ab_comparisons
                  │
POST /api/search { query, userId }
  1. expand      nano  → garment synonyms          [cached · fails open]
  2. retrieve    BM25, 120 candidates, filters inside @@@
  3. diversify   cap any brand at 40% of the window
  4. rerank      mini  → order + match reasons      [fails open]
  5. blend       relevance ⊕ preference affinity
  6. respond     top 10; internal scores never serialised
```

---

## Things that will bite you

### `pg_search` syntax is version-specific

Verified against **0.23.1** by direct probing. Newer docs describe a different API.

- `USING bm25` is correct. `USING paradedb` **does not exist** in 0.23.1
- Field config goes in `WITH (text_fields=...)` as JSON, not `::pdb.*` casts
- `pdb.score(id)` and `paradedb.score(id)` both work
- Operators: `|||` disjunction, `&&&` conjunction, `###` phrase, `===` exact term
- Query-time boosting: `paradedb.boost(n, paradedb.match(field, text))`

**The stemmer is not optional.** The default tokenizer does no stemming — a search for
`shirts` returns nothing against a product titled "Turtle Tie Shirt" until an English
stemmer is configured explicitly. See `004_products_bm25.ts`.

`pg_search` is unavailable on managed Postgres (RDS, Neon, Supabase). Deploying means
ParadeDB Cloud or self-hosting the image.

### BM25's `k1` and `b` cannot be tuned

Tantivy hardcodes them (`K1 = 1.2`, `B = 0.75`) as module constants and `pg_search`
exposes no override — [tantivy#2924](https://github.com/quickwit-oss/tantivy/issues/2924).

The substitute is field decomposition: `search_attrs` is rendered from a controlled
vocabulary so it is length-uniform across brands, and prose lives in `search_body`
capped at 600 characters. Sweeping `b` moved brand mix by ~5 of 140 top-20 slots, so it
was never the lever anyway. `config.ts` keeps both constants documented as inert so
nobody spends an afternoon looking for the knob.

### Negation does not work, and cannot be tuned to work

"Dress with no sleeves" scores the token `sleeve` **positively**. All 54 configurations
in the boost sweep scored the negation slice between 0.016 and 0.019. BM25 is
bag-of-words; there is no representation for "not". The only fix is query expansion
rewriting the intent before retrieval — the expander already returns `hasNegation` and
`negatedTerms`, but nothing consumes them yet. **That is the highest-value open task.**

### The reranker curates the head; BM25 supplies the tail

`rerank` returns at most 10 items and often fewer — gpt-5-mini returned 5 on the canary,
gpt-5-nano returned 2. Treating "not returned by the model" as "not a result" discarded
the rest of a 60-candidate window. Symptoms: short result pages, and personalisation
that could only reshuffle the model's handful because `scoreForUser` never saw anything
else. `RESULT_LIMIT = 10` was dead code.

`routes/search.ts` now appends the un-picked candidates in BM25 order after the model's
picks. The canary went from 6 results to 10, of which 3 are model-ordered (they carry a
`reason`) and 7 are BM25-ordered (`reason: null`, which the card already renders as
nothing). A short or empty model response degrades to plain BM25 order rather than a
short page.

**This activated a latent bug, so the two had to ship together.** `affinity.ts` spread
relevance over a FIXED 10 ranks. With the window truncated to 10 that was fine; with 60
candidates arriving, every item from index 10 onward scored relevance exactly 0 —
fifty products ordered by preference alone. The ramp is now window-relative
(`rankScaleFor`), with a floor of 10 so short result sets do not let preference flip
two candidates on nothing.

Watch `PREFERENCE_WEIGHT`: its effect scales with window size, so the same 0.35 went
from moving a product ~5 places to ~31. See the note above the constant.

### Negation finally has a consumer

`expandQuery` has always returned `hasNegation` and `negatedTerms`, and nothing read
them. They now go into the rerank prompt as an explicit exclusion list. Soft by
construction — the model weighs it, so a mis-parsed negation costs precision rather than
emptying the page.

Observed on *"maxi dress that is not floral"*: **0 floral products in the top 10**, with
the top result's reason ending "non-floral match". The retrieval-only eval still reports
the `negation` slice at 0.017 and always will — it does not run the reranker. Only
`--full` can see this.

### Preference blending is additive, and was silently broken once

The first implementation used `relevance × (0.5 + 0.5 × affinity)` and produced ranking
*identical* to unpersonalised order for every query. On a cold profile the achievable
affinity spread is ~0.04 while overcoming one rank needs ~0.16, because most components
are neutral until ELO has learned something. Preferences were computed, attached to the
response, and ignored.

It is now `(1 − W) × relevanceNorm + W × affinityNorm` with `W = 0.35` over a **fixed**
10-rank scale. Fixed, so one rank is always worth the same regardless of how many
products matched. `affinity.test.ts` has a regression test.

### Every preference is a soft boost except one

Natural-fibre content correlates hard with brand: Gap 86%, Uniqlo 83%, Aritzia 54%,
**Rihoas 21%**. A hard "prefers natural fibres" filter would delete ~80% of Rihoas — a
third of the catalog — without the user ever excluding a brand. Only `excluded_brands`
is a hard filter, applied inside the BM25 query.

### Catalog coverage is the real ceiling

298 products from scrapers capped at 50/50/100/100. Nothing in the catalog is literally
tie-back; the canary's best match is polyester, not cotton. Raising `MAX_PRODUCTS` is
the single highest-leverage improvement available, and the daily refresh makes a bigger
catalog cheap to maintain.

### Caching is the entire cost control

Uncached daily vision would be **668,000 calls/year** and ~2.75M input tokens/day, and
re-downloading images would grow `output/` by **124 GB/year**.

- `content_hash` on raw scraper fields → unchanged products skip normalisation entirely
- `vision_image_set_hash` → only products whose image set changed are re-extracted
- content-addressed image store → unchanged images are neither re-downloaded nor re-stored

A second `pnpm ingest` reports `inserted=0, unchanged=298`. If `cost_usd` in
`output/refresh.log.jsonl` jumps, a cache stopped working.

### gpt-5-nano is fine for extraction and unfit for judgement

Two stages were measured against the same inputs and the gap is not subtle.

**Vision.** nano returned 13–29 "details" per garment at confidence ~0.2 with
`v_hem_break` and `v_waist_definition` null throughout. mini returned ~3 details at
~0.75 with geometry populated. Strict Structured Outputs guarantee every value is
in-vocabulary; they do nothing about a model enumerating the enum instead of
describing the photograph.

**Reranking.** On the canary query, BM25 alone puts the correct product first. nano's
rerank replaced it with a peplum top and justified the choice with
*"has a tie feature? (no tie)"* — stating the disqualifying fact and ranking the item
first anyway. It also truncated ten results to two.

Both now route to `gpt-5-mini` via `STAGE_DEFAULTS` in models.ts. Extraction and
expansion stay on nano, where the enum does the work and nano is genuinely fine.

**Reasoning tokens are the other nano trap.** It spends `max_completion_tokens` on
invisible reasoning before emitting any JSON, and bills it as output. A single-field
enum extraction cost 658 output tokens, 640 of them reasoning. At
`reasoning_effort: 'minimal'` the same call costs 17. Without that setting an
8-product batch exhausts a 2,000-token budget before the answer starts, surfacing as
`finish_reason: length`.

### Absence from a crawl is not absence from the catalog

The scrapers cap at `MAX_PRODUCTS` across a handful of listing pages, so each run
samples a *different* subset as listing order shifts. **The catalog is a sample, not a
census.** Two Aritzia crawls one day apart shared only part of their assortment, and
deactivating on first absence removed 8 products that were almost certainly still for
sale — including every halter top the golden set referenced.

Deactivation now requires `STALE_AFTER_DAYS` (7) of sustained absence, and
`last_seen_at` records **when the crawl ran**, not when the file was ingested.
Re-ingesting an old run directory must not make six-week-old products look freshly
seen; that is how a June snapshot and an August one ended up active at once.

A consequence worth accepting: within the staleness window the active set is the
*union* of recent samples, so the corpus is larger than any single crawl. That is more
truthful than pretending one capped sample is the whole catalog.

### Resolution must not overwrite its own inputs

`rewriteSearchFields` originally wrote resolved facets back into the text columns.
Resolution gives vision precedence for neckline, so vision seeing `collared` on the
canary target overwrote the name-derived `turtleneck` — and turtleneck is what carries
"high collar" through the synonym map. The canary lost its match and corpus recall@120
fell from 0.957 to 0.904.

The two sources are stored in separate columns deliberately. Resolution decides what
goes into the search field and what the API returns; it must never destroy either
input, or `attribute_conflicts` records a disagreement whose evidence has already been
erased.

### Ingest must never write enrichment columns

`normalizeProduct` wrote `vision_version: 0` on every upsert, and the daily refresh
upserts every product — so the cron would have re-extracted all 299 products **every
day, at full cost, forever**. The caching the whole cost model rests on was being reset
by the step immediately before it.

`ENRICHMENT_OWNED` in upsert.ts lists the excluded columns explicitly. It is a list and
not a prefix match on purpose: a prefix rule on `attributes_` also caught
`attributes_version`, which is the *normaliser* marker ingest owns and the
skip-unchanged check compares against — so it never advanced, every row looked stale,
and ingest stopped skipping anything. The two concerns share a prefix but not an owner.

### Fail-open protects correctness, not latency — hence the circuit breaker

`withFallback` guarantees a search never fails when the provider is down. It does
nothing about the search being *slow*. Measured with a valid OpenAI key on an unpaid
account:

| | latency | results |
|---|---|---|
| Before the breaker | **4,204ms** | correct |
| After | **35ms** | identical |

Every request was paying 1,500ms of expansion timeout plus ~2,200ms of SDK retries to
arrive at the same fallback. `llm/breaker.ts` distinguishes failures that retrying can
fix from failures it cannot:

- **terminal** — 401/403, or a 429 whose message says quota/credits/billing. Trips on
  the first occurrence, 10 minute cooldown. An unpaid account does not recover by being
  asked again.
- **transient** — timeouts, 5xx, plain rate limits. Trips after 3 consecutive, 30 second
  cooldown, and a single success resets the count.

Circuits are per stage, so a failing reranker does not disable expansion. After the
cooldown the circuit half-opens and lets one call through.

**`maxRetries: 1` on both SDKs is load-bearing here.** With the default of 2, the SDK's
internal backoff outlives the 1.5s expansion budget, so our timeout fires first and the
classifier sees a generic `Timeout` instead of the 429 — which would need three
consecutive slow searches to trip instead of one. Repeated failure is the breaker's job,
not the SDK's.

### Either provider works; the model id picks it

`INK_MODEL` selects the model and the **provider is derived from it** via the registry
in `llm/models.ts`. There is deliberately no separate `PROVIDER` setting — that is a
config that can disagree with itself, and this shape cannot. An unknown id warns and
falls back to the default rather than crashing.

```bash
INK_MODEL=gpt-5-nano                pnpm eval -- --full --repeat 3   # needs OPENAI_API_KEY
INK_MODEL=claude-haiku-4-5-20251001 pnpm eval -- --full --repeat 3   # needs ANTHROPIC_API_KEY
```

Both keys can be set at once; only the active model's is read, which makes an A/B a
one-variable change. The server prints its resolution at boot:

```json
{"model":"gpt-5-nano","provider":"openai","ready":false,"keys_present":[],
 "note":"OPENAI_API_KEY is not set — LLM stages will degrade to BM25-only"}
```

**Why `gpt-5-nano` is the default.** ~17× cheaper per search than `claude-haiku-4-5` on
this workload ($0.0010 vs $0.0170), and the vision backfill is $0.12 against $4.72 —
partly pricing, partly that OpenAI's image tiling charges ~765 tokens for nearly every
image in this catalog where Anthropic charges 480–2,622.

The better reason is **strict Structured Outputs**. This codebase has 24 `coerce()` call
sites and silently drops out-of-vocabulary values in two places, because Anthropic's
tool-use strongly encourages enum conformance without guaranteeing it. OpenAI's
`strict: true` enforces the schema by constrained decoding, so that drop path becomes
unreachable.

Strict mode has no notion of "optional", which matters because "omit anything you are
unsure of" is load-bearing in the extraction prompts — a guessed neckline is worse than
a missing one. `llm/strictSchema.ts` rewrites the schemas at call time: every property
becomes required, and originally-optional ones gain a `null` union (including `null` in
the enum, or constrained decoding has no legal way to say "unsure"). Arrays deliberately
stay non-nullable, since an empty array already means "none found" and two encodings for
one state would mean two code paths in every sanitizer. Nine tests cover it.

**What is NOT verified:** nobody has run either provider against this workload. No key
is set, so all four stages are inert. Reranking is the stage to watch — it is the only
one doing real judgement, and the one where a nano-class model is most likely to
disappoint. Run `pnpm eval -- --full --repeat 3` on both before trusting the default.

**One known gap:** the vision cache keys on `vision_image_set_hash` + `vision_version`,
not on the model. Switching providers after a backfill will *not* re-extract, so you can
end up with mixed-provider geometry. Use `--reextract` if that matters.

### The golden set has a shelf life, and it is shorter than you think

**Measured, not theorised.** Between the June crawl and an August re-crawl of Aritzia
and Gap, **32 of 78 judged URLs were deactivated** — roughly 40% of the golden set went
stale in about six weeks of ordinary retail rotation. Linen vanished from the catalog
entirely; cashmere and wool appeared.

Run against the stale set, the metrics read as a catastrophic regression:

| | before re-authoring | after |
|---|---|---|
| nDCG@10 | 0.370 | 0.734 |
| Recall@120 | 0.553 | 0.957 |
| Gates | 7/13 | 14/14 |

**None of that was a search regression.** The system was unchanged; the golden set was
pointing at products that no longer existed. `pnpm eval -- --assert-corpus` is what
caught it, and it is the reason the runner calls that check before every scored run.

Consequences to internalise:

- **A baseline is only valid within one catalog generation.** Do not compare
  `results/baseline.json` across a crawl that rotated stock. Re-author, re-baseline,
  and say so in the commit.
- **Re-authoring is normal maintenance, not an emergency.** `evals/src/seed.ts`
  references products by *name* and fails loudly on anything unresolvable, so the work
  is: run the seeder, read the list of dead names, pick replacements from the current
  catalog. It took one pass here.
- **Cases can change category under you.** `wool overcoat` was a true zero-result case
  in June and is not any more, because wool now exists — it is reclassified as an
  adjacency case, and `swimming goggles` (verified 0 results) replaced it. Check the
  `zero` slice after every rotation; a zero case that quietly becomes answerable
  inflates the metric rather than failing.
- **Product names are not stable identifiers, and brands are not internally
  consistent.** Gap ships `High Rise ’90s Slim Straight Crop Jeans` with a curly
  apostrophe and `High Rise Cuffed '90s Slim Straight Jeans` with a straight one. The
  seeder resolving names against the database — rather than URLs being transcribed by
  hand — is what turns that into a loud failure instead of a silent missing judgment.

### The 50% deactivation guard is load-bearing under cron

Products absent from a new crawl are soft-deleted, never `DELETE`d, because the golden
set references `product_url`. `upsertBrand` refuses to deactivate anything when an
incoming file has under 50% of the brand's active count — a half-blocked 3am Aritzia
scrape would otherwise wipe most of the catalog while you sleep. Tested by feeding it
5 of 48 products; it correctly skipped deactivation.

---

## Layout

```
backend/src/
  db/            migrations 001–005, Kysely types
  normalize/     the deterministic core, ~1,400 lines, heavily tested
    patterns.ts    regex builders — READ THE COMMENT before writing a pattern
    material.ts    four brand dialects, one shape-dispatched parser
    vocab.ts       the controlled vocabulary; LLM schemas are generated from it
    synonyms.ts    the most load-bearing file in retrieval
    rihoas.ts      KV parser; 100 products free of LLM extraction
    rules.ts       name-token classification
    render.ts      text/vision precedence + search-field rendering
  ingest/        load, normalize, upsert, images, enrich (the LLM CLI)
  search/        config (boosts), repository (the ONLY raw SQL), diversity
  llm/           guard (fail-open chokepoint), client, expand, rerank, extract, vision
  preferences/   stylingRules, affinity, elo, repository, options
  routes/        search, images, users
evals/
  golden/        queries.json (human-owned) + README.md (the rubric)
  src/           seed, metrics, run, sweep
frontend/src/    api client, components, onboarding
scripts/         refresh.ts — the daily cron entry point
```

### Two invariants worth preserving

**All raw BM25 SQL lives in `search/repository.ts`.** Kysely cannot express `@@@`, so
that file is the entire unsafe surface. Every user value is a bound parameter;
`sql.lit` is only used for numeric boosts validated in-file.

**Nothing in the search path may `await` an Anthropic call directly.** Everything goes
through `withFallback` in `llm/guard.ts`, which is what guarantees search never 500s
because a model provider is slow. Audit with:

```bash
grep -rn "messages.create\|anthropic()" backend/src --include=*.ts
```

Only `llm/client.ts` and the modules it backs should appear.

---

## Where the styling intelligence lives, and why

Body-proportion advice ("high rise elongates the leg line") is in
`preferences/stylingRules.ts`, **not** in the vision extraction prompt.

Vision extraction is cached per *product*; preferences are per *user*. Putting "this
shopper has short legs" in the extraction prompt makes the cache key `(product, user)`
— 298 calls per signup, and the content-hash cache that makes a daily refresh
affordable stops working entirely.

So extraction records observable geometry (`v_rise`, `v_hem_break`,
`v_shoulder_treatment`, `v_waist_position`, …) and the rules interpret it. The rules
also feed the rerank prompt, so the model reasons about fit per-user while the advice
itself stays in one reviewable file. Each rule carries a `because` string that becomes
the user-facing line on the card.

**These rules encode conventional styling advice, not fact.** People reasonably
disagree with them. They are kept correctable, shown to the user as the reason a
garment surfaced, and progressively overridden by ELO as real choices accumulate.
Don't present them as authoritative.

---

## Open work

1. **Consume `hasNegation` / `negatedTerms`** in the BM25 query as `must_not` clauses.
   The negation slice is at 0.017 and this is the fix.
2. **Run the LLM passes.** `pnpm enrich` needs a key. 259 products want text
   attributes, 298 want vision. Budget under $3 total, one time. Then re-run `pnpm eval`
   — both recall@120 and nDCG must beat `evals/results/baseline.json`.
3. **Hand-label 50 products** to measure vision accuracy per attribute **per brand**.
   Aritzia and Uniqlo shoot clean studio; Rihoas shoots styled scenes with props and a
   handbag; a headline number would hide the worst brand.
4. **Finish the scraper fit-data extension, and verify it on a live run.** The
   `ScrapedProduct` contract, the parsing helpers (`parseHeightCm`, `normalizeSize`,
   tested), Rihoas sizes (from the Shopify `options` array — free), and Uniqlo sizes
   plus model height (`includeModelSize` flipped from `false` to `true`) are all
   written. Two caveats:
   - **The Uniqlo response shape is unverified.** It is read defensively across
     several plausible locations (`result.sizes`, `result.summary.sizes`,
     `result.modelSize`, `result.models[0]`) so a shape change yields null instead of
     a crash, but nobody has seen a live response with `includeModelSize=true`. Check
     it the first time `pnpm scrape:uniqlo` runs.
   - **Aritzia and Gap still have no fit data.** Both publish model height and a size
     selector on the PDP, but extracting them needs DOM selectors written against the
     live pages, which was not done. Aritzia already sticky-blocks and opens a fresh
     browser context per product, so budget for that.
5. **Raise `MAX_PRODUCTS`.** See catalog coverage above.
6. **Add a preference-honouring metric** to the eval, run against a fixed synthetic
   persona. Relevance, preference and styling fit can fight each other, and only
   measuring all three stops one being optimised at the others' expense.
7. **Re-pool the golden set against the enlarged corpus.** This is now the biggest
   source of metric noise. The corpus grew from 299 to 355 as recent crawls added
   products, and anything the pooling round never saw scores 0 by omission even when
   it is a good answer. Concretely: on the canary the reranker surfaces a
   `Button-Front Crop Peplum Top` — 100% cotton with a mandarin (high) collar, so two
   of the query's three attributes, exactly as many as the graded target — and it
   counts as irrelevant purely because nobody judged it. The retrieval-only eval is
   unaffected and still gates cleanly; it is the `--full` numbers that are
   understated.
8. **Consider moving content-addressing into the scrapers.** Today `ingest/images.ts`
   hashes the downloaded files and hard-links them into `output/images/<hash>`, which
   gives portability and de-duplication but happens *after* the download. Hashing at
   download time would also skip re-fetching bytes that are already stored — the
   remaining half of the 124 GB/year problem.

The Gap slug collision is **fixed**: the slug now includes the `pid`, so three
separate product pages all named "CloseKnit Jersey T-Shirt" no longer overwrite each
other's image folder.
