import { Hono } from 'hono'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { IMAGE_STORE, resolveStored } from '../ingest/images.js'

const images = new Hono()

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/**
 * Serve product images from the content-addressed store.
 *
 * Local serving is not a convenience: Aritzia's Cloudinary CDN 403s hotlinked
 * requests, which is why the scrapers download image bytes through the page
 * context at all (`downloadImagesViaPage` in scrapers/src/utils.ts). Pointing the
 * frontend at the original URLs would leave 48 products with broken images.
 */
images.get('/:hash', (c) => {
  const hash = c.req.param('hash')

  // The path is derived from the hash, so a non-hex hash cannot reach the
  // filesystem at all. Belt-and-braces against traversal even so.
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return c.json({ error: 'Invalid image id' }, 400)
  }

  const file = resolveStored(hash)
  if (!file) return c.json({ error: 'Not found' }, 404)

  const resolved = path.resolve(file)
  if (!resolved.startsWith(path.resolve(IMAGE_STORE) + path.sep)) {
    return c.json({ error: 'Not found' }, 404)
  }
  if (!existsSync(resolved)) return c.json({ error: 'Not found' }, 404)

  const stat = statSync(resolved)
  const stream = Readable.toWeb(createReadStream(resolved)) as ReadableStream

  return new Response(stream, {
    headers: {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(stat.size),
      // Content-addressed, so the bytes for a given hash can never change.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})

export default images
