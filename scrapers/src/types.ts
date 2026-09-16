export interface ScrapedProduct {
  brand: string
  name: string
  description: string | null
  material: string | null
  price_cents: number | null
  product_url: string
  image_urls: string[]        // all gallery image URLs (original CDN)
  local_image_paths: string[] // downloaded copies on disk
  scraped_at: string

  // ── Fit data ────────────────────────────────────────────────────────────────
  // All optional so historical run directories, which predate these fields, still
  // ingest cleanly.
  //
  // These exist because the scraped text contained *no* sizing signal at all:
  // measured across all 298 products, 0 mentioned petite or tall, 0 carried model
  // measurements, and 0 had a size range. The onboarding questionnaire asks for
  // height and body proportion, and without these fields those answers can only be
  // matched against garment geometry inferred from photographs — never against
  // what the brand actually publishes.
  size_range?: string[]           // e.g. ['XXS','XS','S','M','L','XL']
  model_height_cm?: number | null // parsed from "Model is 5'9\""
  model_size?: string | null      // the size the model is wearing
  fit_notes?: string | null       // free text: "Relaxed fit. Falls at mid-thigh."
}

/** "5'9"" / "175cm" / "175 cm" -> centimetres. Null when unparseable. */
export function parseHeightCm(text: string | null | undefined): number | null {
  if (!text) return null

  const metric = text.match(/(\d{3})\s*cm/i)
  if (metric) {
    const cm = Number(metric[1])
    return cm >= 120 && cm <= 220 ? cm : null
  }

  // Feet and inches, with the many apostrophe characters retail copy uses.
  const imperial = text.match(/(\d)\s*['’′]\s*(\d{1,2})?\s*(?:["”″]|''|in\b)?/)
  if (imperial) {
    const feet = Number(imperial[1])
    const inches = imperial[2] ? Number(imperial[2]) : 0
    if (feet < 4 || feet > 7 || inches > 11) return null
    return Math.round((feet * 12 + inches) * 2.54)
  }
  return null
}

/**
 * Normalise a size label to the shape the app expects.
 *
 * Returns null for anything that is not a recognisable size, so numeric SKUs and
 * colour codes cannot leak into `size_range`.
 */
export function normalizeSize(raw: unknown): string | null {
  // Not `string`, because these payloads are external and change shape without
  // notice. Uniqlo's size `display` field turned from a label into an object
  // ({showFlag, chipType}) and the whole brand died on `raw.trim is not a
  // function` — a crash, mid-crawl, from one upstream field. Numbers are coerced
  // because a numeric size is a real size; everything else is simply not one.
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '')
  if (!s) return null
  if (/^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL)$/.test(s)) return s
  // Numeric sizes (waist, dress size) and ranges like "28X32".
  //
  // Three digits, not two. Reformation's US dress sizes are zero-padded — 000,
  // 002, 004, 006 — so a two-digit bound silently dropped every size the brand
  // publishes. The SKU and colour-code rejections below still hold because those
  // are never bare digits: they carry a letter or a separator.
  if (/^\d{1,3}(X\d{1,2})?$/.test(s)) return s
  if (/^(ONESIZE|OS|FREE|F)$/.test(s)) return 'ONE SIZE'
  return null
}

export function normalizeSizes(raw: readonly unknown[]): string[] {
  const out: string[] = []
  for (const r of raw) {
    const n = normalizeSize(r)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}
