# system_config key catalog

`system_config` (migration 007) is the runtime-editable settings table:
one row per `config_key`, a JSONB `config_value`, a `description`, and
`updated_at` / `updated_by`. The server reads it three ways:

- `getSystemConfig()` (`src/server/utils/sessionHelpers.ts`) loads every row
  into a cached map and consumers read `config.<key>`. Call
  `invalidateConfigCache()` after a write.
- `getSystemConfigByKey(key)` (`src/server/db/config.queries.ts`) for a single
  row, uncached.
- Raw `SELECT ... WHERE config_key = '...'` in a few services that also write
  the row back (retention, evals, drift guard, work queue).

Admin access: `GET /admin/api/config` lists every row (therapist, researcher),
`GET /admin/api/config/:key` reads one, and `PUT /admin/api/config/:key`
(researcher only, `src/server/routes/admin/config.routes.ts`) writes ANY key
whose row already exists (it is an UPDATE, not an upsert; only `voices` and
`languages` are schema-validated). So "admin-editable" below distinguishes
keys the admin UI (`src/client/admin/components/SystemConfig.tsx`) exposes
from keys that are only reachable through the generic PUT or psql.

This catalog was produced on 2026-10-22 (ai-therapist-240) by grepping every
`system_config` read, write, and seed across `src/`, `scripts/`, and
`src/database/migrations/`. Re-run the grep when adding a key; the anomalies
section at the end is the part most likely to go stale.

## Keys

