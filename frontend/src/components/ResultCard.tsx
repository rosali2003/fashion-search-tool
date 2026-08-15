import { formatPrice } from '../api/client.js'
import type { SearchResult } from '../api/types.js'

/**
 * One product.
 *
 * The whole card is the outbound link, so "Find similar" is a plain text button
 * beneath it rather than a competing call to action — per the UX decision that it
 * must never outrank the link to the brand.
 *
 * The three annotation lines are rendered only when non-null and never
 * substituted with filler. Each has a distinct source and can be absent on its
 * own: `reason` is null when the reranker was unavailable, `styling_reason` when
 * the shopper is anonymous or the garment has no extracted geometry, and
 * `aesthetic_reason` when Q5 was skipped. An empty styled block in place of any
 * of them would read as a rendering bug.
 */
export function ResultCard({
  result,
  onFindSimilar,
  suppress,
}: {
  result: SearchResult
  onFindSimilar?: (r: SearchResult) => void
  /**
   * Reason strings already stated once above the grid.
   *
   * The styling and aesthetic rules describe categories of garment, not
   * individual products, so on a 50-item page the same sentence lands on most
   * cards — "high rise and an unbroken vertical line lengthen the leg line"
   * appeared on four of four cards in a row during testing. Repeated that many
   * times it stops being an explanation and becomes wallpaper. The shared
   * rationale is hoisted to a single line above the results, and a card only
   * carries the note when it has something different to say.
   */
  suppress?: ReadonlySet<string>
}) {
  const shown = (text: string | null): text is string =>
    Boolean(text) && !suppress?.has(text as string)

  const notes = [
    // The query-match reason is per-product by construction, so it is never
    // suppressed — the reranker writes a fresh one for each item.
    result.reason && { key: 'why', cls: 'note', text: result.reason },
    shown(result.styling_reason) && {
      key: 'fit',
      cls: 'note note--fit',
      text: result.styling_reason,
    },
    shown(result.aesthetic_reason) && {
      key: 'taste',
      cls: 'note note--taste',
      text: result.aesthetic_reason,
    },
  ].filter(Boolean) as { key: string; cls: string; text: string }[]

  return (
    <article className="card">
      <a
        className="card__link"
        href={result.product_url}
        target="_blank"
        rel="noopener noreferrer"
      >
        <div className={result.image_url ? 'card__shot' : 'card__shot card__shot--empty'}>
          {result.image_url ? (
            <img src={result.image_url} alt={result.name} loading="lazy" />
          ) : (
            <span>no image</span>
          )}
        </div>

        <div className="card__brand">{result.brand}</div>
        <h3 className="card__name">{result.name}</h3>

        <div className="card__foot">
          <span className="card__price">{formatPrice(result.price_cents)}</span>
          {/* Omitted entirely when unknown — never rendered as "unknown". */}
          {result.material_badge && (
            <span className="card__fiber" title={result.material_full ?? undefined}>
              {result.material_badge}
            </span>
          )}
        </div>
      </a>

      {notes.length > 0 && (
        <div className="notes">
          {notes.map((n) => (
            <p className={n.cls} key={n.key}>
              {n.text}
            </p>
          ))}
        </div>
      )}

      {result.attributes.length > 0 && (
        <div className="card__attrs">
          {result.attributes.slice(0, 4).map((a) => (
            <span key={a}>{a.replace(/-/g, ' ')}</span>
          ))}
        </div>
      )}

      {onFindSimilar && (
        <button
          className="btn btn--link card__similar"
          onClick={() => onFindSimilar(result)}
          title="Search again using this item's attributes"
        >
          Find similar
        </button>
      )}
    </article>
  )
}
