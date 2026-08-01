#!/usr/bin/env bash
#
# redteam-db-setup.sh — migrate + seed an EMPTY Postgres for the red-team harness.
#
# The app's migrations are a mix of .sql and .js and there is no single
# "migrate from scratch" command (see spec §14 R2). This script applies them in
# the one order that works on a genuinely empty database:
#
#   1. 001_create_users_table.sql        (raw SQL; runMigrationRange skips 001)
#   2. runMigrationRange.js 003 046      (the normalized schema through 046;
#                                         007 also seeds system_config)
#   3. 002_insert_initial_user.js        (needs the users table from step 1)
#   4. redteam-seed.sql                  (idempotent belt-and-braces: ensure the
#                                         config rows the code reads exist, and
#                                         FORCE crisis_alert disabled so CI can
#                                         never page the on-call — spec R3b)
#
# Requires DATABASE_URL to point at the target DB. Everything is idempotent /
# ON CONFLICT DO NOTHING, so re-running is safe.
#
# Usage:
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_therapist_redteam \
#     bash scripts/redteam-db-setup.sh
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
MIG_DIR="$REPO_ROOT/src/database/migrations"

# The migration runners import config/db.ts through a .js specifier, so they must
# run under tsx (not plain node). Prefer the repo-local binary; fall back to npx.
if [[ -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  TSX="$REPO_ROOT/node_modules/.bin/tsx"
else
  TSX="npx --no-install tsx"
fi

echo "==> redteam-db-setup: target = ${DATABASE_URL%%\?*}"

# --- Step 1: 001 users table (raw SQL) ---------------------------------------
# runMigrationRange.js deliberately skips 001, and 003_normalize_schema depends
# on the users table existing, so apply 001 first via psql.
echo "==> [1/4] 001_create_users_table.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$MIG_DIR/001_create_users_table.sql"

# Legacy-table shim: conversation_logs is NOT created by any migration — it was
# a pre-001 legacy table that only ever existed in the original hand-built DB.
# Migration 010 ALTERs its created_at column and 036 drops it, so on a truly
# empty database 010 fails without this stub. Create a minimal version so the
# 010 ALTER succeeds; 036 removes it again. (spec §14 R2)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS conversation_logs (id SERIAL PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);"

# --- Step 2: 003..046 forward migrations -------------------------------------
# runMigrationRange wraps each file in a transaction, but 021 uses
# CREATE INDEX CONCURRENTLY (illegal inside a transaction), so it must be applied
# on its own via psql (autocommit). Split the range around it. (spec §14 R2)
echo "==> [2/4] runMigrationRange 003 020"
$TSX "$REPO_ROOT/src/database/scripts/runMigrationRange.js" 003 020
echo "==> [2/4] 021_add_composite_message_index.sql (CONCURRENTLY, autocommit)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$MIG_DIR/021_add_composite_message_index.sql"
echo "==> [2/4] runMigrationRange 022 046"
$TSX "$REPO_ROOT/src/database/scripts/runMigrationRange.js" 022 046

# --- Step 3: initial researcher user -----------------------------------------
echo "==> [3/4] 002_insert_initial_user.js"
$TSX "$MIG_DIR/002_insert_initial_user.js"

# --- Step 4: config seed (idempotent) ----------------------------------------
echo "==> [4/5] redteam-seed.sql (system_config; force crisis_alert disabled)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/scripts/redteam-seed.sql"

# --- Step 5: participant account for chat scenarios --------------------------
echo "==> [5/5] redteam-seed-user.mjs (participant account)"
node "$REPO_ROOT/scripts/redteam-seed-user.mjs"

echo "==> redteam-db-setup: done"