| Key | JSON shape (fields the code reads) | Seeded by | Read by | Admin-editable |
|---|---|---|---|---|
| `ai_model` | `{model: string, description?: string}`. The voice/session model id; `grok-voice-*` selects the Grok proxy, `gpt-live-*` GPT-Live. Code default `gpt-live-1`. | 014 (gpt-realtime-mini), bumped by 030, 099 (gpt-live-1), 100 (description) | `stats.queries.getAiModel()` and through it `liveSession.routes`, `grokSession.routes`, `config.routes` (public), `src/redteam/voiceClient`; `sidebandManager`; `studyOps.queries` (protocol snapshot) | UI (Model tab) |
| `live_backend_model` | bare JSON string, e.g. `"gpt-5.6-terra"`: the delegated reasoning model behind GPT-Live | 099 | `liveSession.routes`, `sidebandManager` (reconnect), `counterfactualEval.service` | generic PUT only |
| `transcription_model` | `{model: string, description?: string}` | 030 (gpt-4o-mini-transcribe), 097, 099 | nothing on the server (see anomalies) | UI (Model tab) |
| `transcription_context` | `{prompt?, keywords?: string[], languages?: string[]}`; `{}` = code defaults | 097 (also touched by 099) | nothing (see anomalies) | generic PUT only |
| `system_prompts` | `{realtime: {prompt, last_modified?}, chat: {...}, modality_presets?: {...}, active_modality?: string\|null}` | 019; rewritten by 062, 093, 094 | `sessionHelpers.getSystemPrompt` / `getActiveModality`; `studyOps.queries` | UI (Prompts tab, modality defaults) |
| `features` | flag object: `voice_enabled`, `chat_enabled`, `file_upload_enabled`, `session_recording_enabled`, `disabled_tools: string[]`, `phase_guidance_enabled`, `regrounding_enabled`, `regrounding_interval_minutes`, `proactive_offering: {mode: always\|never\|ab_test}`, `telemetry_acoustic_features`, `telemetry_interaction_timing`, `telemetry_engagement_events`, `telemetry_admin_usage` | 007; flags added by 009, 095, 096 | `config.routes` (public), `sessions.routes`, `chat.routes`, `liveSession.routes`, `grokSession.routes`, `consent.routes`, `engagementEvents.routes`, `telemetry.routes`, `adminUsage.routes`, `sessionHelpers`, `phaseGuidance`, `toolRegistry`, `sidebandManager`, `acousticFeatures.service`; `studyOps.queries` | UI (Features tab) |
| `session_limits` | `{enabled, max_duration_minutes, max_sessions_per_day, cooldown_minutes}` | 007 | `sessionHelpers.checkSessionLimits`, `rateLimits.routes` (public + admin), `phaseGuidance`, `toolRegistry`; `studyOps.queries` | UI (Limits tab) |
| `crisis_contact` | `{hotline, phone, text, enabled}` | 007; corrected by 090 | `config.routes` (public), `chat.routes`, `liveSession.routes`, `grokSession.routes`, `sessionHelpers` | UI (Crisis tab) |
| `crisis_alert` | `{enabled: boolean, phone: string\|null, note?}`; null phone falls back to `CRISIS_ALERT_PHONE`. Read-only in this audit: do not change its semantics without the on-call SOP. | 044; forced `enabled=false` by `scripts/redteam-seed.sql` in CI | `crisisAlert.service.resolveAlertTarget` | UI (Crisis tab) |
| `crisis` | `{risk_model?: string, risk_check_min_score?: number}`; defaults gpt-4o-mini / 40 | never seeded | `crisisDetection.service.resolveRiskModel`, `crisisIntervention.service.resolveRiskCheckMinScore` | generic PUT only (row must be created by hand first) |
| `voices` | `{voices: [{value, label, description?, enabled}], default_voice}` (shape since 017; 007 seeded the older `enabled_voices` list) | 007; reshaped by 017, 099 | `config.routes` (public), `users.routes`, `src/redteam/voiceClient` | UI (Voices tab, validated) |
| `languages` | `{languages: [{value, label, enabled}], default_language}` (007 seeded `enabled_languages`; 017 reshaped) | 007; reshaped by 017 | `config.routes` (public), `users.routes`, `sessionHelpers.getLanguageName`, `toolRegistry` | UI (Languages tab, validated) |
| `client_logging` | `{enabled: boolean}`; absent = disabled | `src/database/scripts/addClientLoggingConfig.js` only (no migration) | `config.routes` (public) | UI (Debug toggle) |
| `deployment_mode` | `{mode: 'research' \| 'clinical'}` | 060 | `utils/consent.resolveConsentAudience`; admin `config.routes` synthesises `research` when the row is missing | UI (Deployment tab) |
| `content_retention` | `{enabled, retention_hours, wipe_time, require_redaction_complete, last_wipe_at, last_wipe_count}` | 020 | `contentWipe.service` (reads, and writes `last_wipe_*` back) | `PUT /admin/api/content-retention` (`contentRetention.routes`) |
| `data_retention` | `{enabled, recordings_retention_days, wiped_user_grace_days, run_time, last_run_at, last_run_deletions}` | 053 (ships disabled) | `dataRetention.service` (reads, writes `last_run_*` back) | `PUT /admin/api/data-retention` (`contentRetention.routes`) |
| `study_protocol` | `{expected_sessions_per_participant, study_start, study_end, arm_imbalance_threshold}` | 053 | `studyOps.queries.getStudyProtocol` | `PUT /admin/api/study-ops/protocol` (`studyOps.routes`) |
| `evals` | `{auto_run_enabled?, judge_model?, judge_models?: string[], self_consistency_runs?, drift_window?, drift_baseline?, drift_threshold?, drift_min_window?, drift_page_enabled?, harness_schedule?}` | never seeded by a migration; `harnessRunner.setHarnessSchedule` upserts the row on first schedule save | `sessionEval.service`, `pairwiseEval.service`, `evalDrift.service`, `harnessRunner.service`, `src/database/scripts/runEvals.ts`, `src/redteam` (judge ensemble) | `PUT /admin/api/harness/schedule` writes `harness_schedule`; other fields generic PUT only |
| `message_embeddings` | `{enabled: boolean}`; absent = enabled | never seeded | `messageEmbedding.service.getSettings` | generic PUT only |
| `redaction_verifier` | `{enabled?, backend?: 'decisions'\|'responses'\|'auto', threshold?: 0..1}` | never seeded | `redactionVerifier.service.getVerifierConfig` | generic PUT only |
| `attention_ranking` | partial override of `DEFAULT_ATTENTION_RANKING` (`practice_overdue`, `inactivity_days`, `low_mood_threshold`, ...) | never seeded | `caseworkerDashboard.routes.loadRankingConfig` | generic PUT only |
| `email_notifications` | bare boolean or `{enabled: boolean}`; absent = enabled | never seeded | `emailer.service.emailNotificationsEnabled` | generic PUT only |
| `coping_strategies` | `Record<category, [{name, how}]>` merged over `DEFAULT_COPING_LIBRARY` | never seeded | `utils/copingLibrary.getCopingLibrary` | generic PUT only |
| `grok_voice` | `{vad: {threshold, silence_duration_ms, prefix_padding_ms}, reasoning_effort: 'none'\|'high', speed}` | never seeded | `grokSession.routes` (coerced by `utils/grokVoiceConfig`) | UI (Grok turn-taking form) but the row must exist first, since PUT is an UPDATE |
| `grok_refusal_guard` | `{enabled, patterns: string[], ...thresholds}` | never seeded | `grokSession.routes` (coerced by `utils/grokRefusalGuard`), `grokVoiceManager` | generic PUT only |
| `qualtrics.survey_hash.<surveyId>` | bare JSON string (definition hash) | runtime-written by `qualtricsDriftGuard.service` | `qualtricsDriftGuard.service` | internal, do not edit |
| `qualtrics.drift_last_check_date` | bare JSON string `YYYY-MM-DD` (America/Denver) | runtime-written by `qualtricsDriftGuard.service` | `qualtricsDriftGuard.service` (daily claim) | internal, do not edit |
| `work_queue.last_sweep_date` | bare JSON string `YYYY-MM-DD` | runtime-written by `workQueue.service` | `workQueue.service` (daily claim) | internal, do not edit |
| `sim_session_NN` | `{sessionId, week, slot, title}` | `scripts/participant-sim/run-sessions.ts` (dev/stage simulation only) | `scripts/participant-sim/backdate.sql` | internal, dev only |

