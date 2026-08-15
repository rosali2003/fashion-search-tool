/**
 * Pagination over an already-fetched result set.
 *
 * There is no request behind a page turn. The whole ranked set arrives in one
 * response — see RESULT_LIMIT in the backend's search/config.ts for why: the
 * rerank stage is the expensive, non-deterministic one, and re-running it per
 * page would both cost a call per click and let the same product legitimately
 * appear on two different pages.
 *
 * So page changes are instant, and the only thing this component owns is which
 * slice is visible and getting the viewport back to the top of the grid.
 */

/** Page numbers to render, with nulls marking elided runs. */
export function pageWindow(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)

  const out: (number | null)[] = [1]
  const from = Math.max(2, current - 1)
  const to = Math.min(total - 1, current + 1)

  if (from > 2) out.push(null)
  for (let p = from; p <= to; p++) out.push(p)
  if (to < total - 1) out.push(null)
  out.push(total)

  return out
}

export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  onChange,
}: {
  page: number
  pageCount: number
  total: number
  pageSize: number
  onChange: (page: number) => void
}) {
  if (pageCount <= 1) return null

  const first = (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)

  return (
    <nav className="pager" aria-label="Search results pages">
      <button
        className="pager__btn"
        onClick={() => onChange(page - 1)}
        disabled={page === 1}
        aria-label="Previous page"
      >
        ←
      </button>

      {pageWindow(page, pageCount).map((p, i) =>
        p === null ? (
          <span className="pager__gap" key={`gap-${i}`} aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={p}
            className="pager__btn"
            aria-current={p === page ? 'page' : undefined}
            aria-label={`Page ${p}`}
            onClick={() => onChange(p)}
          >
            {p}
          </button>
        ),
      )}

      <button
        className="pager__btn"
        onClick={() => onChange(page + 1)}
        disabled={page === pageCount}
        aria-label="Next page"
      >
        →
      </button>

      <div className="pager__status u-num" role="status">
        Showing {first}–{last} of {total}
      </div>
    </nav>
  )
}
