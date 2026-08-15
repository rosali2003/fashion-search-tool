import { useState } from 'react'
import { createUser } from '../api/client.js'
import type { OnboardingInput, OnboardingOptions } from '../api/types.js'
import {
  silhouetteArt, aestheticArt, silhouetteGloss, aestheticGloss,
} from './StyleTiles.js'

/**
 * Onboarding.
 *
 * Q1–Q5 are the product plan's style questionnaire, in its order and its
 * vocabulary. The three body questions after them are not in that plan: they
 * feed `stylingRules.ts`, which is the only source of the "why this suits you"
 * line on a result card. Dropping them to match the plan exactly would have
 * silently removed that line from the product.
 *
 * Every question here maps to something that changes ranking. That constraint is
 * enforced server-side by a test asserting each answer value is reachable by at
 * least one rule — a question the system cannot act on is worse than no question,
 * because the user reasonably expects it to matter.
 *
 * One question per screen. The alternative — the whole form on one page — tested
 * badly against the goal: this is a gate a new user must pass to reach search,
 * and a single long scroll reads as a wall to escape rather than a short
 * conversation to finish.
 *
 * Everything is skippable. Search works anonymously and a partial profile is
 * still useful, because unanswered dimensions score neutral rather than zero.
 */

type StepId = 'silhouette' | 'material' | 'price' | 'brands' | 'aesthetic' | 'body'

const STEPS: StepId[] = ['silhouette', 'material', 'price', 'brands', 'aesthetic', 'body']

