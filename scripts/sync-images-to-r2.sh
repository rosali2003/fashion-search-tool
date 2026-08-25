#!/usr/bin/env bash
#
# Upload the content-addressed image store to S3-compatible object storage.
#
# Keys are the bare hash with NO extension, and Content-Type is set per object
# from the source file's extension. That is what makes the public URL derivable
# from the hash alone — see backend/src/routes/imageUrl.ts. The catalogue stores
# only the hash, so any scheme that needed the extension would require either a
# schema change or an existence probe per request.
#
# `aws s3 sync` cannot do this: it has no way to rewrite keys, so it would
# preserve the extensions and defeat the whole design. Hence an explicit loop,
# parallelised with xargs.
#
# The store is genuinely mixed — 4086 .jpg, 64 .webp, 1 .png at time of writing —
# so a blanket --content-type would serve 65 products with the wrong MIME type.
#
# Usage:
#   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
#   R2_BUCKET=ink-images \
#   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
#     scripts/sync-images-to-r2.sh
#
# Re-runnable: uploads are idempotent overwrites, so a partial run just needs
# running again. Content-addressed keys can never change meaning.
set -euo pipefail

: "${R2_BUCKET:?set R2_BUCKET}"
: "${R2_ENDPOINT:?set R2_ENDPOINT (omit for real AWS S3)}"

STORE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/output/images"
PARALLEL="${PARALLEL:-16}"

[ -d "$STORE" ] || { echo "no image store at $STORE" >&2; exit 1; }

total=$(find "$STORE" -type f | wc -l | tr -d ' ')
echo "uploading $total objects from $STORE to s3://$R2_BUCKET (parallel=$PARALLEL)"

export R2_BUCKET R2_ENDPOINT

find "$STORE" -type f -print0 | xargs -0 -P "$PARALLEL" -I{} bash -c '
  file="$1"
  base="$(basename "$file")"
  hash="${base%.*}"
  case "${base##*.}" in
    jpg|jpeg) ct="image/jpeg" ;;
    png)      ct="image/png"  ;;
    webp)     ct="image/webp" ;;
    *)        echo "skip (unknown type): $base" >&2; exit 0 ;;
  esac
  aws s3api put-object \
    --endpoint-url "$R2_ENDPOINT" \
    --bucket "$R2_BUCKET" \
    --key "$hash" \
    --body "$file" \
    --content-type "$ct" \
    --cache-control "public, max-age=31536000, immutable" \
    >/dev/null
' _ {}

echo "done. set IMAGE_CDN_BASE to the bucket public URL and redeploy the backend."
