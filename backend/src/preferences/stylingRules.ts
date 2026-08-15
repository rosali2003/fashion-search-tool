/**
 * Body proportion -> garment geometry.
 *
 * This file is where the styling intelligence lives, and it deliberately lives
 * here rather than inside the vision extraction prompt. Vision extraction is
 * cached per *product*; preferences are per *user*. Putting "this shopper has
 * short legs" into the extraction prompt would make the cache key
 * (product, user), which means re-extracting the whole catalog for every signup
 * and destroying the content-hash cache that makes a daily refresh affordable.
 *
 * So extraction records observable geometry (v_rise, v_hem_break,
 * v_shoulder_treatment, ...) and this file interprets it. The split has three
 * further advantages: the rules are one editable file, changing one costs nothing
 * because no re-extraction is needed, and each rule carries a `because` string
 * that becomes the user-facing explanation on the result card.
 *
 * A NOTE ON WHAT THESE ARE. These encode conventional styling advice, not fact.
 * "High rise elongates the leg line" is a widely-taught heuristic that plenty of
 * people reasonably disagree with. They are kept in one reviewable place, shown to
 * the user as the reason a garment was surfaced, and progressively overridden by
 * the ELO layer as the user's actual choices accumulate. Nothing here should be
 * presented as authoritative.
 */

/** The declared body profile from onboarding. All fields optional. */
export interface BodyProfile {
  height_cm?: number | null
  body_type?: string | null
  shoulders?: string | null
  torso?: string | null
  waist?: string | null
}

/** Garment geometry as extracted from images. */
export interface Geometry {
  v_rise?: string | null
  v_waist_position?: string | null
  v_hem_break?: string | null
  v_shoulder_treatment?: string | null
  v_neckline_width?: string | null
  v_volume?: string | null
  v_vertical_line?: string | null
  v_waist_definition?: string | null
  v_drape?: string | null
  v_structure?: string | null
  /** Text-derived facets the rules can also key on. */
  rise?: string | null
  length?: string | null
  neckline?: string | null
  details?: string[]
  silhouette?: string | null
}

type GeometryKey = keyof Geometry

export interface StylingRule {
  id: string
  /** Matches when every stated condition holds on the profile. */
  when: Partial<Record<keyof BodyProfile, string>>
  /** Geometry values that satisfy this rule. */
  prefer?: Partial<Record<GeometryKey, string[]>>
  /** Geometry values that work against it. */
  avoid?: Partial<Record<GeometryKey, string[]>>
  /** Shown to the user as the reason a garment suits them. Keep it plain. */
  because: string
}

export const STYLING_RULES: readonly StylingRule[] = [
  {
    id: 'petite-leg-line',
    when: { body_type: 'petite' },
    prefer: {
      v_rise: ['high'], rise: ['high-rise'],
      v_hem_break: ['mini', 'above-knee', 'midi'],
      v_vertical_line: ['continuous'],
      length: ['mini', 'midi', 'cropped'],
    },
    avoid: {
      v_waist_position: ['dropped'],
      v_volume: ['voluminous'],
      v_hem_break: ['floor'],
    },
    because: 'high rise and an unbroken vertical line lengthen the leg line',
  },
  {
    id: 'tall-proportion',
    when: { body_type: 'tall' },
    prefer: {
      v_hem_break: ['ankle', 'floor', 'mid-calf'],
      length: ['maxi', 'longline', 'ankle'],
      v_volume: ['relaxed', 'voluminous'],
      silhouette: ['wide-leg'],
    },
    avoid: { v_hem_break: ['above-knee'] },
    because: 'full-length hems and relaxed volume suit a longer frame',
  },
  {
    id: 'wide-shoulders-balance',
    when: { shoulders: 'wide' },
    prefer: {
      v_shoulder_treatment: ['halter', 'strap', 'raglan'],
      v_neckline_width: ['narrow-v', 'deep-v'],
      neckline: ['v-neck', 'plunge', 'halter', 'scoop'],
    },
    avoid: {
      v_shoulder_treatment: ['off-shoulder', 'puff', 'structured'],
      v_neckline_width: ['boat'],
      neckline: ['boat', 'off-shoulder'],
      details: ['puff-sleeve'],
    },
    because: 'a halter or narrow V draws the eye inward and balances shoulder width',
  },
  {
    id: 'narrow-shoulders-structure',
    when: { shoulders: 'narrow' },
    prefer: {
      v_shoulder_treatment: ['structured', 'puff', 'set-in'],
      v_neckline_width: ['boat', 'wide-scoop'],
      neckline: ['boat', 'square', 'off-shoulder'],
      details: ['puff-sleeve'],
    },
    avoid: { v_shoulder_treatment: ['halter'] },
    because: 'a wider neckline and some shoulder structure broaden a narrow shoulder line',
  },
  {
    id: 'long-torso-waist-lift',
    when: { torso: 'long' },
    prefer: {
      v_rise: ['high'], rise: ['high-rise'],
      v_waist_position: ['above-natural'],
    },
    avoid: { v_waist_position: ['dropped'], rise: ['low-rise'] },
    because: 'raising the waistline evens out torso-to-leg proportion',
  },
  {
    id: 'short-torso-lengthen',
    when: { torso: 'short' },
    prefer: {
      v_rise: ['mid', 'low'], rise: ['mid-rise', 'low-rise'],
      v_waist_position: ['natural', 'dropped'],
      v_neckline_width: ['narrow-v', 'deep-v'],
    },
    avoid: { v_rise: ['high'] },
    because: 'a lower waistline and a deeper neckline give a short torso more length',
  },
  {
    id: 'undefined-waist-shape',
    when: { waist: 'undefined' },
    prefer: {
      v_waist_definition: ['defined', 'semi-defined'],
      details: ['belted', 'ruched', 'smocked', 'self-tie'],
      silhouette: ['wrap', 'a-line', 'fit-and-flare'],
    },
    avoid: { v_waist_definition: ['undefined'], silhouette: ['shift', 'boxy'] },
    because: 'a defined or wrapped waist creates shape through the middle',
  },
  {
    id: 'defined-waist-showcase',
    when: { waist: 'defined' },
    prefer: {
      v_waist_definition: ['defined'],
      v_rise: ['high'],
      silhouette: ['bodycon', 'sheath', 'wrap'],
    },
    avoid: { v_volume: ['voluminous'], silhouette: ['shift'] },
    because: 'a fitted waist shows off a naturally defined waistline',
  },
  {
    id: 'curvy-drape',
    when: { body_type: 'curvy' },
    prefer: {
      v_drape: ['fluid', 'structured'],
      v_waist_definition: ['defined'],
      silhouette: ['wrap', 'a-line', 'sheath'],
      neckline: ['v-neck', 'scoop', 'plunge'],
    },
    avoid: { v_drape: ['clingy'], v_volume: ['voluminous'] },
    because: 'fluid drape over a defined waist follows curves without clinging',
  },
  {
    id: 'straight-create-shape',
    when: { body_type: 'straight' },
    prefer: {
      details: ['ruched', 'belted', 'peplum', 'smocked'],
      silhouette: ['a-line', 'wrap'],
      v_waist_definition: ['defined', 'semi-defined'],
    },
    because: 'ruching and a defined waist create shape on a straighter frame',
  },
  {
    id: 'athletic-soften',
    when: { body_type: 'athletic' },
    prefer: {
      v_drape: ['fluid'],
      details: ['ruffle', 'ruched', 'lace-trim'],
      neckline: ['v-neck', 'sweetheart', 'scoop'],
    },
    avoid: { v_shoulder_treatment: ['structured'] },
    because: 'softer drape and detail balance an athletic shoulder line',
  },
]

