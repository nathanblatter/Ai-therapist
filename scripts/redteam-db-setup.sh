#!/usr/bin/env bash
#
# redteam-db-setup.sh — migrate + seed an EMPTY Postgres for the red-team harness.
#
#   1. src/database/scripts/migrateFromScratch.ts  every migration, 001 to head
#   2. redteam-seed.sql                            (idempotent belt-and-braces: ensure the
#                                                   config rows the code reads exist, and
#                                                   FORCE crisis_alert disabled so CI can
#                                                   never page the on-call — spec R3b)
#   3. redteam-seed-user.mjs                       (participant account for chat scenarios)
#
# Step 1 refuses a non-empty database (there is no migrations table), so this
# script is for a database that was just created. The seed steps are idempotent.
#
# Requires DATABASE_URL to point at the target DB.
#
# Usage:
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_therapist_redteam \
#     bash scripts/redteam-db-setup.sh
#
# History: until 2026-10-23 this script hand-ordered the migrations itself
# (001 via psql, a conversation_logs stub for 010, runMigrationRange 003 020,
# 021 via psql because of CREATE INDEX CONCURRENTLY, runMigrationRange 022
# <newest on disk>, then 002_insert_initial_user.js last because it needs the
# organizations row from 069). Every one of those special cases is now a row
# in the OVERRIDES table in src/database/scripts/migrateFromScratch.ts; add new
# ones there, not here.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "redteam-db-setup: DATABASE_URL must be set" >&2
  exit 1
fi

# Belt-and-braces: the harness must never page a real on-call from CI (spec R3b).
# Strip any inherited paging config before any app code can read it.
unset IMESSAGE_API_KEY || true
unset CRISIS_ALERT_PHONE || true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The migration runner is TypeScript and 002 imports config/db.ts through a .js
# specifier, so both run under tsx (not plain node). Prefer the repo-local
# binary; fall back to npx.
if [[ -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  TSX="$REPO_ROOT/node_modules/.bin/tsx"
else
  TSX="npx --no-install tsx"
fi

echo "==> redteam-db-setup: target = ${DATABASE_URL%%\?*}"

# --- Step 1: all migrations from empty ---------------------------------------
echo "==> [1/3] migrateFromScratch.ts"
$TSX "$REPO_ROOT/src/database/scripts/migrateFromScratch.ts"

# --- Step 2: config seed (idempotent) ----------------------------------------
echo "==> [2/3] redteam-seed.sql (system_config; force crisis_alert disabled)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/scripts/redteam-seed.sql"

# --- Step 3: participant account for chat scenarios --------------------------
echo "==> [3/3] redteam-seed-user.mjs (participant account)"
node "$REPO_ROOT/scripts/redteam-seed-user.mjs"

echo "==> redteam-db-setup: done"