Migration numbers refer to `src/database/migrations/NNN_*.sql`. `studyOps.queries`
also lists `ai_model`, `system_prompts`, `session_limits` and `features` rows whose
`updated_at` falls inside the study window as protocol-deviation flags.

## Anomalies

### Read but never seeded

These keys are consulted at runtime but no migration creates the row, so the
code's built-in default applies until someone inserts the row by hand (the
admin PUT cannot create it):

- `crisis` (risk assessor model and trigger score)
- `evals` (created lazily only when a harness schedule is saved; until then
  every eval setting is the code default)
- `message_embeddings`
- `redaction_verifier`
- `attention_ranking`
- `email_notifications`
- `coping_strategies`
- `grok_voice` (the admin form exists but 404s/UPDATEs nothing until the row exists)
- `grok_refusal_guard`
- `client_logging` is seeded, but only by a one-off script
  (`src/database/scripts/addClientLoggingConfig.js`) that is not part of any
  migration run; a fresh database has no row and the public config route
  falls back to `{enabled: false}`.

If any of these should be operator-visible, the fix is a small `INSERT ...
ON CONFLICT DO NOTHING` migration with the code default as the seed value.

### Seeded but never read

- `transcription_model`: seeded by 030, rewritten by 097 and 099, editable in
  the admin Model tab, but no server module reads it (the transcription model
  is chosen in code since the GPT-Live migration). The admin control is
  cosmetic.
- `transcription_context`: seeded by 097 as `{}` with a description promising
  prompt/keyword overrides, but nothing reads it.

Both are candidates for either a read site or a cleanup migration; this
document only records the state.

### Noted, not changed

- `crisis_alert` is left exactly as seeded and as documented in
  `docs/on-call-sop.md`; this audit is read-only on it.
- The generic `PUT /admin/api/config/:key` validates only `voices` and
  `languages`. Every other key accepts arbitrary JSON from a researcher
  account.
