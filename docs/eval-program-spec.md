# Eval Program Spec — 50-hour development plan

**Audience:** Jacob (implementing developer). **Owner:** Nathan Blatter. **Date:** 2026-09-16.
**Read first:** `docs/eval-system.md`, `docs/redteam.md`, `plans/covalStyleEvalsPlan.md`, repo `CLAUDE.md`.

This doc is the contract for ~50 hours of eval-system work: what exists today, where the gaps are, how evals tie into the rest of the app, and a prioritized set of work packages with acceptance criteria. Work top-down through the packages; each is independently shippable.

---

## 1. Mission

The eval system serves four jobs, all in scope for this program:

1. **Safety assurance** — prove the crisis pipeline catches what it must: redteam coverage across every real pipeline (including voice), risk-score calibration, miss-rate estimation.
2. **Regression gate** — no prompt/model/pipeline change reaches participants without an eval suite passing in CI.
3. **Research-grade metrics** — defensible, publishable conversation-quality measures validated against human ratings (this is an IRB-backed study; judge scores without human ground truth are not publishable).
4. **Live quality monitoring** — continuous per-session scoring surfaced to admins/caseworkers so a session or participant going sideways is visible while it still matters.

Non-negotiables inherited from the project (see §5): participant safety and study integrity outrank everything; quality gates are the floor; no emojis anywhere in UI.

---

## 2. What exists today

The eval stack is already substantial. Do not rebuild any of this — extend it.

### 2.1 Session eval (LLM-as-judge, v1)
`src/server/services/sessionEval.service.ts`. `evaluateSession()` scores an ended session's transcript on six dimensions, 1–5 each: `safety_protocol`, `empathy`, `modality_fidelity`, `disclaimer_compliance`, `non_directiveness`, `clinical_claims`. Judge is `gpt-4o-mini` at temperature 0, JSON-mode, `store: false`, capped at `MAX_TRANSCRIPT_CHARS = 24000`. Results upsert to `session_evals` (migration 034), keyed by `EVAL_PROMPT_VERSION = 'v1'` — **bump the version on any rubric/prompt change**, scores across versions are not comparable.

Runs three ways:
- CLI: `src/database/scripts/runEvals.ts` (`--session <id>`, `--all-ended`, `--force`, `--judge-model`)
- API: `GET|POST /admin/api/sessions/:sessionId/eval`
- Auto-run on session end via `maybeAutoEvalSession()` — double-gated on env `EVALS_ENABLED` (stage only) AND `system_config.evals.auto_run_enabled`. Skips `is_demo` and sandbox sessions. **Currently off in prod.**

### 2.2 Human ratings + judge calibration (v2)
`src/server/services/evalCalibration.service.ts` — quadratic-weighted Cohen's kappa, per-dimension bias, agreement stats between human ratings (`session_human_ratings`, migration 050) and judge scores. Governance rule already encoded: **auto-run gets enabled only when κ ≥ 0.6 on every dimension with ≥ 20 paired ratings.** UI: rating form in `SessionEvalPanel.tsx`, stats in `EvalCalibrationPanel.tsx`. API: `GET /admin/api/evals/calibration`.

### 2.3 Pairwise A/B eval (v2)
`src/server/services/pairwiseEval.service.ts` — matches ended sessions within `(modality, duration_band)` strata across an axis (`ai_model` or `proactive_offering`), judges each pair in both orderings to debias position, stores in `session_eval_pairs` (051). CLI `runPairwiseEvals.ts`; Wilson-CI win rates at `GET /admin/api/analytics/pairwise`; UI `PairwiseEvalPanel.tsx`.

### 2.4 Drift monitoring (v2)
`src/server/services/evalDrift.service.ts` — after every stored eval, compares rolling mean vs baseline per `(dimension, ai_model, prompt_version)` bucket; a drop ≥ `drift_threshold` opens an `eval_drift_alerts` row (051). Paging is double-gated (`evals.drift_page_enabled`, default false, AND `crisis_alert.enabled`) and reuses the crisis iMessage path. UI `EvalDriftPanel.tsx`.

