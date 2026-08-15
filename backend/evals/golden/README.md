# Golden set

`queries.json` is the ground truth for retrieval quality. Every tuning decision —
field boosts, synonym entries, extraction changes, the reranker — is judged
against it. That makes it the most load-bearing file in the search system, and the
one where a careless edit does the most damage: if the grades drift toward
whatever the system currently returns, every number afterwards is self-congratulation.

**This file is human-owned.** `evals/src/seed.ts` generates it, but grades are
edited here, by a person, deliberately.

## Grading rubric

| Grade | Meaning |
|---|---|
| **3** | Right garment type **and** at least two distinctive attributes from the query |
| **2** | Right garment type **and** at least one distinctive attribute |
| **1** | Adjacent — right type with no matching attributes, or the right attributes on the wrong type |
| **0** | Everything not listed. Absence is a judgment, not an omission |

"Distinctive" means an attribute the query specifically asked for — a neckline, a
fibre, a length, a construction detail. Not "is a dress" when the query said dress;
that's the garment type, already accounted for.

## Why graded and not binary

The canary query has no perfect answer in this catalog. The best available match
for *"cotton tie-back shirt, high collar, one tie"* is 100% polyester, and nothing
is literally tie-back. Binary judgments would force a choice between discarding
the best real match or claiming it's exactly right. Grades say what is true: right
garment type, two of three attributes, wrong fibre.

## Keys

Judgments are keyed on `product_url`, never on `id`. `id` is a `bigserial` that
changes whenever the catalog is rebuilt from scratch, which would silently
re-point every judgment at a different product.

`pnpm --filter backend eval -- --assert-corpus` verifies every judged URL still
resolves and is active. Run it after any scrape: under the daily cron a product
that goes out of stock is soft-deleted, and scoring against deactivated products
produces metrics that look fine and mean nothing.

## Slices, and why they're reported separately

| Slice | n | What it measures |
|---|---|---|
| `attribute` | 6 | Precise multi-attribute queries. BM25's best case |
| `material` | 5 | Fibre and fabric queries, exercising the material parser |
| `vague` | 5 | "Something cozy for the weekend". No lexical overlap; leans entirely on the occasion facet |
| `brand` | 4 | Brand-filtered search, verifying the filter composes inside `@@@` |
| `negation` | 3 | "Dress with no sleeves". BM25 scores `sleeve` *positively* |
| `zero` | 2 | Queries with no possible answer. Correct behaviour is returning nothing |
| `canary` | 1 | The product plan's headline success criterion |

Averaging these into one number hides the two that matter most diagnostically.
Measured at the current configuration: `attribute` 0.939 and `brand` 0.973, but
`vague` 0.568 and `negation` 0.022.

**Negation is not a tuning problem.** All 54 configurations in the boost sweep
scored it between 0.016 and 0.019. BM25 is a bag-of-words model with no way to
represent "not", so the only fix is query expansion rewriting the intent before
retrieval. Until then this slice is a documented floor, not a bug to chase.

## Adding a case

Build it **known-item style**: start from a product that exists, then write the
query a person would plausibly type to find *that* product. Never write an
aspirational query and hope the catalog answers it — on 298 products it usually
cannot, and the case then measures nothing except catalog coverage.

1. Add it to `CASES` in `evals/src/seed.ts`, referencing products by **name**.
2. Run `pnpm --filter backend exec tsx evals/src/seed.ts`. Names are resolved to
   canonical URLs against the database, so a typo fails loudly rather than
   silently producing an unreachable judgment.
3. Pool the candidates: run the eval with `--verbose`, look at what actually comes
   back, and grade the near-misses. Anything you don't list is grade 0, so a
   relevant product you failed to notice counts against the system unfairly.
4. Set a `gate` only when there is a single unambiguous right answer.

## Gates

Gates are hard booleans: "this product must appear within the first k results."
They are the part of the file that reads as a specification rather than a
measurement, and `--gate` exits non-zero when one fails.

`pnpm --filter backend eval -- --gate` also fails on:

- `recall@120 < 0.95` — the ceiling on everything downstream
- any brand's `recall@120 < 0.85` — detects length-normalisation skew, which
  cannot be corrected by tuning because Tantivy hardcodes BM25's `b`

## Sample size

26 queries gives a standard error on nDCG@10 of about ±0.074. **A 0.02
"improvement" is noise.** The sweep prints this warning for a reason; prefer a
configuration that is uniformly decent across slices over one with the best mean.
