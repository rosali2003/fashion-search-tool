export interface SearchResult {
  id: number
  brand: string
  name: string
  price_cents: number | null
  /** Short label for the pill. Null means unknown — render nothing, not "unknown". */
  material_badge: string | null
  material_full: string | null
  image_url: string | null
  product_url: string
  attributes: string[]
  /** Why it matched the query. Null when the reranker was unavailable. */
  reason: string | null
  /** Why it suits this shopper, from the styling rules. Null when anonymous. */
  styling_reason: string | null
  /** Why it fits the shopper's declared aesthetic. Null when Q5 was skipped. */
  aesthetic_reason: string | null
}

export interface AuthSession {
  googleEnabled: boolean
  emailEnabled: boolean
  linkingEmail: string | null
  user: { id: string; name: string | null; authenticated: boolean } | null
}

export interface SearchMeta {
  /** Stage names that fell back, e.g. ['expansion','rerank']. Empty when healthy. */
  degraded: string[]
  took_ms: number
  total_candidates: number
  personalized?: boolean
  empty_reason?: 'no_matches' | 'blank_query'
  /** Set on an empty result set when brand filters were applied. */
  would_match_without_filters?: number
  /**
   * How many leading results were actually judged. Past this index the list is
   * raw BM25 order, and the UI says so rather than implying it was all curated.
   */
  curated_count?: number
  page_size?: number
}

export interface SearchResponse {
  results: SearchResult[]
  meta: SearchMeta
}

export interface OnboardingOptions {
  brands: string[]
  bodyTypes: string[]
  shoulders: string[]
  torso: string[]
  waist: string[]
  qualityTiers: string[]
  /** Q1, Q2 and Q5 of the style questionnaire. */
  silhouettePrefs: string[]
  materialPrefs: string[]
  aesthetics: string[]
  stableAfterComparisons: number
}

export interface Profile {
  body: {
    height_cm: number | null
    body_type: string | null
    shoulders: string | null
    torso: string | null
    waist: string | null
  }
  fiberPreference: number | null
  qualityTier: string | null
  priceMinCents: number | null
  priceMaxCents: number | null
  excludedBrands: string[]
  brands: { brand: string; score: number }[]
  materialPref: Record<string, number>
  silhouettePref: Record<string, number>
  styleCluster: string | null
  comparisonsCount: number
  profileStable: boolean
}

export interface PairItem {
  id: number
  brand: string
  name: string
  price_cents: number | null
  material_badge: string | null
  image_url: string | null
}

export interface OnboardingInput {
  displayName?: string | null
  heightCm?: number | null
  bodyType?: string | null
  shoulders?: string | null
  torso?: string | null
  waist?: string | null
  fiberPreference?: number | null
  qualityTier?: string | null
  priceMinCents?: number | null
  priceMaxCents?: number | null
  selectedBrands?: string[]
  excludedBrands?: string[]
  /** Q1 and Q2, in the questionnaire's vocabulary. Mapped to catalog values server-side. */
  silhouettePrefs?: string[]
  materialPrefs?: string[]
  /** Q5. */
  styleCluster?: string | null
}
