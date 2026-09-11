-- 099_gpt_live_voices.sql — GPT-Live voice catalogue and model cutover
--
-- Companion to 098_gpt_live.sql. That migration added the storage; this one
-- flips the running configuration over to GPT-Live and publishes the twelve new
-- voices introduced with gpt-live-1.
--
-- The voice metadata mirrors src/server/utils/liveSessionConfig.ts
-- (LIVE_NATIVE_VOICES / LIVE_LEGACY_VOICES). Both exist on purpose: the server
-- validates against the TypeScript registry so a bad admin edit can never 400 a
-- session mid-handshake, while system_config drives what the participant sees in
-- the picker and stays admin-editable. Keep them in sync when either changes.

-- ---------------------------------------------------------------------------
-- 1. Voice catalogue
-- ---------------------------------------------------------------------------
-- Native GPT-Live voices are listed first so they surface at the top of the
-- picker. The ten Realtime-era voices are retained and enabled: the docs name
-- `marin` (a Realtime voice) as the GPT-Live default, so the original set is
-- still accepted, and keeping them means participants already enrolled with a
-- saved preference are not silently reassigned a different voice partway
-- through the study.
--
-- `default_voice` moves from 'cedar' to 'marin' — the documented GPT-Live
-- default. This only affects participants with NO saved preference; existing
-- preferences in user_preferences are untouched.
UPDATE system_config
SET config_value = '{
  "voices": [
    {"value": "gleam",    "label": "Gleam",    "description": "Bright and clear (North American)",  "enabled": true},
    {"value": "meridian", "label": "Meridian", "description": "Even and grounded (North American)", "enabled": true},
    {"value": "delta",    "label": "Delta",    "description": "Warm Southern lilt",                 "enabled": true},
    {"value": "cinder",   "label": "Cinder",   "description": "Low and unhurried (Southern U.S.)",  "enabled": true},
    {"value": "vesper",   "label": "Vesper",   "description": "Measured (British)",                 "enabled": true},
    {"value": "willow",   "label": "Willow",   "description": "Soft (Irish)",                       "enabled": true},
    {"value": "stone",    "label": "Stone",    "description": "Steady (Irish)",                     "enabled": true},
    {"value": "quartz",   "label": "Quartz",   "description": "Crisp (Australian)",                 "enabled": true},
    {"value": "ripple",   "label": "Ripple",   "description": "Relaxed (Australian)",               "enabled": true},
    {"value": "beacon",   "label": "Beacon",   "description": "Open (Filipino)",                    "enabled": true},
    {"value": "bossa",    "label": "Bossa",    "description": "Brazilian Portuguese",               "enabled": true},
    {"value": "tempo",    "label": "Tempo",    "description": "Brazilian Portuguese",               "enabled": true},
    {"value": "marin",    "label": "Marin",    "description": "Clear and professional",             "enabled": true},
    {"value": "cedar",    "label": "Cedar",    "description": "Warm and natural",                   "enabled": true},
    {"value": "alloy",    "label": "Alloy",    "description": "Neutral and balanced",               "enabled": true},
    {"value": "ash",      "label": "Ash",      "description": "Clear and articulate",               "enabled": true},
    {"value": "ballad",   "label": "Ballad",   "description": "Smooth and melodic",                 "enabled": true},
    {"value": "coral",    "label": "Coral",    "description": "Gentle and friendly",                "enabled": true},
    {"value": "echo",     "label": "Echo",     "description": "Warm and approachable",              "enabled": true},
    {"value": "sage",     "label": "Sage",     "description": "Calm and soothing",                  "enabled": true},
    {"value": "shimmer",  "label": "Shimmer",  "description": "Bright and energetic",               "enabled": true},
    {"value": "verse",    "label": "Verse",    "description": "Dynamic and expressive",             "enabled": true}
  ],
  "default_voice": "marin"
}'::jsonb
WHERE config_key = 'voices';

-- ---------------------------------------------------------------------------
-- 2. Model cutover
-- ---------------------------------------------------------------------------
-- The voice model. Anything not matching gpt-live-* is rejected by
-- POST /api/live/session with a loud server-side error rather than being
-- forwarded to OpenAI, so this value is now load-bearing.
UPDATE system_config
SET config_value = jsonb_set(
      COALESCE(config_value, '{}'::jsonb), '{model}', '"gpt-live-1"'::jsonb, true
    )
WHERE config_key = 'ai_model';

INSERT INTO system_config (config_key, config_value)
SELECT 'ai_model', '{"model": "gpt-live-1"}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ai_model');

-- The delegated reasoning backend. GPT-Live handles the spoken conversation and
-- hands substantive therapeutic work to this model, so it — not ai_model — is
-- what determines clinical response quality. Admin-editable for the same reason
-- ai_model is: the study team needs to pin it without a redeploy.
INSERT INTO system_config (config_key, config_value)
SELECT 'live_backend_model', '"gpt-5.6-terra"'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'live_backend_model');

-- ---------------------------------------------------------------------------
-- 2b. Per-session backend model pinning
-- ---------------------------------------------------------------------------
-- Model pinning (ai-therapist-61) records the EXACT model strings each session
-- ran on, so a session stays reproducible even when an alias moves under us
-- mid-study. A GPT-Live voice session now runs on TWO models, and ai_model
-- captures only the voice one.
--
-- Without this column the model that actually produced the clinical content
-- would only be recoverable from session_llm_usage.model where
-- purpose='live_delegation' — and only if the session happened to make at least
-- one delegated call. A session where the participant never triggered
-- delegation would have no record of its backend at all. That is an IRB
-- reproducibility gap, so it gets a real column.
--
-- It also makes sideband re-attach correct after a deploy: without it, a
-- restarted process re-attaches every session with the CURRENT default backend
-- rather than the one that session was pinned to.
ALTER TABLE session_configurations
  ADD COLUMN IF NOT EXISTS live_backend_model TEXT;

COMMENT ON COLUMN session_configurations.live_backend_model IS
  'Delegated Responses backend model for a GPT-Live voice session (e.g. gpt-5.6-terra). NULL for chat sessions and for pre-GPT-Live Realtime sessions.';

-- ---------------------------------------------------------------------------
-- 3. Transcription config retirement
-- ---------------------------------------------------------------------------
-- GPT-Live transcribes both sides internally and emits session.*_transcript.delta.
-- There is no audio.input.transcription block to configure, and a grep confirms
-- this codebase has no offline /audio/transcriptions path either — so these two
-- keys now have NO readers at all. The server-side helpers that consumed them
-- (utils/transcriptionConfig.ts, getTranscriptionModel) were deleted in the same
-- change.
--
-- The rows are left in place rather than deleted so that migration 097's history
-- stays coherent and a rollback has something to restore. They are inert.
UPDATE system_config
SET config_value = COALESCE(config_value, '{}'::jsonb) || '{"_deprecated": "unused since GPT-Live migration (099) — GPT-Live transcribes internally"}'::jsonb
WHERE config_key IN ('transcription_model', 'transcription_context')
  AND jsonb_typeof(COALESCE(config_value, '{}'::jsonb)) = 'object';
