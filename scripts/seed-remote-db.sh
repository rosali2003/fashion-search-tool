#!/usr/bin/env bash
#
# Copy the local catalogue into a remote ParadeDB.
#
# Re-ingesting is not an equivalent alternative. `pnpm ingest` is Phase A only
# (deterministic normalisation) and drops every LLM-extracted facet; `pnpm
# enrich` regenerates them by re-spending real money. Restoring keeps the
# vision-extracted products exactly as they are, and compresses to ~0.5MB.
#
# Handles both orders of operations, because Railway runs migrations itself as a
# pre-deploy command and there is no way to guarantee whether that happens before
# or after a human runs this:
#
#   empty target      -> full restore: schema + data + the kysely_migration
#                        ledger. A later `migrate` then finds all eight applied
#                        and no-ops.
#   migrated, no data -> data-only restore. The schema is already correct and
#                        recreating it would collide, so only rows are copied.
#   already has data   -> refuse, and say how to reset deliberately.
#
# Both pg_dump and psql run inside the local container so their versions match
# the source server exactly and nothing need be installed on the host.
#
# Usage:
#   scripts/seed-remote-db.sh 'postgres://postgres:PASS@HOST:PORT/railway'
#
# Must be the PUBLIC proxy URL — a .railway.internal host only resolves from
# inside Railway's own network, not from your laptop.
set -euo pipefail

TARGET="${1:?usage: seed-remote-db.sh <target-database-url>}"
CONTAINER="${CONTAINER:-ink-postgres}"
SRC_DB="${SRC_DB:-ink}"

case "$TARGET" in
  *.railway.internal*)
    echo "error: that is the PRIVATE url and only resolves inside Railway." >&2
    echo "       use the public proxy url (…proxy.rlwy.net:PORT)." >&2
    exit 1 ;;
esac

# The dump and restore both run inside the local container, so a target of
# "localhost" would mean the container itself rather than the host machine.
# Rewrite it, otherwise the failure surfaces as a confusing connection refusal.
case "$TARGET" in
  *@localhost:*|*@127.0.0.1:*)
    TARGET="${TARGET/@localhost:/@host.docker.internal:}"
    TARGET="${TARGET/@127.0.0.1:/@host.docker.internal:}"
    echo "note: rewrote localhost -> host.docker.internal for in-container access" ;;
esac

docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  echo "error: local container '$CONTAINER' is not running." >&2
  echo "       start it with: docker compose up -d" >&2
  exit 1
}

in_target() { docker exec -i "$CONTAINER" psql "$TARGET" -tAc "$1" 2>&1; }

echo "==> source: $CONTAINER/$SRC_DB"
docker exec -i "$CONTAINER" psql -U postgres -d "$SRC_DB" -tAc \
  "select '    active products: ' || count(*) from products where is_active"

# Reachability and state are separate questions; a failed query must not be
# reported as an unreachable host.
echo "==> probing target"
probe=$(in_target "select 1" || true)
if [ "$probe" != "1" ]; then
  echo "error: cannot reach the target database." >&2
  echo "       psql said: $probe" >&2
  exit 1
fi

# State is decided by whether OUR schema exists, not by a raw table count.
# A managed Postgres arrives with extension-provided tables and views already in
# `public` — PostGIS contributes geometry_columns/geography_columns/
# spatial_ref_sys, pg_stat_statements two more — so counting everything reports
# a non-empty database and sends a genuinely empty one down the data-only path,
# which then fails on a table that was never created.
has_products=$(in_target "select count(*) from information_schema.tables where table_schema='public' and table_name='products'")
rows=0
if [ "$has_products" = "1" ]; then
  rows=$(in_target "select count(*) from products")
fi
echo "    target: products table $([ "$has_products" = "1" ] && echo present || echo absent), $rows product rows"

if [ "${rows:-0}" -gt 0 ]; then
  echo "error: target already holds $rows products; refusing to double-seed." >&2
  echo "       to reset deliberately:" >&2
  echo "         psql \"\$TARGET\" -c 'drop schema public cascade; create schema public;'" >&2
  exit 1
fi

if [ "$has_products" != "1" ]; then
  echo "==> no application schema: restoring schema + data + migration ledger"
  docker exec -i "$CONTAINER" pg_dump -U postgres -d "$SRC_DB" --no-owner --no-acl \
    | docker exec -i "$CONTAINER" psql "$TARGET" -v ON_ERROR_STOP=1 -q
else
  echo "==> target already migrated: restoring data only"
  # --disable-triggers defers FK checks, so table restore order cannot matter.
  docker exec -i "$CONTAINER" pg_dump -U postgres -d "$SRC_DB" \
      --data-only --no-owner --no-acl --disable-triggers \
      --exclude-table=kysely_migration --exclude-table=kysely_migration_lock \
    | docker exec -i "$CONTAINER" psql "$TARGET" -v ON_ERROR_STOP=1 -q
fi

echo "==> verifying"
for check in \
  "active products:select count(*) from products where is_active" \
  "vision-enriched:select count(*) from products where v_rise is not null or v_drape is not null" \
  "migrations applied:select count(*) from kysely_migration" \
  "bm25 index:select count(*) from pg_indexes where indexname='products_bm25'" \
  "pg_search ext:select count(*) from pg_extension where extname='pg_search'"
do
  printf '    %-20s %s\n' "${check%%:*}" "$(in_target "${check#*:}")"
done

echo "==> done."
