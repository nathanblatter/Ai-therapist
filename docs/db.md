# Database Schema Documentation

## Tables

### 1. users

Authentication and authorization table for the AI Therapist application.

**Schema:**

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| userid | SERIAL | PRIMARY KEY | Auto-incrementing unique identifier for each user |
| username | VARCHAR(255) | UNIQUE, NOT NULL | Unique username for login |
| password | VARCHAR(255) | NOT NULL | Bcrypt hashed password (never stored in plaintext) |
| role | VARCHAR(50) | NOT NULL, CHECK | User's role - must be one of: 'therapist', 'researcher', 'participant' |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Timestamp when the user account was created |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Timestamp when the user account was last updated |

**Indexes:**
- `idx_users_username` - Index on username for faster login lookups
- `idx_users_role` - Index on role for filtering users by role

**Roles and Permissions:**

| Role | Permissions |
|------|-------------|
| **therapist** | - Full access to admin dashboard<br>- Can view all data **without redaction** (unredacted PHI)<br>- Can access AI therapist features<br>- Can create new users via /api/auth/register |
| **researcher** | - Full access to admin dashboard<br>- Can view **redacted data only** (PHI is redacted)<br>- Can access AI therapist features<br>- Can create new users via /api/auth/register |
| **participant** | - **Cannot** access admin dashboard<br>- **Cannot** access admin API routes<br>- Can **only** access AI therapist features |

### 2. conversation_logs (dropped)

The original single-table message log. Replaced by `messages` in 003 and
dropped by `036_drop_conversation_logs_table.sql`; it no longer exists in any
environment. `src/database/scripts/migrateFromScratch.ts` creates a
two-column stub (an `OVERRIDES` row) only so 010 can alter it before 036 drops
it again.

### 3. GPT-Live voice tables (migration 098)

Added by the GPT-Live migration. Architecture reference: `docs/gpt-live.md`.

#### `therapy_sessions.openai_live_session_id`

| Column | Type | Description |
|--------|------|-------------|
| openai_live_session_id | TEXT | Opaque GPT-Live session id (`live_...`) returned in the JSON body of `POST /v1/live/sessions`. `NULL` for Realtime-era sessions. |

Kept separate from `openai_call_id` on purpose: a Realtime `call_id` and a Live
session id are different namespaces with different attach URLs, and the sideband
reattach query after a restart has to tell them apart. Indexed by
`idx_therapy_sessions_live_reattach` (partial: active sessions with a non-null
live session id).

#### `live_usage`

Per-second voice billing for GPT-Live sessions. **One row per session**,
overwritten as snapshots arrive.

| Column | Type | Description |
|--------|------|-------------|
| session_id | TEXT | PRIMARY KEY, FK → `therapy_sessions(session_id)` ON DELETE CASCADE |
| model | TEXT | Voice model (`gpt-live-1`) |
| duration_seconds | NUMERIC(12,3) | Latest **cumulative** voice duration reported by the API |
| finalized | BOOLEAN | TRUE once `session.closed` has been observed |
| close_reason | TEXT | `close_requested` / `expired` / `content` / `remote_hangup` / `connection_lost`; NULL while running |
| peak_context_ratio | NUMERIC(5,4) | Peak `context_window.usage_ratio` seen |
| created_at, updated_at | TIMESTAMP | |

**The cumulative-snapshot rule.** `session.usage.updated` carries a cumulative
total, **not** an increment. Summing the snapshots would massively overcount a
long session. So each snapshot **overwrites** the row (`GREATEST` of stored and
incoming, so a late out-of-order frame cannot walk the number backwards), and
`finalized` is sticky (`OR`) so a stray in-flight snapshot cannot downgrade a
confirmed total back to provisional.

Because the table stores the latest snapshot rather than appending deltas, it is
safe — and correct — to `SUM(duration_seconds)` **across sessions**. It is never
correct to sum snapshots *within* a session; the schema simply makes that
impossible by holding only one row.

`finalized = FALSE` means the connection dropped before `session.closed` and the
duration is the last in-flight snapshot — formally unconfirmed. It is persisted
anyway so the session is not billed as zero; the cost dashboard reports these
separately as `unfinalized_sessions`. A socket close alone does not establish
finalization.