export interface RuleMatch {
  rule: StylingRule
  /** -1..1. Positive when the garment satisfies the rule, negative when it fights it. */
  score: number
}

const has = (geo: Geometry, key: GeometryKey, values: string[]): boolean => {
  const v = geo[key]
  if (v == null) return false
  if (Array.isArray(v)) return v.some((x) => values.includes(x))
  return values.includes(v)
}

/** Rules that apply to this profile, regardless of any particular garment. */
export function rulesFor(profile: BodyProfile): StylingRule[] {
  return STYLING_RULES.filter((rule) =>
    Object.entries(rule.when).every(
      ([field, want]) => profile[field as keyof BodyProfile] === want,
    ),
  )
}

/**
 * Score one garment against the rules that apply to a profile.
 *
 * Returns a value in 0..1 for use in the affinity blend, plus the individual
 * matches so the strongest rule's `because` can be shown as the reason. A garment
 * that no rule speaks to scores the neutral 0.5 rather than 0 — silence is not
 * disapproval, and scoring it 0 would push every unphotographed product to the
 * bottom.
 */
export function stylingFit(
  profile: BodyProfile,
  geo: Geometry,
): { score: number; matches: RuleMatch[] } {
  const applicable = rulesFor(profile)
  if (applicable.length === 0) return { score: 0.5, matches: [] }

  const matches: RuleMatch[] = []
  let sum = 0
  let counted = 0

  for (const rule of applicable) {
    let hits = 0
    let misses = 0

    for (const [key, values] of Object.entries(rule.prefer ?? {})) {
      if (has(geo, key as GeometryKey, values as string[])) hits++
    }
    for (const [key, values] of Object.entries(rule.avoid ?? {})) {
      if (has(geo, key as GeometryKey, values as string[])) misses++
    }

    // No geometry spoke to this rule at all: contributes nothing rather than
    // counting as a miss, so products awaiting vision extraction are not punished.
    if (hits === 0 && misses === 0) continue

    const score = (hits - misses) / Math.max(1, hits + misses)
    matches.push({ rule, score })
    sum += score
    counted++
  }

  if (counted === 0) return { score: 0.5, matches: [] }

  // Map mean rule score from -1..1 onto 0..1.
  const mean = sum / counted
  matches.sort((a, b) => b.score - a.score)
  return { score: (mean + 1) / 2, matches }
}

/** Guidance lines for the rerank prompt. */
export function guidanceFor(profile: BodyProfile): string[] {
  return rulesFor(profile).map((r) => {
    const prefer = Object.values(r.prefer ?? {}).flat().slice(0, 5).join(', ')
    const avoid = Object.values(r.avoid ?? {}).flat().slice(0, 4).join(', ')
    const parts = [r.because]
    if (prefer) parts.push(`prefer: ${prefer}`)
    if (avoid) parts.push(`avoid: ${avoid}`)
    return parts.join(' — ')
  })
}

/** The best positive rule for a garment, for the user-facing reason line. */
export function bestReason(matches: RuleMatch[]): string | null {
  const top = matches.find((m) => m.score > 0)
  return top ? top.rule.because : null
}
