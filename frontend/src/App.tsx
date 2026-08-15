import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clearUserId, fetchOptions, fetchProfile, getUserId, recordComparison,
  search, suggestPair,
} from './api/client.js'
import type {
  OnboardingOptions, PairItem, Profile, SearchResult, SearchMeta,
} from './api/types.js'
import { Questionnaire } from './onboarding/Questionnaire.js'
import { ResultCard } from './components/ResultCard.js'
import { Pagination } from './components/Pagination.js'
import { Compare } from './components/Compare.js'
import { ProfileSummary } from './components/ProfileSummary.js'
import { DegradedBanner, EmptyState, ErrorState, LoadingGrid } from './components/States.js'

/**
 * Example queries for the idle state.
 *
 * The first is the product plan's canary — the flagship success criterion — so it
 * is one click to reproduce the hardest case in the browser. The rest cover the
 * query shapes the eval harness measures: attribute-precise, material-led, vague,
 * and one with no possible answer.
 */
const EXAMPLES = [
  'cotton tie-back shirt, high collar, one tie',
  'black square neck sleeveless midi dress',
  '100% linen shirt',
  'something cozy for the weekend',
  'high rise wide leg jeans',
  'wool overcoat',
]

const FALLBACK_PAGE_SIZE = 50

type View = 'search' | 'onboarding'

