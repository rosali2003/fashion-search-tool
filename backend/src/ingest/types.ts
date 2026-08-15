/**
 * The scraper output contract.
 *
 * Deliberately redeclared rather than imported from `scrapers/src/types.ts`.
 * Adding a workspace dependency on the scrapers package would pull Playwright
 * into the backend's dependency graph — a ~500 MB browser download for a
 * nine-field interface — and the package has no `exports` map, so resolving it
 * across NodeNext without a build step is fragile. The duplication is paid for
 * by `validateScraped` below, which fails loudly the moment the shapes drift,
 * rather than silently writing nulls.
 */
export interface ScrapedProduct {
  brand: string
  name: string
  description: string | null
  material: string | null
  price_cents: number | null
  product_url: string
  image_urls: string[]
  local_image_paths: string[]
  scraped_at: string

  // Added by the scraper fit-data extension. Optional so historical runs, which
  // predate these fields, still ingest cleanly.
  size_range?: string[]
  model_height_cm?: number | null
  model_size?: string | null
  fit_notes?: string | null
  image_hashes?: string[]
}

export class ScrapeShapeError extends Error {}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * Runtime shape check. Returns the product, or throws with enough context to
 * identify which record in which file is malformed.
 */
export function validateScraped(raw: unknown, where: string): ScrapedProduct {
  if (typeof raw !== 'object' || raw === null) {
    throw new ScrapeShapeError(`${where}: not an object`)
  }
  const p = raw as Record<string, unknown>

  for (const key of ['brand', 'name', 'product_url'] as const) {
    if (typeof p[key] !== 'string' || !(p[key] as string).trim()) {
      throw new ScrapeShapeError(`${where}: missing required string "${key}"`)
    }
  }
  for (const key of ['description', 'material'] as const) {
    if (p[key] !== null && typeof p[key] !== 'string') {
      throw new ScrapeShapeError(`${where}: "${key}" must be string or null`)
    }
  }
  if (p.price_cents !== null && typeof p.price_cents !== 'number') {
    throw new ScrapeShapeError(`${where}: "price_cents" must be number or null`)
  }
  if (!isStringArray(p.image_urls)) {
    throw new ScrapeShapeError(`${where}: "image_urls" must be string[]`)
  }
  if (!isStringArray(p.local_image_paths)) {
    throw new ScrapeShapeError(`${where}: "local_image_paths" must be string[]`)
  }
  if (typeof p.scraped_at !== 'string') {
    throw new ScrapeShapeError(`${where}: "scraped_at" must be a string`)
  }

  return p as unknown as ScrapedProduct
}
