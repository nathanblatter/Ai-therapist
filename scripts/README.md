# scripts/

Operational scripts that live outside the app: host jobs, CI database setup,
research tooling and one-off cleanups. Nothing here is imported by the server.
Database-level runners (migrations, exports, evals, knowledge ingest) are in
`src/database/scripts/` instead. Each script's header comment is the
authoritative usage text; this file says what exists, when it runs, and where
it is installed.

Node scripts that import TypeScript from `src/` run through tsx
(`node node_modules/.bin/tsx <script>`); plain `.mjs` ones run under `node`.
Set `PATH` to the nvm Node first on the home box.

## Host jobs (installed on the home box, run by launchd)

These are copied out of the repo into `~/docker-services/` and loaded as
LaunchAgents; editing the file in the repo does nothing until it is copied
again. Re-copy after any change, then `launchctl unload` / `load` the plist.

| Script | Installed as | Schedule | What it does |
|---|---|---|---|
| `prod-uptime-check.sh` + `com.nathan.ai-therapist-uptime.plist` | `~/docker-services/prod-uptime-check.sh`, `~/Library/LaunchAgents/com.nathan.ai-therapist-uptime.plist` | every 5 min | Curls prod `/health/deep`; pages the on-call phone through the iMessage bridge after 2 consecutive failures, at most hourly while down, once on recovery. Reads `IMESSAGE_API_KEY` / `CRISIS_ALERT_PHONE` from the stage deploy `.env` (`~/deploy/Ai-therapist/.env`). State and log in `~/docker-services/ai-therapist-uptime.*`. |
| `backup-ai-therapist.sh` + `com.nathan.ai-therapist-backup.plist` | `~/docker-services/backup-ai-therapist.sh`, `~/Library/LaunchAgents/com.nathan.ai-therapist-backup.plist` | daily 04:10 | age-encrypted dump of the stage Postgres DB and MinIO recordings bucket, pushed off-box. Config in `~/docker-services/ai-therapist-backup.env`. Install and restore-test procedure: `README-backups.md` in this folder. |

## CI and red-team support

| Script | Run by | What it does |
|---|---|---|
| `redteam-db-setup.sh` | `deploy.yml`, `deploy-prod.yml`, `redteam-nightly.yml`; locally before `npm run redteam:*` | Migrates and seeds an EMPTY Postgres for the harness (`DATABASE_URL` required): 001 raw SQL, `runMigrationRange.js 003 NNN`, `002_insert_initial_user.js`, then `redteam-seed.sql`. |
| `redteam-seed.sql` | `redteam-db-setup.sh` | Idempotent `system_config` seed for the harness; forces `crisis_alert.enabled=false` so CI can never page a human. |
| `redteam-seed-user.mjs` | `redteam-db-setup.sh` | Seeds the harness participant account (`REDTEAM_PARTICIPANT_USER` / `_PASS`). |

Harness documentation: `src/redteam/README.md` and `docs/redteam.md`.

## Secrets and account hygiene (run by hand)

| Script | What it does |
|---|---|
| `set-openai-admin-key.sh` | Installs or rotates `OPENAI_ADMIN_KEY` in the local, stage and prod `.env` files without echoing it, validating the key against the costs endpoint first and hash-checking every write. Prompts for the key; avoid the argv form. |
| `purge-openai-stored-responses.py` | One-off purge of stored OpenAI `/v1/responses` records left by pre-fix redaction calls (ai-therapist-188). Needs a dedicated restricted admin key that is deleted afterwards; see the header. |
| `wipe-qualtrics-test-data.mjs` | Deletes Qualtrics preview/E2E test responses and their app-side rows (`--test-user <name>`, dry run unless `--execute`). Run with the target environment's `QUALTRICS_*` and `DATABASE_URL` loaded. |

## IRB evidence and research tooling (run by hand)

| Script | What it does | Output |
|---|---|---|
| `redaction-evidence.mjs` | Runs synthetic Safe Harbor identifiers through the production batch redactor and checks every one is removed. No DB. Needs `OPENAI_API_KEY`. | `docs/redaction-evidence-<date>.md` |
| `redaction-signal-check.mjs` | Measures how much affective signal survives redaction on real rows still inside the raw-content window (`SIGNAL_CHECK_LIMIT`, `SIGNAL_CHECK_INCLUDE_DEMO=1`). Writes aggregates only. Needs `DATABASE_URL` + `OPENAI_API_KEY`. | `docs/redaction-signal-check-<date>.md` |
| `phase2-power-sim.py` | Phase 2 power simulation (pure numpy) for the pre-registered FGLS analysis. | `docs/phase2-power-sim-results*.csv`, `docs/phase2-power-analysis.md` |
| `phase2-analysis-plan.py --data <export dir>` | The pre-registered confirmatory analysis, run against a de-identified dataset export (not the live DB). | stdout tables |

## `participant-sim/`

A synthetic Phase 2 participant: `persona.ts` defines the character,
`run-sessions.ts` drives a scripted sequence of real chat sessions through the
in-process server (crisis paging forced off, `SOCKET_PG_ADAPTER=off`),
`backdate.sql` / `enrich.sql` / `insert-surveys.sql` spread them across study
weeks and add survey rows, `fire-adverse.ts` raises an adverse event,
`finalize.ts` and `score-check.ts` close out and sanity-check scores,
`export.ts` produces the dataset bundle in `export-out/` (a tracked sample
export with its codebook), and `copy-to-stage.ts` moves the result onto
stage. It is a demo/data-quality fixture for a dev or stage database only;
never run it against prod. Session-to-slot bookkeeping is written to
`system_config` as `sim_session_NN` rows (see `docs/system-config-keys.md`).
