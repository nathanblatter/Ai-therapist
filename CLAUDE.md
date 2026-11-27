# AI Therapist — project conventions

## Vision

**IRB-backed research study tool to support the development of AI in mental health care; potentially productized down the road and sold commercially to therapists.**

Study integrity, participant safety, and data quality come first; therapist-pilot work is legitimate but secondary. Kill tech-for-tech's-sake features that serve neither lane.

## UI conventions

- Never use emojis anywhere in this project (participant or admin UI, toasts, server-sent strings). Use react-feather icons instead. (Typographic characters like the U+2022 list bullet are fine.)

## Authentication (Squawk, since 2026-10-19)

Sign-in goes through Squawk (https://squawk.nathanblatter.com) when the `SQUAWK_*`
env vars are set: see docs/squawk-auth.md. Never add a second password check or a
local credential store; account creation, password and role changes go through
`src/server/services/accounts.service.ts` so Squawk stays in sync. Without the
vars (local dev, tests) the legacy username/password login still works.

## Formatting (Prettier, since 2026-10-23)

`npm run format:check` is a CI gate alongside typecheck, lint and tests; run
`npm run format` before committing. The config matches the codebase's existing
style (single quotes, 120 columns); docs, SQL, workflow YAML and scripts in
other languages are ignored on purpose. Run
`git config blame.ignoreRevsFile .git-blame-ignore-revs` once per checkout so
the initial format commit does not pollute blame.

## Cost figures (hard rule, since 2026-11-26)

Any spend figure, anywhere (a reply, a PR body, a doc, a commit, Flightdeck),
comes from the OpenAI costs API, never from token counts or a price list:
`GET https://api.openai.com/v1/organization/costs?start_time=<unix>&limit=31`
with `OPENAI_ADMIN_KEY` from the repo `.env`. Read it before and after a paid
run and give both readings with their times. It reports by UTC day and lags;
when a single run cannot be isolated, say so and give the day's total.
