/**
 * Upload the content-addressed image store to S3-compatible object storage.
 *
 *   R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...   (a Cloudflare R2 API token)
 *   R2_BUCKET=fashion-search-ink \
 *   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
 *     pnpm sync:images
 *
 *   pnpm sync:images -- --dry-run   report what would upload, touch nothing
 *   pnpm sync:images -- --force     re-upload everything, skipping the diff
 *
 * Keys are the bare hash with NO extension, and Content-Type is set per object
 * from the source file's extension. That is what makes the public URL derivable
 * from the hash alone — see backend/src/routes/imageUrl.ts. The catalogue stores
 * only the hash, so any scheme that needed the extension would require either a
 * schema change or an existence probe per request.
 *
 * The store is genuinely mixed — 4086 .jpg, 64 .webp, 1 .png at time of writing —
 * so a blanket content type would serve 65 products the wrong MIME type.
 *
 * This replaced an `aws s3 sync` one-liner and then a bash loop over `aws s3api`.
 * Neither survived contact:
 *
 *   - `aws s3 sync` cannot rewrite keys, so it preserves the extensions and
 *     defeats the whole design.
 *   - The bash loop needed a working AWS CLI, which is one more system-level
 *     dependency than a repo that already has Node and a lockfile should carry.
 *     A broken CLI install is what motivated this rewrite.
 *
 * Re-runnable, and cheap to re-run: the bucket is listed once up front and
 * already-present keys are skipped, so an interrupted upload resumes rather than
 * re-sending 736MB. Content-addressed keys can never change meaning, which is
 * what makes presence alone a sufficient check — no etag or mtime comparison.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STORE = path.join(REPO_ROOT, 'output', 'images')

/** Content-addressed bytes never change, so the browser may keep them forever. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

interface Upload {
  /** Absolute path on disk. */
  file: string
  /** Object key: the bare content hash, no extension. */
  key: string
  contentType: string
  bytes: number
}

/** Every file under the sharded store, flattened. The store nests by hash prefix. */
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((e) => {
      const full = path.join(dir, e.name)
      return e.isDirectory() ? walk(full) : Promise.resolve([full])
    }),
  )
  return files.flat()
}

/**
 * Pair each file with the key it will occupy, dropping anything whose extension
 * we cannot set a Content-Type for. Serving an unknown type as
 * application/octet-stream would make the browser download it rather than
 * render it, which is worse than omitting it and saying so.
 */
async function plan(files: string[]): Promise<{ uploads: Upload[]; skipped: string[] }> {
  const uploads: Upload[] = []
  const skipped: string[] = []

  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    const contentType = MIME[ext]
    if (!contentType) {
      skipped.push(path.basename(file))
      continue
    }
    const { size } = await stat(file)
    uploads.push({
      file,
      key: path.basename(file, path.extname(file)),
      contentType,
      bytes: size,
    })
  }

  return { uploads, skipped }
}

/**
 * Keys already in the bucket. One paginated LIST is ~5 requests for this store,
 * versus 4151 HEADs to answer the same question one object at a time.
 */
async function existingKeys(s3: S3Client, bucket: string): Promise<Set<string>> {
  const keys = new Set<string>()
  let token: string | undefined

  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    )
    for (const obj of page.Contents ?? []) if (obj.Key) keys.add(obj.Key)
    token = page.NextContinuationToken
  } while (token)

  return keys
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function pooled<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await worker(item!)
    }
  })
  await Promise.all(runners)
}

function human(bytes: number): string {
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb.toFixed(0)}MB`
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const force = argv.includes('--force')

  const bucket = process.env.R2_BUCKET
  const endpoint = process.env.R2_ENDPOINT
  const parallel = Number(process.env.PARALLEL ?? 16)

  if (!bucket) throw new Error('set R2_BUCKET')
  // Endpoint is optional so this also works against real AWS S3, where the
  // region-derived default endpoint is correct.
  if (!endpoint && !process.env.AWS_REGION) {
    throw new Error('set R2_ENDPOINT (or AWS_REGION, for real AWS S3)')
  }
  // R2 credentials are S3-shaped but issued by Cloudflare, not Amazon. The SDK
  // would pick up AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the environment
  // on its own; naming them R2_* and passing them explicitly keeps them
  // consistent with R2_BUCKET / R2_ENDPOINT and stops the AWS prefix implying an
  // AWS account is involved. The AWS_* names still work as a fallback, which is
  // what lets this run against real S3 or a CI role unchanged.
  const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY
  if (!dryRun && !accessKeyId) {
    throw new Error('set R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (a Cloudflare R2 API token)')
  }

  const files = await walk(STORE).catch(() => {
    throw new Error(`no image store at ${STORE} — run \`pnpm refresh\` first`)
  })
  const { uploads, skipped } = await plan(files)

  // Two files sharing a hash but differing in extension would race for one key
  // and the winner would be arbitrary. Has never happened; loud if it ever does.
  const seen = new Map<string, string>()
  for (const u of uploads) {
    const prior = seen.get(u.key)
    if (prior) {
      throw new Error(`key collision on ${u.key}: ${path.basename(prior)} vs ${path.basename(u.file)}`)
    }
    seen.set(u.key, u.file)
  }

  const s3 = new S3Client({
    // R2 ignores region but the SDK insists on one being set.
    region: process.env.AWS_REGION ?? 'auto',
    ...(endpoint ? { endpoint } : {}),
    // Omitted entirely when unset so the SDK falls back to its own credential
    // chain (shared config file, instance role) rather than sending empty keys.
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
    maxAttempts: 5,
  })

  let pending = uploads
  if (!force && !dryRun) {
    const present = await existingKeys(s3, bucket)
    pending = uploads.filter((u) => !present.has(u.key))
    if (present.size) console.log(`${present.size} objects already in s3://${bucket}`)
  }

  const totalBytes = pending.reduce((n, u) => n + u.bytes, 0)
  console.log(
    `${dryRun ? 'would upload' : 'uploading'} ${pending.length} of ${uploads.length} objects ` +
      `(${human(totalBytes)}) to s3://${bucket}${dryRun ? '' : ` (parallel=${parallel})`}`,
  )
  for (const name of skipped) console.warn(`  skip (unknown type): ${name}`)

  if (dryRun || pending.length === 0) {
    if (!dryRun) console.log('nothing to do — bucket is up to date')
    return
  }

  const failures: { key: string; error: string }[] = []
  let done = 0
  const started = Date.now()

  await pooled(pending, parallel, async (u) => {
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: u.key,
          Body: await readFile(u.file),
          ContentType: u.contentType,
          CacheControl: CACHE_CONTROL,
        }),
      )
    } catch (err) {
      failures.push({ key: u.key, error: err instanceof Error ? err.message : String(err) })
    }
    done++
    // Progress on one rewritten line: 4151 lines of output buries the summary.
    if (done % 25 === 0 || done === pending.length) {
      process.stdout.write(`\r  ${done}/${pending.length}`)
    }
  })

  process.stdout.write('\n')
  const secs = (Date.now() - started) / 1000
  console.log(`uploaded ${pending.length - failures.length} objects in ${secs.toFixed(0)}s`)

  if (failures.length) {
    console.error(`\n${failures.length} failed — re-run to retry just these:`)
    for (const f of failures.slice(0, 10)) console.error(`  ${f.key}: ${f.error}`)
    if (failures.length > 10) console.error(`  ... and ${failures.length - 10} more`)
    process.exitCode = 1
  }
}

await main()