export default function App() {
  const [options, setOptions] = useState<OnboardingOptions | null>(null)
  const [userId, setUserId] = useState<string | null>(getUserId())
  const [profile, setProfile] = useState<Profile | null>(null)

  /**
   * A new user meets the questionnaire, not the search bar.
   *
   * `optionsReady` gates this: the questionnaire is driven entirely by the
   * vocabularies from GET /api/users/options, so rendering the gate before they
   * land would flash an empty form. Until then neither view is committed to.
   */
  const [view, setView] = useState<View | null>(null)

  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [brands, setBrands] = useState<string[]>([])

  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [meta, setMeta] = useState<SearchMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  const [pair, setPair] = useState<PairItem[] | null>(null)
  const [pairDismissed, setPairDismissed] = useState(false)

  const gridTop = useRef<HTMLDivElement | null>(null)

  // Aborts the previous search. Not optional: with a multi-second pipeline a slow
  // first request would otherwise land after a fast second one and overwrite it.
  const inFlight = useRef<AbortController | null>(null)

  useEffect(() => {
    fetchOptions()
      .then((o) => {
        setOptions(o)
        // Decided once, when the vocabularies arrive: a known user goes straight
        // to search, an unknown one is asked the questions first.
        setView(getUserId() ? 'search' : 'onboarding')
      })
      .catch(() => {
        // Without options the questionnaire cannot render, but search still
        // works — so fail into the usable half rather than a dead end.
        setOptions(null)
        setView('search')
      })
  }, [])

  const loadProfile = useCallback((id: string) => {
    fetchProfile(id).then(setProfile).catch(() => setProfile(null))
  }, [])

  useEffect(() => {
    if (userId) loadProfile(userId)
  }, [userId, loadProfile])

  const runSearch = useCallback(
    async (q: string, brandFilter: string[]) => {
      const text = q.trim()
      if (!text) return

      inFlight.current?.abort()
      const ctrl = new AbortController()
      inFlight.current = ctrl

      setLoading(true)
      setError(null)
      setSubmitted(text)
      setPair(null)
      setPairDismissed(false)
      // A new query is a new result set; staying on page 3 of the old one would
      // land the user in the middle of results they have not seen the top of.
      setPage(1)

      try {
        const res = await search(text, { brands: brandFilter, signal: ctrl.signal })
        if (ctrl.signal.aborted) return
        setResults(res.results)
        setMeta(res.meta)

        // Offer a comparison from what was just returned. Cross-brand pairs are
        // chosen server-side, because a same-brand pair yields no brand signal.
        const id = getUserId()
        if (id && res.results.length >= 2) {
          suggestPair(id, res.results.slice(0, 20).map((r) => r.id))
            .then((p) => {
              if (!ctrl.signal.aborted) setPair(p)
            })
            .catch(() => undefined)
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setError(e instanceof Error ? e.message : 'Search failed')
        setResults(null)
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    },
    [],
  )

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    void runSearch(query, brands)
  }

  function toggleBrand(brand: string) {
    const next = brands.includes(brand) ? brands.filter((b) => b !== brand) : [...brands, brand]
    setBrands(next)
    if (submitted) void runSearch(submitted, next)
  }

  function runExample(q: string) {
    setQuery(q)
    void runSearch(q, brands)
  }

  /** "Find similar" reuses the result's own attributes as the next query. */
  function findSimilar(r: SearchResult) {
    const q = [r.attributes.slice(0, 4).join(' '), r.material_badge ?? '']
      .join(' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (q) runExample(q)
  }

  async function pick(winnerId: number, loserId: number) {
    const id = getUserId()
    if (!id) return
    setPair(null)
    try {
      await recordComparison(id, winnerId, loserId)
      loadProfile(id)
      // Re-run so the effect of the comparison is immediately visible.
      if (submitted) void runSearch(submitted, brands)
    } catch {
      /* a lost comparison is not worth interrupting the user for */
    }
  }

  function reset() {
    clearUserId()
    setUserId(null)
    setProfile(null)
    setView('onboarding')
  }

  const pageSize = meta?.page_size ?? FALLBACK_PAGE_SIZE
  const total = results?.length ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  const visible = useMemo(
    () => (results ?? []).slice((page - 1) * pageSize, page * pageSize),
    [results, page, pageSize],
  )

  /**
   * Reasons that apply so broadly they belong above the grid, not on every card.
   *
   * The styling and aesthetic rules key on garment categories, so across a page
   * of 50 the same sentence lands on most items. Stated once as the standing
   * rationale for the whole result set it is useful; repeated fifty times it is
   * noise, and it crowds out the per-product match reason that actually differs.
   *
   * Computed per page, not over the whole result set, and measured rather than
   * assumed. On a real query the leg-line rule covered 38 of the 50 cards on
   * page 1 but only 9 on page 2 — because personalisation concentrates its
   * strongest matches at the top. Over all 120 results it averages to 39%, under
   * any majority threshold, so a whole-set computation hoists nothing and leaves
   * page 1 exactly as repetitive as before.
   *
   * So the block appears on page 1 and not on page 2. That is not an
   * inconsistency to fix: it is the honest report that page 1 really is
   * dominated by one rationale and page 2 really is not, where the same line on
   * 9 of 50 cards is doing useful work distinguishing them.
   */
  const { standing, suppressed } = useMemo(() => {
    const lines: string[] = []
    const set = new Set<string>()
    if (visible.length === 0) return { standing: lines, suppressed: set }

    for (const field of ['styling_reason', 'aesthetic_reason'] as const) {
      const counts = new Map<string, number>()
      for (const r of visible) {
        const v = r[field]
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
      }
      for (const [text, n] of counts) {
        if (n > visible.length / 2) {
          lines.push(text)
          set.add(text)
        }
      }
    }
    return { standing: lines, suppressed: set }
  }, [visible])

  function goToPage(p: number) {
    const next = Math.min(pageCount, Math.max(1, p))
    setPage(next)
    // Paging without this leaves the viewport at the bottom of the previous
    // page, so a new page appears to start mid-grid.
    gridTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /**
   * Where curation stops.
   *
   * Results past `curated_count` were retrieved by BM25 but never judged by the
   * reranker or scored against the profile. Marking that boundary is more honest
   * than presenting 120 results as though they were all considered.
   */
  const curated = meta?.curated_count ?? total
  const tailStartsOnThisPage =
    curated > 0 && curated < total &&
    curated >= (page - 1) * pageSize && curated < page * pageSize

  if (view === null) return null

  if (view === 'onboarding' && options) {
    return (
      <Questionnaire
        options={options}
        mode={userId ? 'edit' : 'onboard'}
        onDone={(id) => {
          if (id) setUserId(id)
          setView('search')
          if (submitted) void runSearch(submitted, brands)
        }}
        onSkip={() => setView('search')}
      />
    )
  }

  const showEmpty = results !== null && results.length === 0 && !loading && !error
  const idle = results === null && !loading && !error

  return (
    <>
      <header className="masthead">
        <div className="masthead__inner">
          <span className="wordmark">Ink</span>
          <span className="masthead__actions">
            {userId ? (
              <>
                <button className="btn btn--quiet" onClick={() => setView('onboarding')}>
                  Edit profile
                </button>
                <button className="btn btn--quiet" onClick={reset}>
                  Start over
                </button>
              </>
            ) : (
              <button className="btn btn--primary" onClick={() => setView('onboarding')}>
                Set up your profile
              </button>
            )}
          </span>
        </div>
      </header>

      <section className="searchzone">
        <div className="searchzone__inner">
          <form className="searchform" onSubmit={onSubmit}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Describe what you're looking for"
              aria-label="Describe what you're looking for"
              autoFocus
            />
            <button className="btn btn--primary" type="submit" disabled={loading || !query.trim()}>
              {loading ? 'Searching…' : 'Search'}
            </button>
          </form>

          {idle && (
            <div className="examples">
              <span className="u-label">Try</span>
              {EXAMPLES.map((q) => (
                <button key={q} className="chip" onClick={() => runExample(q)}>
                  {q}
                </button>
              ))}
            </div>
          )}

          {meta && <DegradedBanner degraded={meta.degraded} />}
        </div>
      </section>

      {options && (
        <div className="filterbar">
          <div className="filterbar__inner">
            <span className="u-label">Brands</span>
            {options.brands.map((b) => (
              <button
                key={b}
                className="chip"
                aria-pressed={brands.includes(b)}
                onClick={() => toggleBrand(b)}
              >
                {b}
              </button>
            ))}
            {meta && results && results.length > 0 && (
              <span className="filterbar__count u-num">
                {total} {total === 1 ? 'result' : 'results'} · {meta.took_ms}ms
                {meta.personalized ? ' · ranked for you' : ''}
              </span>
            )}
          </div>
        </div>
      )}

      <main className="shell">
        <div ref={gridTop} />

        {profile && options && (
          <div className="panel" style={{ marginTop: 20 }}>
            <ProfileSummary
              profile={profile}
              stableAt={options.stableAfterComparisons}
              onReset={reset}
            />
          </div>
        )}

        {error && <ErrorState message={error} onRetry={() => runSearch(submitted, brands)} />}
        {loading && <LoadingGrid />}

        {showEmpty && meta && (
          <EmptyState
            query={submitted}
            brands={brands}
            meta={meta}
            onClearFilters={() => {
              setBrands([])
              void runSearch(submitted, [])
            }}
          />
        )}

        {idle && (
          <div className="notice">
            <h3>Describe a garment in your own words</h3>
            <p>
              Ink searches the catalog of brands you trust and ranks what it finds against your
              profile — then tells you why each piece surfaced.
            </p>
          </div>
        )}

        {!loading && results && results.length > 0 && (
          <>
            {standing.length > 0 && (
              <div className="standing">
                <span className="u-label">Ranked for you</span>
                <ul>
                  {standing.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid">
              {visible.map((r, i) => {
                const absolute = (page - 1) * pageSize + i
                return (
                  <Fragment key={r.id}>
                    {tailStartsOnThisPage && absolute === curated && (
                      <div className="tailmark">
                        Beyond this point, ordered by keyword match only
                      </div>
                    )}
                    <ResultCard result={r} onFindSimilar={findSimilar} suppress={suppressed} />
                  </Fragment>
                )
              })}
            </div>

            <Pagination
              page={page}
              pageCount={pageCount}
              total={total}
              pageSize={pageSize}
              onChange={goToPage}
            />
          </>
        )}

        {pair && pair.length === 2 && !pairDismissed && profile && options && (
          <Compare
            pair={pair}
            comparisons={profile.comparisonsCount}
            stableAt={options.stableAfterComparisons}
            onPick={pick}
            onSkip={() => setPairDismissed(true)}
          />
        )}
      </main>
    </>
  )
}