Billing: `$0.05` per minute for the voice layer, charged per second and not
rounded up. `POST /v1/live/sessions` bills 15 seconds at initialization, credited
back against the running session — so an abandoned session still costs money.
Rates live in `LIVE_RATES_PER_MINUTE` (`src/server/db/liveUsage.queries.ts`) and
are a hand-maintained estimate; invoices are the source of truth.

#### `session_llm_usage.purpose` — new value `live_delegation`

The delegated Responses backend is billed **separately** from the voice layer, at
normal token rates. Those figures arrive as nested `response.completed` events on
the sideband and are written to the existing `session_llm_usage` table with
`purpose = 'live_delegation'`, so the cost dashboard picks them up with no
special handling. Each backend response id is metered once, so a replayed event
cannot double-bill.

Full value set: `insights | redaction | crisis | eligibility | rerank | chat |
live_delegation | grok_voice`. The column is VARCHAR(30) with a CHECK constraint
(046), so every new value needs a migration that re-creates the constraint —
098's claim that it was free text was wrong (fixed by 103 for `live_delegation`,
104 for `grok_voice`).

#### `session_llm_usage.purpose` — new value `grok_voice`

The Grok Voice proxy (`docs/grok-voice.md`) records per-response token counts
from xAI's `response.done` for the research record only. The money is billed
per audio minute and lives in `live_usage`; `estimateCostUsd` prices
`grok_voice` rows at zero so voice spend is not double counted.

This row is also the only per-session record of which backend model a voice
session actually ran on — see `docs/model-pinning.md`.

## Authentication Flow

### Login
1. Client sends POST to `/api/auth/login` with username and password
2. Server verifies credentials using bcrypt
3. On success, creates session and returns user data (without password)
4. Session stored in express-session with 24-hour expiry

### Authorization
- Routes use `requireAuth` middleware to verify user is logged in
- Routes use `requireRole(...roles)` middleware to check user has appropriate role
- Session data includes: `userId`, `username`, `userRole`

### Protected Routes

**Admin API Routes (require therapist or researcher role):**
- `GET /admin/api/sessions` - List all therapy sessions
- `GET /admin/api/sessions/:sessionId` - Get full conversation for a session
- `GET /admin/api/analytics` - Get dashboard analytics
- `GET /admin/api/export` - Export conversation data
- `POST /api/auth/register` - Create new users

**Admin Page Routes (require therapist or researcher role):**
- `GET /admin` - Admin dashboard interface

**Public Routes (no authentication required):**
- `POST /api/auth/login` - Login endpoint
- `POST /api/auth/logout` - Logout endpoint
- `GET /api/auth/status` - Check authentication status
- `POST /api/live/session` - Exchange the browser's SDP offer for a GPT-Live session
  (server holds the project API key; returns `session_id` + SDP answer). Replaces the
  Realtime-era `GET /token` ephemeral-key endpoint.
- `POST /logs/batch` - Log conversation messages
- `/` - Main AI therapist interface

## Migrations

Schema changes are plain SQL files in `src/database/migrations/`, numbered
`NNN_<name>.sql` with a matching `NNN_<name>_rollback.sql`. **Current head:
124** (`124_prompt_sections_2026_09_22.sql`); numbers are reserved per branch
and can land out of order (121 merged after 123 and 124), so list the
directory rather than trusting this line. There is no migrations table
and nothing applies them automatically: both stage and prod are migrated **by
hand**, and the record of what has been applied is the Flightdeck log plus the
backup file names below. Author-side conventions live in
`src/database/scripts/MIGRATION_GUIDE.md`.

### Runners

- `src/database/scripts/runMigrationRange.js <from> <to>` applies every
  `NNN_*.sql` in the inclusive range, sorted by filename, each in its own
  transaction, skipping `*_rollback*`. Run it under `npx tsx` from the repo
  root with `DATABASE_URL` set (`DATABASE_SSL=true` for RDS). It is the right
  tool for a batch; for one file, `psql -f` is simpler and is the only option
  for 021 and its rollback (`CREATE/DROP INDEX CONCURRENTLY` cannot run in a
  transaction).
