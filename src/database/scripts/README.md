# src/database/scripts

One-off runners that touch the database directly. Every script imports the
app's `pool` from `src/server/config/db.ts`, so it needs `DATABASE_URL` (and
`DATABASE_SSL=true` against RDS) in the environment; run them with
`npx tsx <path>` from the repo root, or inside the app container. None of
these run automatically. Schema docs: `docs/db.md`; migration history:
`src/database/migrations/` and `MIGRATION_GUIDE.md` in this folder.

## Migrations

Migrations are plain SQL files numbered `NNN_*.sql` with a matching
`NNN_*_rollback.sql`. Apply them with the generic range runner:

```sh
node src/database/scripts/runMigrationRange.js 035 046   # inclusive, numeric order
```

Each file runs in its own transaction and `*_rollback.sql` files are skipped.
`scripts/redteam-db-setup.sh` at the repo root shows the one order that
builds a database from empty (001 raw SQL, then 003..NNN via the range
runner, then `002_insert_initial_user.js`).

The numbered runners (`runMigration004.js` ... `runMigration034.js`) and
rollbacks (`rollbackMigration011.js` ... `rollbackMigration034.js`) are the
historical per-migration wrappers from before `runMigrationRange.js` existed.
They are kept so an old environment can be reproduced; prefer the range
runner for anything new. `runMigration.js` / `rollbackMigration.js` apply or
revert 003 (the 3NF normalisation) specifically; `patchMigration011.js`
widens the `intervention_actions` action-type constraint after 011.

| Script | What it does |
|---|---|
| `runMigrationRange.js <from> <to>` | Forward-apply a numeric range of `.sql` migrations. Use this. |
| `runMigration.js`, `rollbackMigration.js` | Apply / revert 003 (interactive confirmation on rollback). |
| `runMigrationNNN.js`, `rollbackMigrationNNN.js` | Legacy single-migration wrappers (004, 005, 011, 012, 014-017, 019, 020, 022, 028, 030-034). |
| `patchMigration011.js` | Post-011 constraint patch. |
| `addClientLoggingConfig.js` | Inserts the `client_logging` system_config row (not part of any migration; see `docs/system-config-keys.md`). |

## Data and research runners

| Script | npm alias | What it does | When |
|---|---|---|---|
| `exportDataset.ts` | `npm run export:dataset -- --out <dir>` | De-identified research dataset export (CSV bundle + codebook, optional transcript zip). Refuses output paths under `~/Desktop` or `~/Documents`; `exportDataset.guard.test.ts` covers that guard. | Study analysis handoffs. Spec: `docs/data-access-boundary.md`. |
| `runRetention.ts` | `npm run retention:run` | Manual pass of `dataRetention.service` (recordings age-out, wiped-user grace), even when the nightly scheduler is disabled. | Ad hoc retention enforcement. |
| `runEvals.ts` | `npx tsx ...` | Offline LLM-judge session evals (`--session <id>` or `--all-ended`, judge ensemble from `system_config.evals`). Needs `OPENAI_API_KEY`. | Backfilling or re-judging sessions. Spec: `docs/eval-system.md`. |
| `runPairwiseEvals.ts` | `npx tsx ...` | Pairwise A/B judge across an axis (`--axis ai_model` or `proactive_offering`). Idempotent per prompt version. | Model or prompt comparisons. |
| `runCounterfactual.ts` | `npm run counterfactual -- --session <id>` | Counterfactual backend-model sweep from a session (replay or fork mode). | Model-selection research; fork mode is non-study sessions only. |
| `ingestKnowledge.js` | `npx tsx ...` | Embeds and upserts the RAG seed corpora from `../seeds/` into `knowledge_chunks`. See `../seeds/README.md`. | After migrations 031 + 032, and whenever a seed file changes. |
| `approveKnowledge.js` | `npx tsx ...` | Lists pending knowledge chunks and flips them active (`--all`, `--kind`, `--topic`, `--dry-run`, `--by <name>`). | After each content review. Spec: `docs/rag-approval-review.md`. |
| `importToSquawk.ts` | `npx tsx ... [--dry-run]` | One-time import of local accounts and organisations into Squawk (needs `SQUAWK_ADMIN_TOKEN` on the command line, never in `.env`). | Done once per deployment at the Squawk cutover; idempotent. `docs/squawk-auth.md`. |

## Rules of thumb

- Read-only investigation belongs in `psql`; these scripts all write.
- Anything that writes participant data on prod runs through the on-call
  SOP (`docs/on-call-sop.md`) and gets logged in Flightdeck.
- New one-off scripts go here (database) or in `scripts/` at the repo root
  (ops and external services), with a header comment stating purpose, env
  needs, and an example invocation, in the style of `exportDataset.ts`.
