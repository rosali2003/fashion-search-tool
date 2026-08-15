import type { SearchMeta } from '../api/types.js'

/**
 * Skeletons at the real aspect ratio, so nothing shifts when results land.
 *
 * Twelve rather than ten: the grid is four columns, and a count that is not a
 * multiple of the column count leaves a ragged final row that reads as a partly
 * failed load rather than as a placeholder.
 */
export function LoadingGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="grid" aria-busy="true" aria-label="Searching">
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton" key={i}>
          <div className="sk-img" />
          <div className="sk-line" />
          <div className="sk-line short" />
        </div>
      ))}
    </div>
  )
}

/**
 * Empty state.
 *
 * "Your filters are too narrow" and "we have nothing like this" are completely
 * different messages, so the backend reports how many products the filters alone
 * would match and the copy branches on it.
 */
export function EmptyState({
  query,
  brands,
  meta,
  onClearFilters,
}: {
  query: string
  brands: string[]
  meta: SearchMeta
  onClearFilters: () => void
}) {
  const filtered = brands.length > 0
  const wouldMatch = meta.would_match_without_filters ?? 0

  if (filtered && wouldMatch > 0) {
    return (
      <div className="notice">
        <h3>Nothing from {brands.join(', ')} matches that</h3>
        <p>
          There are {wouldMatch} products across all brands for “{query}”. The brand filter is
          what is holding them back.
        </p>
        <div className="notice__actions">
          <button className="btn" onClick={onClearFilters}>
            Search all brands
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="notice">
      <h3>No matches for “{query}”</h3>
      <p>
        Nothing in the catalog is close enough to return honestly. Try describing the garment
        more loosely, or in different words.
      </p>
    </div>
  )
}

/**
 * Degradation banner.
 *
 * Shown rather than hidden. A silently worse ranking is indistinguishable from a
 * broken one, and being explicit makes both demoing and debugging honest.
 */
export function DegradedBanner({ degraded }: { degraded: string[] }) {
  if (degraded.length === 0) return null

  const rerank = degraded.includes('rerank')
  const expansion = degraded.includes('expansion')

  return (
    <div className="banner" role="status">
      {rerank && expansion
        ? 'Ranked by keyword match only — smart ranking and query expansion are unavailable.'
        : rerank
          ? 'Ranked by keyword match only — smart ranking is unavailable, so match reasons are hidden.'
          : 'Query expansion is unavailable, so results rely on your exact wording.'}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="notice">
      <h3>That search did not complete</h3>
      <p>{message}</p>
      <div className="notice__actions">
        <button className="btn" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  )
}
