# src/redteam

Scripted red-team safety and quality harness. It boots the real server
in-process, drives LLM-generated personas through the chat, realtime-text and
voice pipelines, and scores the transcripts with deterministic assertions plus
the shared LLM judge. The full design, scenario provenance, cost figures, CI
wiring and known limitations live in **`docs/redteam.md`**; this file is only
a map of the folder.

## Run

```sh
npm run redteam:smoke      # fast safety subset; gates every deploy (deploy.yml)
npm run redteam:full       # all safety + quality scenarios (redteam-nightly.yml)
npm run redteam:quality    # rubric-floor scenarios only
npm run redteam:voice      # real voice sessions on the production backend; opt-in, billed per minute
npm run redteam:replay     # re-drive redacted real sessions and diff judge scores
```

All suites need `DATABASE_URL` pointing at an EMPTY, disposable database
(build one with `scripts/redteam-db-setup.sh`) and `OPENAI_API_KEY`. The CLI
forces `IMESSAGE_API_KEY` / `CRISIS_ALERT_PHONE` to empty and
`SOCKET_PG_ADAPTER=off` at startup so a run can never page the on-call or fan
emissions to live dashboards; never point it at stage or prod. Flags
(`--scenario`, `--baseline`, `--gate-quality`, `--gate-diff`, `--dry-run`,
...) are listed in `cli.ts` and explained in the doc.

## Suite map

| File | Role |
|---|---|
| `cli.ts` | Entrypoint: suite selection, variant, run loop, exit code, JUnit/summary output. |
| `replay.ts` | Production-replay entrypoint (`redteam:replay`). |
| `config.ts` | Suite definitions (smoke / full / quality / voice), run config, cost tracker. |
| `types.ts` | Scenario, beat, assertion and result types. |
| `scenarios/index.ts` | Scenario registry: `SAFETY_SCENARIOS`, `QUALITY_SCENARIOS`, suite composition. |
| `scenarios/*.ts` | One safety scenario per file (crisis ladders, passive ideation, eating disorder, substance use, minor age, medication, diagnosis seeking, delusional content, prompt injection, boundary testing, voice). |
| `scenarios/quality/*.ts` | Rubric-floor quality scenarios (first session, low mood, advice seeker, rambling venting, terse participant, stalling participant, returning participant). |
| `scenarios/_preamble.ts` | Shared persona preamble. |
| `personaDriver.ts` | LLM persona turn generator over scripted beats. |
| `harnessClient.ts` | In-process HTTP driver (supertest), socket-emission capture, DB reads. |
| `voiceClient.ts`, `liveVoiceClient.ts` | Voice drivers: Grok proxy socket and GPT-Live WebRTC, selected by `system_config.ai_model`. |
| `assertions.ts` | Assertion library: regex layer plus a temp-0 classifier where semantics matter. |
| `graderFixtures.ts` | Labelled replies (real nightly replies plus hand-written breaches) that the re-scoped graders must pass or fail. |
| `graderCalibration.test.ts` | Opt-in live check of the classifier questions against those fixtures; needs `REDTEAM_CALIBRATION_OPENAI_KEY`, skipped otherwise. |
| `judge.ts` | Wrapper over the v1 LLM judge (`sessionEval.service`) and floor-gating policy. |
| `diff.ts` | Run-to-run diffing against a baseline summary or stored `harness_runs` row (same variant only). |
| `report.ts` | JUnit XML, `summary.json` (incl. judge means/minimums and progression totals), console table. |
| `variants.ts` | `--variant`: named feature-flag sets overlaid in-process (never written to the DB). |
| `progression.ts`, `progressionJudge.ts` | Report-only session-progression metrics and the `session_progression` judge dimension. |
| `jobSummary.ts`, `ciSummary.ts` | GitHub job summary and the nightly's red/green verdict (`npm run redteam:ci-summary`). |
| `*.test.ts` | Offline unit tests (assertions, diff, judge policy, suite composition, voice helpers); run in the normal `npm test`. |

Results are written to `redteam-results/` (gitignored). Scheduled in-app runs
go through `src/server/services/harnessRunner.service.ts`, which shells out
to `cli.ts` with `REDTEAM_TRIGGER` set.
