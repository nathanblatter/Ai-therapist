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
npm run redteam:voice-safety  # safety families over real voice + GPT-Live checks (redteam-voice.yml)
npm run redteam:extended   # slow or expensive scenarios (long chat conversations); opt-in, not scheduled
npm run redteam:voice-crawl   # GPT-Live guide CRAWL: one spoken turn at a critical point, seeded history
npm run redteam:voice-walk    # CRAWL turns under acoustic conditions (synthetic fallback)
npm run redteam:voice-run     # simulated participant in one full-duplex call
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
| `scenarios/protocol/*.ts` | Protocol scenarios from `docs/eval-scenario-catalogue.md` (honesty about confidentiality and reporting, minors hard refusal, eligibility leaks, withdrawal, abuse disclosures). In the full suite, except the two minors-refusal scenarios, which are on demand only (`extended`; see docs/redteam.md). |
| `protocolAssertions.ts`, `protocolRubricFixtures.ts` | Assertions for those scenarios, written against the consent form and the prompt, and the synthetic transcripts (pass and must-fail) that test them. `protocolRubrics.live.test.ts` runs the fixtures through the real classifier (opt-in). |
| `participantIdentity.ts` | Refuses to run `requiresReservedParticipant` scenarios unless the harness participant has a reserved userid (OpenAI safety-identifier collision, ai-therapist-306). |
| `scenarios/crisis/*.ts` | The crisis group from `docs/eval-scenario-catalogue.md` (every CRI id that runs on chat or realtime-text, plus GATE-02), one catalogue entry per file, each scenario tagged with `catalogueIds`. Design, the CRI coverage map, measured pass rates and known gaps: `docs/redteam-crisis-scenarios.md`. |
| `crisisAssertions.ts` | Assertions for the crisis group: pipeline state, reply regexes, one classifier question per Crisis Protocol promise. |
| `crisisFixtures.ts` | Test-only fixtures and probes for the crisis group: assessor made unreachable, `end_session` guard probe, session-timer probe. |
| `knownGap.ts` | Known product gaps: listed assertions report loudly on every run and do not gate until the filed bug is fixed. |
| `crisisRubrics.live.test.ts` | Opt-in calibration of the crisis classifier questions against the real classifier (skipped in `npm test`). |
| `scenarios/_preamble.ts` | Shared persona preamble. |
| `personaDriver.ts` | LLM persona turn generator over scripted beats. |
| `generatedVariants.ts` | Opt-in seeded adversarial variants (`--generated-variants <n>`): mutation operators, cached generation, validity guard, assertion inheritance. Off by default, never in CI. |
| `harnessClient.ts` | In-process HTTP driver (supertest), socket-emission capture, DB reads. Chat sessions start through `startFreshChat` and run inside `driveChatSession`, so every scenario gets a new session that is ended even when a turn throws (ai-therapist-307). |
| `sessionCost.ts` | App-side cost of each session from `session_llm_usage` (chat replies, crisis assessor, redaction, insights), estimates where no counts exist, and the cost caveats in `summary.json` (docs/redteam.md "How run cost is counted"). |
| `voiceClient.ts`, `liveVoiceClient.ts` | Voice drivers: Grok proxy socket and GPT-Live WebRTC, selected by `system_config.ai_model`. |
| `relationalAssertions.ts` | REL/LIT-14/USE-08/ARM assertions (sycophancy, dependence, faith, exercise-offer counts, tool log). |
| `arms.ts` | Forces the proactive_offering arm in-process for the ARM scenarios. |
| `scenarios/gates/*.ts` | Catalogue GATE-01, GATE-03 to GATE-06 and STAFF-10 on the `http` pipeline: session-start gates, RBAC and audit rows, driven through the real routes with no model and no judge (identical under `--dry-run`). `support.ts` holds the account seeding, probe recorder and clock helper. |
| `scenarios/relational/*.ts`, `scenarios/arms/*.ts` | Catalogue REL-*, USE-08 and ARM-01/02 scenarios. |
| `liveVoiceChecks.ts` | GPT-Live checks: which layer answered each turn, client probes, risk/resource assertions, and what a participant gets around a vendor cut (resources at the cut, time to the first recovery words, the crisis line in the opening). |
| `voiceSummary.ts` | Markdown job summary for `redteam-voice.yml`. |
| `voice/` | OpenAI's GPT-Live evaluation guide, our implementation: `timeline.ts` (one clock for audio and events), `metrics.ts` / `aggregate.ts` (latency, response rate, interruptions, silence during delegation, delegation accuracy, consumption, vendor-cut timing; P50/P90), `scenarios.ts` (CRAWL / WALK / RUN suites), `sessionInput.ts` (seeded history), `acoustics.ts` (WALK conditions), `callerPeer.ts` + `runMode.ts` (RUN simulated participant). See docs/redteam.md "GPT-Live evaluation guide". |
| `assertions.ts` | Assertion library: regex layer plus a temp-0 classifier where semantics matter. |
| `graderFixtures.ts` | Labelled replies (real nightly replies plus hand-written breaches) that the re-scoped graders must pass or fail. |
| `graderCalibration.test.ts` | Opt-in live check of the classifier questions against those fixtures; needs `REDTEAM_CALIBRATION_OPENAI_KEY`, skipped otherwise. |
| `judge.ts` | Wrapper over the v1 LLM judge (`sessionEval.service`) and floor-gating policy. |
| `diff.ts` | Run-to-run diffing against a baseline summary or stored `harness_runs` row (same variant only). |
| `report.ts` | JUnit XML, `summary.json` (incl. judge means/minimums and progression totals), console table. |
| `variants.ts` | `--variant`: named feature-flag sets overlaid in-process (never written to the DB). |
| `progression.ts`, `progressionJudge.ts` | Report-only session-progression metrics and the `session_progression` judge dimension. |
| `jobSummary.ts`, `ciSummary.ts` | GitHub job summary and the nightly's red/green verdict (`npm run redteam:ci-summary`). |
| `configSnapshot.ts` | `--config-snapshot <file>`: load an environment's evaluated configuration into the eval DB (config drift gate, `docs/redteam.md`); a `--variant` still overlays it. |
| `configEvalClient.ts` | HTTP client the `redteam-config.yml` workflow uses to claim and record config evaluations. |
| `*.test.ts` | Offline unit tests (assertions, diff, judge policy, suite composition, voice helpers); run in the normal `npm test`. |

Results are written to `redteam-results/` (gitignored). Scheduled in-app runs
go through `src/server/services/harnessRunner.service.ts`, which shells out
to `cli.ts` with `REDTEAM_TRIGGER` set.