### 2.5 Counterfactual backend-model eval
`src/server/services/counterfactualEval.service.ts` (migration 101) — "holding this session and moment fixed, what would a different model have said?" `replay` mode (works on any historical session) and `fork` mode (true GPT-Live fork, non-study sessions only). CLI `runCounterfactual.ts`, optional `--judge`.

### 2.6 Redteam safety harness — `src/redteam/`
Standalone CLI (`npm run redteam:smoke|full|quality|voice`, `redteam:replay`) that boots the real server in-process and drives it via supertest, capturing crisis emissions off a monkey-patched `global.io`.
- Deterministic assertions (`assertions.ts`): disclaimer-exactly-once, no-diagnosis, no-med-advice, crisis-flag-at-step, context-not-leaked; semantic checks via temp-0 majority-vote classifier.
- LLM personas drive multi-turn scenarios (`personaDriver.ts`); judge floors via `judge.ts` (wraps sessionEval).
- Safety scenarios: crisis ladders (voice-text + chat), diagnosis-seeking, medication, prompt injection, boundary testing, minor-age. Quality scenarios: first-session, rambling-venting, terse-participant, advice-seeker, low-mood-support.
- Production replay (`replay.ts`): re-drives redacted participant turns from recent real sessions through the current pipeline, diffs judge scores vs stored evals, flags drops ≥ 1.0.
- Server-side runner `harnessRunner.service.ts`: admin-triggered/scheduled runs as a child process (paging env neutered, 30-min hard kill), persisted to `harness_runs`/`harness_scenario_results` (063), surfaced in `EvalsView.tsx`.

### 2.7 Participant simulation — `scripts/participant-sim/`
Offline synthetic-participant pipeline (fictional persona, 8 study weeks, no crisis content) exercising the full data path on a scratch DB: run sessions through the real pipeline → finalize (evals + embeddings) → fire a synthetic adverse event → run the real de-identified dataset export. Sample output checked in at `scripts/participant-sim/export-out/`. No README yet.

### 2.8 CI integration
`.github/workflows/deploy.yml`: `verify` (typecheck + `npm test`, ~137 Vitest files, all OpenAI mocked) runs in parallel with `redteam-smoke` (ephemeral `postgres:16`, `scripts/redteam-db-setup.sh`, live OpenAI); **deploy needs both** — a smoke regression blocks deploy. `redteam-nightly.yml` runs the full suite on cron, non-gating (`--allow-fail`). Neither CI job carries paging credentials, so CI can never page on-call.

---

## 3. How evals tie into the rest of the app

- **Chat pipeline:** `chatTherapy.service.ts` (`gpt-5.2` via the OpenAI Responses API, inline omni-moderation, client-rendered tools). Prompts live in the DB (migrations 019/062/093/094) edited via `SystemPrompts.tsx`; modality presets in `utils/sessionHelpers.ts`. **This is what the judge grades and what the harness drives.**
- **Voice pipeline:** production is GPT-Live (`gpt-live-1`, client secrets minted in `token.routes.ts`). The redteam voice client predates this migration and is broken (see gap G1).
- **Crisis pipeline:** `crisisPipeline.service.ts` orchestrates per-turn for both chat and realtime-text: tiered keyword screen → LLM risk assessor (`gpt-4o-mini`, bands ≥25/50/75) → moderation third tier → intervention/steering → paging. Writes `risk_score_history`, `crisis_events`, `intervention_actions`. Redteam crisis ladders assert the emitted signals end-to-end. The eval rubric's `safety_protocol` dimension mirrors this pipeline's expected behavior.
- **Admin UI:** everything eval lands under Admin → Evals/Analytics (`EvalsView`, `SessionEvalPanel`, `EvalCalibrationPanel`, `EvalDriftPanel`, `PairwiseEvalPanel`), role-gated to `therapist`/`researcher` in `evals.routes.ts`.
- **Data layer:** `session_evals` (034), `session_human_ratings` (050), `session_eval_pairs` + `eval_drift_alerts` (051), `harness_runs` + `harness_scenario_results` (063), `counterfactual_runs`/`_responses` (101). Config in the `system_config.evals` JSON blob. Query modules under `src/server/db/`.
- **Study data flow:** evals ride into the de-identified dataset export (`datasetExport.service.ts` → `evals.csv`) — eval quality is study-deliverable quality.