export function Questionnaire({
  options,
  initial,
  onDone,
  onSkip,
  mode = 'onboard',
}: {
  options: OnboardingOptions
  initial?: OnboardingInput
  onDone: (userId: string | null) => void
  onSkip: () => void
  /** 'edit' relabels the exits — an existing profile is amended, not created. */
  mode?: 'onboard' | 'edit'
}) {
  const [step, setStep] = useState(0)
  const [input, setInput] = useState<OnboardingInput>(
    initial ?? { fiberPreference: 0.5, selectedBrands: [], silhouettePrefs: [], materialPrefs: [] },
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof OnboardingInput>(k: K, v: OnboardingInput[K]) =>
    setInput((p) => ({ ...p, [k]: v }))

  const toggleIn = (key: 'selectedBrands' | 'silhouettePrefs' | 'materialPrefs', v: string) =>
    setInput((p) => {
      const cur = p[key] ?? []
      return { ...p, [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] }
    })

  const has = (key: 'selectedBrands' | 'silhouettePrefs' | 'materialPrefs', v: string) =>
    (input[key] ?? []).includes(v)

  const last = step === STEPS.length - 1

  async function submit() {
    setSaving(true)
    setError(null)
    try {
      onDone(await createUser(input))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your profile')
      setSaving(false)
    }
  }

  function next() {
    if (last) void submit()
    else setStep((s) => s + 1)
  }

  const current = STEPS[step]

  return (
    <div className="gate">
      <div className="gate__head">
        <span className="wordmark">Ink</span>
        <span className="progress" role="progressbar" aria-valuenow={step + 1} aria-valuemin={1} aria-valuemax={STEPS.length}>
          {STEPS.map((s, i) => (
            <span key={s} className={`progress__tick${i <= step ? ' progress__tick--done' : ''}`} />
          ))}
        </span>
      </div>

      <div className="gate__body">
        <div className="gate__inner">
          <div className="step__kicker">
            Question {step + 1} of {STEPS.length}
          </div>

          {current === 'silhouette' && (
            <>
              <h2 className="step__q">Which cut do you reach for?</h2>
              <p className="step__hint">
                Pick as many as you like. This starts your silhouette preference, which every
                search then ranks against — and which shifts as you compare items later.
              </p>
              <div className="tiles">
                {options.silhouettePrefs.map((v) => (
                  <button
                    key={v}
                    className="tile"
                    aria-pressed={has('silhouettePrefs', v)}
                    onClick={() => toggleIn('silhouettePrefs', v)}
                  >
                    <span className="tile__art">{silhouetteArt(v)}</span>
                    <span className="tile__label">
                      {v}
                      <small>{silhouetteGloss(v)}</small>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {current === 'material' && (
            <>
              <h2 className="step__q">Which materials do you prefer?</h2>
              <p className="step__hint">
                A soft boost, never a filter. Worth knowing: this catalog is mostly cotton and
                polyester — linen, silk and wool are genuinely scarce right now, so those answers
                have less to grip on until the catalog grows.
              </p>
              <div className="choices">
                {options.materialPrefs.map((v) => (
                  <button
                    key={v}
                    className="chip"
                    aria-pressed={has('materialPrefs', v)}
                    onClick={() => toggleIn('materialPrefs', v)}
                  >
                    {v}
                  </button>
                ))}
              </div>

              <div className="field" style={{ marginTop: 36 }}>
                <label htmlFor="fiber">Natural fibres overall</label>
                <div className="hint">
                  How much you favour cotton, linen, wool and silk over synthetics.
                </div>
                <div className="rangewrap">
                  <input
                    id="fiber"
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    value={input.fiberPreference ?? 0.5}
                    onChange={(e) => set('fiberPreference', Number(e.target.value))}
                  />
                  <div className="range-ends">
                    <span>synthetics are fine</span>
                    <b>{Math.round((input.fiberPreference ?? 0.5) * 100)}% natural</b>
                    <span>natural only</span>
                  </div>
                </div>
              </div>
            </>
          )}

          {current === 'price' && (
            <>
              <h2 className="step__q">What do you usually spend per item?</h2>
              <p className="step__hint">
                A soft preference. Items outside the range still appear — they just sit lower.
              </p>
              <div className="pricerow">
                <input
                  className="numfield"
                  type="number"
                  min={0}
                  placeholder="min $"
                  aria-label="Minimum price in dollars"
                  value={input.priceMinCents != null ? input.priceMinCents / 100 : ''}
                  onChange={(e) =>
                    set('priceMinCents', e.target.value ? Number(e.target.value) * 100 : null)
                  }
                />
                <span className="u-label">to</span>
                <input
                  className="numfield"
                  type="number"
                  min={0}
                  placeholder="max $"
                  aria-label="Maximum price in dollars"
                  value={input.priceMaxCents != null ? input.priceMaxCents / 100 : ''}
                  onChange={(e) =>
                    set('priceMaxCents', e.target.value ? Number(e.target.value) * 100 : null)
                  }
                />
              </div>
            </>
          )}

          {current === 'brands' && (
            <>
              <h2 className="step__q">Which of these do you actually shop?</h2>
              <p className="step__hint">
                Selected brands start with a head start in your rankings. You can filter by brand
                on any search too — this just sets the default lean.
              </p>
              <div className="choices">
                {options.brands.map((b) => (
                  <button
                    key={b}
                    className="chip"
                    aria-pressed={has('selectedBrands', b)}
                    onClick={() => toggleIn('selectedBrands', b)}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </>
          )}

          {current === 'aesthetic' && (
            <>
              <h2 className="step__q">Which comes closest to your taste?</h2>
              <p className="step__hint">
                Pick one. This reads a garment's pattern, trims and cut — so a sequinned floral and
                a plain crew neck sort very differently depending on your answer.
              </p>
              <div className="tiles">
                {options.aesthetics.map((v) => (
                  <button
                    key={v}
                    className="tile"
                    aria-pressed={input.styleCluster === v}
                    onClick={() => set('styleCluster', input.styleCluster === v ? null : v)}
                  >
                    <span className="tile__art">{aestheticArt(v)}</span>
                    <span className="tile__label">
                      {v}
                      <small>{aestheticGloss(v)}</small>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {current === 'body' && (
            <>
              <h2 className="step__q">A little about proportion</h2>
              <p className="step__hint">
                This is what lets Ink say <em>why</em> something suits you, using rise, hem height
                and waist position read from the product photos. Skip anything you would rather not
                answer — unanswered is treated as neutral, not as a guess.
              </p>

              <Choice
                label="Height and proportion"
                values={options.bodyTypes}
                value={input.bodyType ?? null}
                onPick={(v) => set('bodyType', v)}
              />
              <Choice
                label="Shoulders"
                hint="Affects which necklines and sleeve treatments rank higher."
                values={options.shoulders}
                value={input.shoulders ?? null}
                onPick={(v) => set('shoulders', v)}
              />
              <Choice
                label="Torso length"
                hint="Affects preferred rise and waistline height."
                values={options.torso}
                value={input.torso ?? null}
                onPick={(v) => set('torso', v)}
              />
              <Choice
                label="Waist"
                hint="Affects whether Ink favours defined or relaxed waists."
                values={options.waist}
                value={input.waist ?? null}
                onPick={(v) => set('waist', v)}
              />

              <div className="field">
                <label htmlFor="height">Height in cm</label>
                <div className="hint">Optional. Stored for future sizing guidance.</div>
                <input
                  id="height"
                  className="numfield"
                  type="number"
                  min={120}
                  max={220}
                  value={input.heightCm ?? ''}
                  onChange={(e) => set('heightCm', e.target.value ? Number(e.target.value) : null)}
                />
              </div>
            </>
          )}

          {error && <div className="banner">{error}</div>}

          <div className="step__foot">
            {step > 0 && (
              <button className="btn btn--quiet" onClick={() => setStep((s) => s - 1)} disabled={saving}>
                Back
              </button>
            )}
            <span className="spacer" />
            <button className="btn btn--link" onClick={onSkip} disabled={saving}>
              {mode === 'edit' ? 'Cancel' : 'Skip — search without a profile'}
            </button>
            <button className="btn btn--primary" onClick={next} disabled={saving}>
              {saving ? 'Saving…' : last ? 'Start searching' : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A single-select row. Tapping the active value clears it back to unanswered. */
function Choice({
  label,
  hint,
  values,
  value,
  onPick,
}: {
  label: string
  hint?: string
  values: string[]
  value: string | null
  onPick: (v: string | null) => void
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {hint && <div className="hint">{hint}</div>}
      <div className="choices">
        {values.map((v) => (
          <button
            key={v}
            className="chip"
            aria-pressed={value === v}
            onClick={() => onPick(value === v ? null : v)}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  )
}