- `src/database/scripts/migrateFromScratch.ts` builds a database from
  **empty** to the current head in one command (see "Bootstrapping from
  empty" below). `scripts/redteam-db-setup.sh`, which CI runs on every
  deploy, is that command followed by the red-team seeds. Either is the
  fastest way to get a scratch database for testing a rollback.
- Rollbacks are applied with `psql -f`, in reverse numeric order, one file at
  a time. There is no rollback range runner.

### Bootstrapping from empty

```sh
export PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH
DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/ai_therapist_scratch DATABASE_SSL=false \
  npx tsx src/database/scripts/migrateFromScratch.ts [--to NNN] [--dry-run] [--allow-existing]
```

`migrateFromScratch.ts` discovers every `NNN_*.sql` and `NNN_*.js` in
`src/database/migrations/` (rollbacks excluded), applies them in prefix-then-
filename order with one transaction per SQL file on a single `pg` client, and
logs one line per file. It does not need `psql`, and it deliberately does not
read `.env`: `DATABASE_URL` must be set explicitly so it cannot land on stage
by accident. It **refuses a non-empty database** (any user table, view or
sequence) because, with no migrations table, nothing can say what was
already applied; use `runMigrationRange.js` for those. `--dry-run` prints
the plan without connecting, `--to NNN` stops after that prefix (steps that
need a later migration are logged as skipped), and `--allow-existing` only
disables the emptiness check for throwaway databases (every file re-applies,
and 091's `DROP CONSTRAINT` is not idempotent).

Everything the bootstrap has to do differently from "sort and apply" is a
row in the `OVERRIDES` table at the top of the script. That table is the only
place such rules live; add to it, never to a shell script:

| File | Override | Why |
| --- | --- | --- |
| `001_create_users_table.sql` | autocommit (statement by statement, dedicated client) | Historically applied raw with `psql -f` before the range runner started at 003; kept identical to that record. |
| `002_insert_initial_user.js` | run via `tsx` after every SQL migration; skipped if `--to` is below 069 | Seeds the first researcher through the app pool; `users.organization_id` is NOT NULL since 069 and needs the `irb-study` row from 069. |
| `010_fix_timestamp_columns.sql` | pre-step: `CREATE TABLE IF NOT EXISTS conversation_logs (id SERIAL PRIMARY KEY, created_at TIMESTAMP ...)` | `conversation_logs` is a pre-001 legacy table no migration creates; 010 alters it and 036 drops it. |
| `021_add_composite_message_index.sql` | autocommit (statement by statement, dedicated client) | `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. |

Verified 2026-10-23: a database built by the new runner and one built by the
previous hand-ordered sequence (001 via psql, stub, `runMigrationRange 003
020`, 021 via psql, `runMigrationRange 022 113`, 002) gave byte-identical
`pg_dump --schema-only` output and identical row counts across all 67 tables.

### Stage (local docker Postgres, database `ai_therapist`)

```sh
# backup first (shared container: dump the ONE database, never pg_dumpall)
docker exec docker-services-postgres-1 pg_dump -U postgres --no-owner ai_therapist \
  | gzip > ~/backups/ai_therapist-pre-NNN-$(date +%Y%m%d).sql.gz
gunzip -t ~/backups/ai_therapist-pre-NNN-$(date +%Y%m%d).sql.gz

# apply
docker exec -i docker-services-postgres-1 psql -U postgres -d ai_therapist \
  -v ON_ERROR_STOP=1 < src/database/migrations/NNN_name.sql
```

### Prod (RDS, database `ai_therapist_prod`)

Reachable only from the prod app host and the one fixed home IP in the RDS
security group (`docs/data-access-boundary.md`, section 7). Use the RDS master
credential from AWS Secrets Manager for the session only; never write it to a
file or `.env`. The command shape is:

```sh
export PGSSLMODE=require PGHOST=<rds endpoint> PGUSER=<master user> PGPASSWORD=<from Secrets Manager>

# Backup first: an RDS snapshot, inside AWS. Never pg_dump prod to a laptop,
# the stage host or any other machine outside the study's AWS account.
aws rds create-db-snapshot --db-instance-identifier ai-therapist \
  --db-snapshot-identifier ai-therapist-pre-NNN-$(date +%Y%m%d)
aws rds wait db-snapshot-available --db-snapshot-identifier ai-therapist-pre-NNN-$(date +%Y%m%d)

psql -d ai_therapist_prod -v ON_ERROR_STOP=1 -f src/database/migrations/NNN_name.sql
```

For a batch, `DATABASE_URL=postgresql://... DATABASE_SSL=true npx tsx
src/database/scripts/runMigrationRange.js <from> <to>` does the same thing
with one transaction per file. Then verify (`\d <table>`, a count, one smoke
request through the app) and log the range plus the backup path in
Flightdeck. Prod writes that touch participant data follow
`docs/on-call-sop.md`.

### Backup-before-migrate convention

Every migration run starts with a verified backup, and where the backup
lives depends on whose data it is (owner decision, 2026-11-19):

- **Prod: real study data never leaves AWS.** The backup is a manual RDS
  snapshot named `ai-therapist-pre-<range>-<YYYYMMDD>`, waited on until it is
  `available`, on top of the instance's 14-day automated backups. Do not
  `pg_dump` prod to the stage host, a laptop, a NAS or any other machine
  outside the study's AWS account, encrypted or not. Record the snapshot
  identifier in Flightdeck. (Dumps named `ai_therapist_prod-pre-*.sql.gz`
  taken under the earlier convention, August to November 2026, are being
  removed from the stage host.)
- **Stage: the data is test data.** A `pg_dump | gzip` into `~/backups/` named
  `ai_therapist-pre-<range>-<YYYYMMDD>.sql.gz`, verified with `gunzip -t`
  before the migration is applied, is enough; keep it only until the change
  has settled.

The nightly encrypted backup on the stage host (`scripts/README-backups.md`)
covers the stage database and stage recordings only. It is a separate safety
net for stage, not a substitute for the pre-migration backup (it may be up to
a day behind), and it never contains prod data.

### Intentionally irreversible migrations

These have no `_rollback.sql` on purpose. Reverting them means restoring the
pre-migration backup (or the nightly dump), never a hand-written restore.

| Migration | Why there is no rollback |
| --- | --- |
| `001_create_users_table.sql` | The inverse is `DROP TABLE users CASCADE`, which destroys every account and cascades through nearly every table in the schema. Rolling back 001 is rebuilding the database from a backup. |
| `035_drop_human_handoff_tables.sql` | Drops `human_handoffs` and `clinical_reviews` with their rows. The DDL is recoverable from `011_add_crisis_management.sql`, the data is not; recreating empty tables would misrepresent the study record. |
| `036_drop_conversation_logs_table.sql` | Drops the pre-003 legacy `conversation_logs` table. No migration ever created it (it predates 001), so there is no canonical definition to restore and no code path reads it. |

Everything else has a rollback. The ones added in the 2026-10-22 backfill
(008, 009, 010, 011-patch, 021, 022, 037) were each validated on a scratch
database built by the bootstrap: rollback applied, state checked,
forward re-applied, state checked. Caveats recorded in their headers: 010's
rollback needs 095's view dropped first and 010 forward needs the
`conversation_logs` stub after 036; the 011-patch rollback (like 025/027/068/
105) refuses while rows hold the newer `action_type` values; 022's rollback
orphans the recording WAVs in object storage.

### Number 091 is used twice

`091_access_audit_and_redaction_review.sql` (2026-09-05) and
`091_researcher_care_comms.sql` (2026-09-09) share a number. **Both are
applied on stage and prod** (prod batch `pre-088-096-20260909`) and they are
independent: the first creates `data_access_log` and `redaction_review_log`,
the second rewrites three care-comms role CHECKs. The collision was kept
rather than renumbered because:

- `runMigrationRange.js` selects by `Number(name.slice(0, 3))` and sorts by
  full filename, so both files are inside any range that includes 091 and
  apply deterministically in the order `091_access_audit...` then
  `091_researcher_care_comms...`. `migrateFromScratch.ts` orders the same
  way, so CI has been building schemas with both since September.
- Renumbering the second file to the next free number (111) would re-apply
  it on any environment that runs "everything after 110", and its `DROP
  CONSTRAINT` statements are not idempotent (no `IF EXISTS`), so a fresh
  range run would fail on stage and prod.

Rollback order for that pair is the reverse: `091_researcher_care_comms_rollback`
then `091_access_audit_and_redaction_review_rollback`. Do not reuse a number
again; take the next free one after the head.

## Connection pool bounds (ai-therapist-366)

`src/server/config/db.ts` gives every app connection a pool size, a wait limit
for a free connection, a `statement_timeout`, an
`idle_in_transaction_session_timeout` and an `application_name`. All are env
settings with defaults (`.env.example`, "Pool bounds"); 0 disables a timeout.

- A bound that fires is a rejected promise: pg-pool's `timeout exceeded when
  trying to connect`, or Postgres error 57014 (statement) / 25P03 (idle in
  transaction). `src/server/utils/dbErrors.ts` classifies them; participant
  routes answer 503 `database_unavailable` with a retry message.
- The crisis path treats any of them as "could not read" and still pages and
  shows resources (tests: `services/crisisPath.dbTimeout.test.ts`).
- Long legitimate work runs inside `withLongQueries(label, fn)`
  (`src/server/config/dbLongQueries.ts`): the dataset export, the researcher
  export, the content wipe and its stats, risk calibration, messaging
  retention, the deviation scan, demo cleanup, admin analytics (60 s) and
  `runMigrationRange.js` (no limit). Its connections are raised with `SET` and
  put back with `RESET` before they return to the pool. A new bulk job belongs
  in it.
- `psql -f` migrations are not affected. The legacy per-number runners
  (`runMigrationNNN.js`, `rollbackMigration*.js`) were not wrapped: they are
  historical, and would run under the default limits.
- Every connection has a permanent `error` listener, so a connection that dies
  while checked out no longer crashes the process. Code that holds a
  connection for the life of the process must release it when it ends, or
  the slot is never freed: the socket.io adapter's `LISTEN` client goes
  through `releaseOnEnd` (`src/server/config/dbHeldClient.ts`) for this.
- `GET /health/deep` reports the pool's size, in-use and waiting counts and the
  timeouts counted since start.
- `pg_stat_activity.application_name` is `ai-therapist/<script>@<host>`, so
  two app containers during a deploy, the harness child and a CLI can be told
  apart.
- Live check against a throwaway database (`rt_dbpool_*` only):
  `DB_POOL_LIVE_DATABASE_URL=... npx vitest run src/server/config/db.pool.live.test.ts`.

## Security Notes

- All passwords are hashed using bcrypt with 10 salt rounds
- Sessions use httpOnly cookies to prevent XSS attacks
- Sessions use secure cookies in production (HTTPS only)
- Session secret should be changed in production
- PHI is redacted at storage time to protect sensitive information
- Role-based access control prevents unauthorized data access

## Future Enhancements

- [x] Role-based redaction retrieval (caseload RBAC, docs/caseload-rbac.md)
- [ ] Password reset / email verification (sign-in now goes through Squawk, docs/squawk-auth.md)
- [x] Two-factor authentication (mfa.service.ts; passkeys via Squawk)
- [x] Audit logging for admin actions (data_access_log, caseload_audit_log, assistant_audit)
- [x] User management UI in admin dashboard (Users view)

## Redaction leak-check (`messages.metadata.redaction_check`)

After `redactSession` persists `content_redacted`, `redactionVerifier.service.ts`
asks a decision model one bounded question per redacted message ("does this
text still contain a direct personal identifier?") and stores the verdict on
the row:

```json
"redaction_check": {
  "status": "checked" | "errored",
  "p_leak": 0.83, "flagged": true,
  "backend": "decisions" | "responses", "model": "gpt-6-luna",
  "checked_at": "2026-10-02T...", "reviewed": true, "error": "..."
}
```

- Three states (`src/server/db/leakCheckSql.ts` is the one SQL definition):
  never checked (no `redaction_check` key), **checked** (`status: "checked"`,
  the model answered), **errored** (`status: "errored"`, `flagged: null`,
  `p_leak: -1`, `error` set: the check did not produce an answer). Rows
  written before 2026-11-19 have no `status`; one that carries `error` (with
  `flagged: false`, as the ai-therapist-284 outage rows do) counts as errored.
- `flagged` = `p_leak >= system_config.redaction_verifier.threshold` (default 0.5).
- `reviewed` is set when a researcher corrects or approves the row in the
  Redaction Verification tool. The tool lists flagged-and-unreviewed rows
  first, errored-and-unreviewed rows next, then a random sample, and its
  header counts the two backlogs separately (`flagged_unreviewed`,
  `errored_unreviewed` from `GET /redact/api/messages`).
- What a flagged or errored, unreviewed row is kept out of
  (ai-therapist-288): researcher semantic search (`redactionCompleteSql`).
  That is the only leak-check gate. The research dataset export
  (`transcripts.csv`), the researcher CSV export and the content wipe do not
  read `redaction_check` (the wipe waits on `redaction_error`, the redaction
  run's own failure marker, not on the leak check).
- Backend `auto` (default) uses the OpenAI Decisions API (`POST /v1/decisions`,
  one `predicate` question in `questions[]`; `p_leak` is the returned
  `probability`) and falls back to the Responses API with a strict json_schema
  only when the endpoint is not enabled for the org (404 / "not enabled"). Only
  redacted text is sent; the Responses fallback sets `store:false` (Decisions
  has no such parameter); usage is recorded under purpose `redaction`.
- Fail-soft for the pipeline only: any other verifier error (a 400, a
  refusal, a timeout, no OpenAI client) records the row as errored and does
  not block redaction, naming or the wipe. To list errored rows, with an
  estimated cost of re-checking them, run
  `npx tsx src/database/scripts/recheckErroredLeakChecks.ts` (list only by
  default; `--requeue` re-runs the verifier over the unreviewed ones, one
  OpenAI call each).
- Config row: `system_config.redaction_verifier` =
  `{"enabled": true, "backend": "auto"|"decisions"|"responses", "threshold": 0.5}`;
  absent row = defaults. No migration needed.


## Audit tables and their read surfaces

Four append-only accountability tables record who did what to participant
data. None has FK cascades on actor columns, so rows survive account deletion.
Since ai-therapist-197 (2026-10-22) every one of them is readable through the
admin **Data Access** view (Research nav group, researcher-only) and the
`/admin/api/audit/*` routes in `src/server/routes/admin/audit.routes.ts`; see
`docs/data-access-boundary.md` section 6 for the role/scope table.

| Table | Written by | Read by |
| --- | --- | --- |
| `data_access_log` (091) — transcript views, recording streams, exports, and `audit_log_view` self-audit rows | `logDataAccess` in `src/server/db/accessLog.queries.ts` (fire-and-forget) | `listDataAccessLog`, `getParticipantAccessHistory` (same module) |
| `redaction_review_log` (091) — approved/corrected per sampled message | `updateRedactedContent`, `recordRedactionApproval` in `redaction.queries.ts` | `listRedactionReviewLog` (same module) |
| `assistant_audit` (092) — one row per admin-assistant turn, tools + row counts, never payloads | `services/assistant.service.ts` | `listAssistantAudit` in `assistantAudit.queries.ts` |
| `caseload_audit_log` — assignments, invites, work-queue actions | `insertCaseloadAudit` in `caseload.queries.ts` | `listCaseloadAudit` (same module) |

The IRB continuing-review packet (`docs/irb-packet.md`) reads these audit
tables for its data-access section and writes one `data_access_log` row
(`action = 'export'`, `detail.kind = 'irb_packet'`) per HTML or zip generation.

`data_access_log.session_id` is TEXT while `therapy_sessions.session_id` is a
UUID; the readers join on `ts.session_id::text` and resolve the participant as
`COALESCE(dal.user_id, ts.user_id)` because recording-stream rows carry only
the session id. No migration was needed for the read side.