---

## 4. Gaps

Ordered roughly by severity.

- **G1 — Voice redteam harness is dead.** `src/redteam/voiceClient.ts` still opens `wss://api.openai.com/v1/realtime`; production voice moved to GPT-Live on 2026-09-11. The adversarial voice suite exercises nothing the app actually does. Voice is a primary study modality with zero adversarial coverage.
- **G2 — No human ground truth.** Audit 2026-09-10: `session_evals` 76, `harness_runs` 30, `risk_score_history` 700 scored messages, `crisis_events` 58 — and `session_human_ratings` = **1**. The calibration machinery (κ, bias, the κ≥0.6 auto-run rule) exists but is starved. `clinical_reviews`/`human_handoffs` were dropped in migration 035, so there is no crisis-adjudication ground truth either. Nothing judge-derived is publishable until this is fixed.
- **G3 — Risk-score calibration never analyzed.** Four signal layers logged per message (keywords, LLM score, moderation category scores, trajectory) plus outcomes — but no analysis of which layer predicts confirmed crisis, where thresholds should sit, or the miss rate on unflagged messages.
- **G4 — Quality suite doesn't gate.** Judge-floor gating was deliberately deferred until history accumulated; history has accumulated. Nightly full suite is `--allow-fail` with no diffing between runs, so a regression shows up as a log nobody reads.
- **G5 — Auto-eval off in prod.** Live monitoring is aspirational until sessions are scored as they end; that's gated (correctly) behind judge calibration, i.e. G2.
- **G6 — Single judge, no ensemble.** One `gpt-4o-mini` judge, one prompt. No second judge model, no agreement stats, no self-consistency check — a judge drifting or being systematically miscalibrated is invisible until human ratings catch it.
- **G7 — No PI-facing reporting.** Eval data is queryable and dashboarded for Nathan; nothing produces the periodic human-readable digest the PI/IRB lane needs.
- **G8 — Housekeeping.** `scripts/participant-sim/` has no README; `redteam-db-setup.sh` hand-orders migrations (no migrate-from-scratch); `gpt-5.2` cost in `redteam/config.ts` is a placeholder; minor-age scenario is non-gating with weak assertions; `crisis_sms_alert` is never asserted; `plans/covalStyleEvalsPlan.md` describes the pre-GPT-Live voice suite as built.

---

## 5. Constraints and conventions (read before writing code)

1. **Study integrity and participant safety come first.** Nothing in this program may touch prod participant data flows without gates. All harness/sim sessions must be `is_demo` and must run with paging env neutered (follow `harnessRunner.service.ts`).
2. **Flags stay off until Phase 2 approval** for participant telemetry streams. Eval features must not depend on flag-gated Phase 2 telemetry.
3. **CI gates are the floor.** Everything merges through `verify` + `redteam-smoke`; typecheck, lint, and Vitest must pass. New services get unit tests in the existing style (colocated `*.test.ts`, OpenAI mocked via `vi.mock`).
4. **Deploy only via the GitHub Actions pipeline.** Never hand-roll containers or push code to prod outside it.
5. **UI:** no emojis anywhere — react-feather icons. Match the existing admin component style (see `EvalDriftPanel.tsx` as a template). No orange in product UI.
6. **Versioning discipline:** any change to a judge prompt or rubric bumps the relevant `*_PROMPT_VERSION`; never mix versions in an analysis.
7. **Cost:** research budget spends sensibly — judges stay on mini-class models unless a work package explicitly says otherwise; batch/flex processing where latency doesn't matter (sessionEval already uses `withFlex()`).
8. **CI never pages.** Keep `IMESSAGE_API_KEY`/`CRISIS_ALERT_PHONE` out of workflow env.
9. **Stack:** TypeScript ESM, Express, raw-SQL migrations (`src/database/migrations/`, next number after current head), Vitest, React 18 admin components.

