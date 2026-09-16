# Ink

Personal-brand fashion search. Describe a garment in plain language and get matches
from your trusted brands, ranked against your body and taste, each with a line on why
it fits you.

Retrieval is **BM25** (ParadeDB `pg_search`) — no embeddings, no vector index.

```bash
cp .env.example .env       # ANTHROPIC_API_KEY optional; search works without it
docker compose up -d       # ParadeDB on 5433
pnpm install
pnpm migrate
pnpm ingest -- --report
pnpm dev:backend           # :3000
pnpm dev:frontend          # :5173
```

Try `cotton tie-back shirt, high collar, one tie` — it returns the right product at #1
from a 298-item catalog with no LLM in the loop.

| | |
|---|---|
| `pnpm refresh` | daily pipeline: scrape brands that are due → ingest → enrich |
| `pnpm brands list` | per-brand scrape cadence; `pnpm brands set gap '2 weeks'` |
| `pnpm eval` | retrieval metrics against the golden set ($0, ~3s) |
| `pnpm test` | 57 unit tests |
| `pnpm enrich -- --dry-run` | what the LLM passes would cost |

**Read [HANDOFF.md](./HANDOFF.md) before changing anything.** It documents the
version-specific `pg_search` syntax, why BM25's `k1`/`b` cannot be tuned, why negation
does not work, and two architectural invariants that are easy to break by accident.

## Optional accounts

Guests can search, answer the questionnaire, and train their profile without
signing in. Google sign-in and email codes save that profile across devices.
See [authentication setup](docs/authentication.md) for Google and Twilio setup,
deployment steps, legacy-profile compatibility, and tests. No passwords, SMS,
saved products, or search history are collected by this feature.
