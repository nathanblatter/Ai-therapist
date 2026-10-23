# Migration guide

How schema changes are written, applied and reverted in this repo. The
authoritative operational copy (environment commands, backup convention,
irreversible list, numbering notes) is `docs/db.md`, section "Migrations";
this file is the author-facing summary that lives next to the runners.

## Layout

- `src/database/migrations/NNN_<name>.sql` - forward migration, plain SQL,
  three-digit zero-padded number. Current head: **110**.
- `src/database/migrations/NNN_<name>_rollback.sql` - its inverse. Every
  forward migration has one except 001, 035 and 036, which are listed as
  intentionally irreversible in `docs/db.md`.
- `002_insert_initial_user.js` is the only non-SQL migration (seeds the first
  researcher account; needs the app's `pool`).
- There is no migrations table. Nothing records what has been applied; the
  operator keeps that in Flightdeck and in the backup file names
  (`~/backups/ai_therapist_prod-pre-NNN-YYYYMMDD.sql.gz`).

## Runners

| Runner | Use |
| --- | --- |
| `node src/database/scripts/runMigrationRange.js <from> <to>` (run under `npx tsx` from the repo root; needs `DATABASE_URL`, and `DATABASE_SSL=true` for RDS) | Applies every `NNN_*.sql` with `from <= NNN <= to`, sorted by filename, each file in its own transaction, skipping `*_rollback*`. The normal way to apply a batch. |
| `psql ... -f <file>` | Single files, and anything that cannot run inside a transaction (021 and its rollback use `CREATE/DROP INDEX CONCURRENTLY`). Also how every rollback is applied: there is no rollback range runner. |
| `scripts/redteam-db-setup.sh` | Builds a database from empty: 001 via psql, a `conversation_logs` stub (010 alters it, 036 drops it), `runMigrationRange 003 020`, 021 via psql, `runMigrationRange 022 <newest on disk>`, then 002 and the red-team seed. CI uses it on every deploy; use it locally for throwaway databases. |
| `runMigrationNNN.js` / `rollbackMigrationNNN.js` / `runMigration.js` / `rollbackMigration.js` / `patchMigration011.js` | Historical single-migration wrappers from before the range runner (003 through 034). Kept so old environments can be reproduced; do not add new ones. |

Range-runner selection detail: files are matched by `/^\d{3}_.*\.sql$/`, the
number is `Number(name.slice(0, 3))`, and ties sort by full filename. Two
files can therefore share a number and both apply, in filename order; see
"Number 091" in `docs/db.md`.

## Writing a migration

1. Take the next free number after the current head (`ls src/database/migrations | sort | tail`), never a gap and never an existing number.
2. Header comment: number, purpose, date, and any ordering constraint (depends on table X from NNN; must run outside a transaction; needs a data backfill).
3. Prefer idempotent DDL (`IF NOT EXISTS`, `DROP ... IF EXISTS`, `CREATE OR REPLACE VIEW`) so a half-applied batch can be re-run.
4. CHECK-constraint value sets (`intervention_actions.action_type`, `session_llm_usage.purpose`, the care-comms role checks) are re-created wholesale by each migration that extends them. The rollback restores the previous full set and will refuse while rows hold the newer values; say so in the header.
5. Write the rollback in the same commit. If the migration destroys data (drops a table or column that holds participant data), do not invent a restore: add the migration to the irreversible table in `docs/db.md` with the reason, and rely on the pre-migration backup.
6. Prove both directions on a scratch database before committing:

   ```sh
   export PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH   # node is not on PATH by default
   PGPASSWORD=<local postgres password> createdb -h localhost -U postgres ai_therapist_scratch
   DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/ai_therapist_scratch DATABASE_SSL=false \
     bash scripts/redteam-db-setup.sh
   psql -h localhost -U postgres -d ai_therapist_scratch -v ON_ERROR_STOP=1 -f src/database/migrations/NNN_x_rollback.sql
   psql -h localhost -U postgres -d ai_therapist_scratch -v ON_ERROR_STOP=1 -f src/database/migrations/NNN_x.sql
   dropdb -h localhost -U postgres ai_therapist_scratch
   ```

   The scratch database can live on the shared local Postgres container; never
   point `DATABASE_URL` at `ai_therapist` (stage) or prod for this.
7. Update `docs/db.md` (schema notes, head number) and, if the change adds a
   filtered column or an FK, check it against `docs/db-index-audit.md`.

## Applying to stage and prod

Both environments are migrated by hand; CI never runs migrations against a
real database. The exact commands, the backup-first convention and the
verification steps are in `docs/db.md`, "Migrations". Short form:

1. `pg_dump | gzip` into `~/backups/` named for the range about to be applied, `gunzip -t` it.
2. Apply the forward file(s) with the environment's psql command.
3. Verify the expected objects exist (`\d table`, a count, a smoke call).
4. Log the range and backup path in Flightdeck.

Rolling back is the same sequence with the `_rollback.sql` file(s), applied
in reverse numeric order, with a fresh backup first.

## Historical note: 003

Migration 003 (`003_normalize_schema.sql`) replaced the original single
`conversation_logs` table with `therapy_sessions`, `session_configurations`,
`messages` and `user_sessions`. `runMigration.js` / `rollbackMigration.js`
are its dedicated wrappers. `conversation_logs` itself was dropped by 036 and
no longer exists in any environment.