---

## 6. Work packages (~50 h)

Estimates include tests and doc updates. Order is priority order; WP1–WP4 are the must-land core.

### WP1 — Port the voice redteam harness to GPT-Live (~10 h) — closes G1
Rewrite `src/redteam/voiceClient.ts` against the GPT-Live protocol the production client actually uses (mint client secret via the same `/v1/realtime/client_secrets` path as `token.routes.ts`, speak the GPT-Live event vocabulary, solve turn-taking for a full-duplex model — likely scripted-audio or text-injection turns with explicit end-of-turn markers). Re-cost `config.ts` for GPT-Live minutes. Re-enable `voice.ts` scenarios plus the voice crisis ladder against the real pipeline.
**Accept:** `npm run redteam:voice` completes green against stage config; voice crisis-ladder asserts the same server signals as the chat ladder; suite documented in `docs/redteam.md` (replace the KNOWN GAP note); still excluded from the deploy gate until 2 weeks of clean nightly runs.

### WP2 — Human ground-truth engine (~12 h) — closes G2, unlocks G5
The calibration math exists; build the supply side.
- **Rating queue:** new admin view (under Evals) listing sessions stratified-sampled for human rating (stratify by modality × risk band × week; oversample crisis-adjacent sessions). Queue state in a new table (`eval_rating_queue`: session_id, stratum, assigned_to, status). One-click from queue item → existing rating form in `SessionEvalPanel.tsx`.
- **Blind rating:** hide judge scores until the human rating is submitted (the current panel shows them — that biases raters).
- **Second-rater flow:** a configurable fraction of queue items get assigned to two raters; compute human–human κ alongside human–judge κ so we can report inter-rater reliability.
- **Crisis adjudication:** per `crisis_events` row, a minimal confirm/false-positive/unclear adjudication field + UI (replaces what migration 035 dropped, lighter-weight). This is the ground truth WP3 needs.
- **Export:** ratings and adjudications flow into the dataset export.
**Accept:** a rater can work the queue end-to-end without touching SQL; calibration panel shows human–human and human–judge κ; ≥20 paired ratings achievable in an afternoon of rating work; adjudication status on every new crisis event.

### WP3 — Risk-score calibration harness (~8 h) — closes G3
A CLI (`src/database/scripts/runRiskCalibration.ts`) + service that joins `risk_score_history` × `crisis_events` × WP2 adjudications and reports, per signal layer (keywords / LLM score / moderation categories / trajectory): precision-recall at each threshold, current-band performance (≥25/50/75), layer-agreement matrix, and a miss-rate estimate from a stratified sample of *unflagged* messages re-scored offline (sample size configurable; use flex processing). Persist runs to a `risk_calibration_runs` table; render the latest run in a new admin panel (curves + recommended thresholds vs current).
**Accept:** one command produces a stored, dashboarded calibration report; recommendations are advisory only (threshold changes remain a Nathan decision); no participant text leaves the existing storage boundary.

### WP4 — Regression gate hardening (~7 h) — closes G4
- Promote judge-floor gating: quality suite runs on PRs that touch prompt-affecting paths (`src/server/services/chatTherapy*`, `promptContext.ts`, prompt migrations, `sessionEval` rubric) via a path-filtered workflow job; floors from accumulated nightly history (start at p10 of last 30 days per dimension, hard-fail below).
- Nightly diffing: nightly full run compares against the previous run and the 30-day baseline; regressions ≥ 1.0 on any dimension or any new hard-assertion failure produce a visible artifact (see WP7 digest) instead of dying in `--allow-fail` logs.
- Wire `redteam:replay` into the nightly schedule so real-conversation regressions are caught, not just synthetic ones.
**Accept:** a deliberately degraded prompt (test fixture) fails the PR job; nightly produces a diff artifact; replay runs appear in `harness_runs` on schedule.

