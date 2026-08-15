/**
 * Regex builders for the attribute rules.
 *
 * These exist because hand-written alternations in this codebase produced two
 * classes of silent bug, both caught only by reading the ingested facets:
 *
 *   1. Alternation binds looser than \b, so `/\bmini|micro\b/` parses as
 *      `(\bmini)|(micro\b)` — the leading boundary applies only to the first
 *      branch and the trailing boundary only to the last. It matched
 *      "minimalist", which is how 100%-cotton gauze *pants* acquired
 *      `length = mini`. Same defect made `/\bred|crimson\b/` match "reduced".
 *
 *   2. \b after a singular noun cannot match the plural: `\bshort\b` does not
 *      match "Shorts", because the boundary it needs is occupied by the s. Every
 *      plural product name silently fell through to a later, wronger rule —
 *      "3\" Low Rise Denim Shorts" ended up classified as an accessory.
 *
 * Always build patterns with `w` or `wp` rather than writing the literal regex,
 * so both boundaries are always present and grouping is never ambiguous.
 */

/** `\b(?:a|b|c)\b` — exact word match with both boundaries, properly grouped. */
export function w(...alts: string[]): RegExp {
  return new RegExp(`\\b(?:${alts.join('|')})\\b`, 'i')
}

/**
 * `\b(?:a|b|c)s?\b` — as `w`, but tolerates a trailing plural s.
 *
 * Use for garment nouns and anything else that appears in both numbers in
 * product names ("Short"/"Shorts", "Legging"/"Leggings").
 */
export function wp(...alts: string[]): RegExp {
  return new RegExp(`\\b(?:${alts.join('|')})s?\\b`, 'i')
}
