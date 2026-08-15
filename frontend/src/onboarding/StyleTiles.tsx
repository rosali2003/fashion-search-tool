/**
 * Artwork for the two picture-grid questions, Q1 (silhouette) and Q5 (aesthetic).
 *
 * Drawn rather than photographed, deliberately. A photograph of a real garment
 * standing in for "relaxed" gets read as "I want that item", not as the category
 * it represents — and the catalog rotates, so the exemplar would go out of stock
 * and quietly become a picture of nothing.
 *
 * The silhouettes are the same garment at four cuts, sharing a neckline and hem
 * height so the only thing that varies between tiles is the thing being asked
 * about.
 */

const INK = '#111110'
const SOFT = '#c9c6c0'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 80 100" role="presentation" aria-hidden="true">
      {children}
    </svg>
  )
}

/* ---------- Q1 · silhouette ---------------------------------------------- */

const SILHOUETTE_ART: Record<string, JSX.Element> = {
  // Narrow through the body, waist drawn in, hem close to the leg.
  fitted: (
    <Frame>
      <path
        d="M34 20 L28 27 L30 56 L31 86 L49 86 L50 56 L52 27 L46 20 Z"
        fill="none"
        stroke={INK}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M34 20 Q40 25 46 20" fill="none" stroke={INK} strokeWidth="1.6" />
      <path d="M30 56 Q40 59 50 56" fill="none" stroke={SOFT} strokeWidth="1.2" />
    </Frame>
  ),
  // Skims rather than follows: same shoulder, straighter line through the waist.
  relaxed: (
    <Frame>
      <path
        d="M34 20 L26 28 L27 57 L26 86 L54 86 L53 57 L54 28 L46 20 Z"
        fill="none"
        stroke={INK}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M34 20 Q40 25 46 20" fill="none" stroke={INK} strokeWidth="1.6" />
    </Frame>
  ),
  // Dropped shoulder and a boxy body — the shoulder seam sits lower on purpose.
  oversized: (
    <Frame>
      <path
        d="M33 20 L20 32 L21 58 L20 86 L60 86 L59 58 L60 32 L47 20 Z"
        fill="none"
        stroke={INK}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M33 20 Q40 25 47 20" fill="none" stroke={INK} strokeWidth="1.6" />
      <path d="M20 32 L27 34 M60 32 L53 34" stroke={SOFT} strokeWidth="1.2" />
    </Frame>
  ),
  // Square shoulder, defined waist, hem swings out. Holds its own shape.
  structured: (
    <Frame>
      <path
        d="M33 20 L26 24 L27 30 L30 55 L22 86 L58 86 L50 55 L53 30 L54 24 L47 20 Z"
        fill="none"
        stroke={INK}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M33 20 Q40 25 47 20" fill="none" stroke={INK} strokeWidth="1.6" />
      <path d="M26 24 L54 24" stroke={SOFT} strokeWidth="1.2" />
    </Frame>
  ),
}

/* ---------- Q5 · aesthetic ------------------------------------------------ */

const AESTHETIC_ART: Record<string, JSX.Element> = {
  // One field, nothing applied to it.
  minimal: (
    <Frame>
      <rect x="22" y="22" width="36" height="56" fill={INK} opacity="0.9" />
    </Frame>
  ),
  // Even stripes and a placket: the vocabulary of traditional shirting.
  classic: (
    <Frame>
      <rect x="22" y="22" width="36" height="56" fill="none" stroke={INK} strokeWidth="1.4" />
      {[30, 38, 46, 54, 62, 70].map((y) => (
        <line key={y} x1="22" y1={y} x2="58" y2={y} stroke={INK} strokeWidth="1.4" opacity="0.75" />
      ))}
      <line x1="40" y1="22" x2="40" y2="78" stroke="#faf9f7" strokeWidth="4" />
      <line x1="40" y1="22" x2="40" y2="78" stroke={INK} strokeWidth="1.2" />
      {[30, 44, 58, 72].map((y) => (
        <circle key={y} cx="40" cy={y} r="1.5" fill={INK} />
      ))}
    </Frame>
  ),
  // Soft, irregular, unfussy — a knit rib rather than a woven grid.
  casual: (
    <Frame>
      <rect x="22" y="22" width="36" height="56" fill="none" stroke={INK} strokeWidth="1.4" />
      {[27, 32, 37, 42, 47, 52].map((x) => (
        <path
          key={x}
          d={`M${x} 22 Q${x + 2} 50 ${x} 78`}
          fill="none"
          stroke={INK}
          strokeWidth="1.2"
          opacity="0.55"
        />
      ))}
    </Frame>
  ),
  // Several things at once, none of them matching.
  eclectic: (
    <Frame>
      <rect x="22" y="22" width="18" height="28" fill={INK} opacity="0.9" />
      <rect x="40" y="22" width="18" height="28" fill="none" stroke={INK} strokeWidth="1.3" />
      {[26, 32, 38, 44].map((y) => (
        <line key={y} x1="40" y1={y} x2="58" y2={y} stroke={INK} strokeWidth="1.3" />
      ))}
      <circle cx="31" cy="64" r="9" fill="none" stroke={INK} strokeWidth="1.3" />
      <circle cx="31" cy="64" r="3.5" fill={INK} />
      <path
        d="M40 78 L49 50 L58 78 Z"
        fill="none"
        stroke={INK}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </Frame>
  ),
}

/**
 * One-line gloss under each tile label.
 *
 * These describe what the choice *does to results*, not what the word means in
 * fashion generally — the answer only earns its place in the questionnaire
 * because it changes ranking, so the copy says how.
 */
const SILHOUETTE_GLOSS: Record<string, string> = {
  fitted: 'follows the body',
  relaxed: 'skims, not clings',
  oversized: 'dropped shoulder, roomy',
  structured: 'holds its own shape',
}

const AESTHETIC_GLOSS: Record<string, string> = {
  minimal: 'solids, no ornament',
  classic: 'shirting, natural fibre',
  casual: 'easy, everyday cotton',
  eclectic: 'pattern and detail',
}

export function silhouetteArt(value: string): JSX.Element | null {
  return SILHOUETTE_ART[value] ?? null
}
export function aestheticArt(value: string): JSX.Element | null {
  return AESTHETIC_ART[value] ?? null
}
export function silhouetteGloss(value: string): string | undefined {
  return SILHOUETTE_GLOSS[value]
}
export function aestheticGloss(value: string): string | undefined {
  return AESTHETIC_GLOSS[value]
}