### WP5 — Judge ensemble + agreement (~5 h) — closes G6
Extend `sessionEval.service.ts` to optionally run N judges (different model and/or paraphrased rubric prompt) per session and store per-judge scores + a consensus row (median) with an agreement stat. Config in `system_config.evals` (`ensemble_judges: [...]`, default single-judge to hold cost). Surface judge disagreement in `EvalCalibrationPanel` — high-disagreement sessions auto-enqueue into the WP2 rating queue (disagreement is the best signal for where human eyes are needed).
**Accept:** ensemble on/off via config with no schema breakage for existing single-judge rows; disagreement feeds the rating queue; cost per ensemble eval logged.

### WP6 — Live quality monitoring (~5 h) — closes G5
Once WP2 gets κ ≥ 0.6 on all dimensions: enable auto-eval in prod (the existing double-gate), enable drift paging (`drift_page_enabled`), and add a **per-participant quality trend** to the caseworker Catch-up view (sparkline of session eval scores + risk trajectory, flag participants whose empathy/safety scores or risk trend degrade across ≥3 sessions). Uses only Phase-1-authorized data (chat text + timestamps derivatives).
**Accept:** sessions score within minutes of ending in prod; drift alert fires on a synthetic drop in stage; caseworker view shows trend with zero new PII collected. **Do not enable prod auto-run until Nathan confirms the κ threshold is met.**

### WP7 — PI/IRB reporting (~4 h) — closes G7
A weekly digest generator (service + CLI + cron'd via the existing scheduler pattern): sessions evaluated, score trends per dimension, drift alerts opened/acked, harness pass rates, crisis events + adjudication outcomes, calibration status (κ table), open gaps. Output: markdown rendered to the admin UI and downloadable; tone/content suitable for forwarding to the PI. No auto-emailing — Nathan sends it.
**Accept:** one command/cron produces the digest from live data; a non-engineer can read it; zero identified participant data in it.

### WP8 — Housekeeping sweep (~4 h) — closes G8
README for `scripts/participant-sim/`; single `migrate-from-scratch` script replacing the hand-ordered list in `redteam-db-setup.sh` (CI uses it); verify/fix `gpt-5.2` pricing in `redteam/config.ts` and switch cost estimates to real usage tokens where the API returns them; assert `crisis_sms_alert` intent in the harness (assert the *decision to page*, not the send); strengthen minor-age scenario assertions to whatever the current `minorSafeguard.service.ts` behavior guarantees; update `plans/covalStyleEvalsPlan.md` status notes.
**Accept:** fresh clone → sim run works from README alone; CI green on the new migration script.

**Total: ~55 h estimated** — expect ~50 delivered; WP8 and parts of WP6 are the flex if estimates run long. If everything lands early, the backlog has two graded next steps: alliance/rupture detection over live sessions, and evaluating gpt-oss-safeguard as a self-hosted policy-conditioned crisis classifier (both filed in flightdeck).

---

## 7. Working agreement

- One PR per work package (WP2 may split into rating-queue and adjudication PRs). Every PR: typecheck + lint + Vitest green, redteam smoke green, no new emoji/orange, migration numbered after current head.
- Judge/rubric prompt changes bump prompt versions and are called out in the PR description.
- Anything ambiguous about **thresholds, gating, or prod enablement** is a Nathan decision — propose, don't flip.
- Log notable decisions in the PR description; Nathan mirrors them to flightdeck.
- Stage is the playground (`EVALS_ENABLED` lives there); prod changes ride the pipeline only.

## 8. Open decisions for Nathan

1. **Who rates?** WP2 assumes Nathan + RAs as raters; if RAs need accounts, that's an IAM ask (Nathan-gated).
2. **Second judge model** for WP5: another OpenAI mini-tier model vs. a different-family model (better independence, new vendor surface). Default plan: OpenAI-only until told otherwise.
3. **PR-gating floors** (WP4): start advisory-warning for a week before hard-failing? Default plan: hard-fail from day one, per "gates are the floor."
