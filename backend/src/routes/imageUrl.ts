/**
 * Where a product image is served from.
 *
 * The catalogue stores only the content hash, never the file extension —
 * `resolveStored` in ingest/images.ts probes jpg/jpeg/png/webp against the disk
 * to find the actual file. That probe is fine locally and impossible against
 * object storage, so images are uploaded under a key that is *just the hash*
 * with the Content-Type set as object metadata. The URL is then derivable from
 * the hash alone, which is what makes this function a pure string build with no
 * filesystem or network lookup.
 *
 * The store is genuinely mixed — 4086 .jpg, 64 .webp, 1 .png — so a scheme that
 * assumed ".jpg" would quietly break 65 products.
 */
const CDN_BASE = process.env.IMAGE_CDN_BASE?.trim().replace(/\/+$/, '')

/**
 * Absolute CDN URL when IMAGE_CDN_BASE is set, otherwise the origin-relative
 * path served by routes/images.ts off local disk.
 *
 * Keeping the local path as the fallback is what lets development, the eval
 * harness and a container without object storage all keep working unchanged:
 * unset the variable and the behaviour is exactly what it was before.
 */
export function imageUrlFor(hashes: readonly string[]): string | null {
  const hash = hashes[0]
  if (!hash) return null
  return CDN_BASE ? `${CDN_BASE}/${hash}` : `/api/images/${hash}`
}
