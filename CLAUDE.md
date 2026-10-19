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
