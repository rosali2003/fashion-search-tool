import { formatPrice } from '../api/client.js'
import type { PairItem } from '../api/types.js'

/**
 * A/B comparison.
 *
 * Shown after the user has engaged with results, never as an interruption
 * mid-search, and Skip is always available and never penalised — a skip records
 * nothing at all rather than a weak negative.
 */
export function Compare({
  pair,
  comparisons,
  stableAt,
  onPick,
  onSkip,
}: {
  pair: PairItem[]
  comparisons: number
  stableAt: number
  onPick: (winnerId: number, loserId: number) => void
  onSkip: () => void
}) {
  const [a, b] = pair
  const stable = comparisons >= stableAt

  return (
    <div className="compare">
      <h3>Which of these fits your vibe better?</h3>
      <p className="sub">
        {stable
          ? 'Your profile is built — keep comparing to refine it, or just carry on browsing.'
          : `${comparisons} of ${stableAt} comparisons. Each one sharpens your rankings.`}
      </p>

      <div className="compare__pair">
        {[a, b].map((item, i) => (
          <button
            key={item.id}
            className="compare__opt"
            onClick={() => onPick(item.id, i === 0 ? b.id : a.id)}
          >
            {item.image_url && <img src={item.image_url} alt={item.name} loading="lazy" />}
            <div className="compare__meta">
              <div className="b">{item.brand}</div>
              <div className="n">{item.name}</div>
              <div className="n u-num">
                {formatPrice(item.price_cents)}
                {item.material_badge ? ` · ${item.material_badge}` : ''}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        <button className="btn btn--link" onClick={onSkip}>
          Skip this comparison
        </button>
      </div>
    </div>
  )
}
