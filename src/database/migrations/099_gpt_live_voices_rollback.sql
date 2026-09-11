-- Rollback for 099_gpt_live_voices.sql
--
-- Restores the pre-GPT-Live voice catalogue and model. NOTE: this alone does not
-- restore a working Realtime voice path — the Realtime client secret endpoint,
-- sideband implementation and client handshake were all replaced in the same
-- change. Treat this as configuration rollback only; a true revert is a git
-- revert of the migration commit.

UPDATE system_config
SET config_value = '{
  "voices": [
    {"value": "alloy",   "label": "Alloy",   "description": "Neutral & balanced",   "enabled": true},
    {"value": "ash",     "label": "Ash",     "description": "Clear & articulate",   "enabled": true},
    {"value": "ballad",  "label": "Ballad",  "description": "Smooth & melodic",     "enabled": true},
    {"value": "cedar",   "label": "Cedar",   "description": "Warm & natural",       "enabled": true},
    {"value": "coral",   "label": "Coral",   "description": "Gentle & friendly",    "enabled": true},
    {"value": "echo",    "label": "Echo",    "description": "Warm & approachable",  "enabled": true},
    {"value": "marin",   "label": "Marin",   "description": "Clear & professional", "enabled": true},
    {"value": "sage",    "label": "Sage",    "description": "Calm & soothing",      "enabled": true},
    {"value": "shimmer", "label": "Shimmer", "description": "Bright & energetic",   "enabled": true},
    {"value": "verse",   "label": "Verse",   "description": "Dynamic & expressive", "enabled": true}
  ],
  "default_voice": "cedar"
}'::jsonb
WHERE config_key = 'voices';

UPDATE system_config
SET config_value = jsonb_set(
      COALESCE(config_value, '{}'::jsonb), '{model}', '"gpt-realtime-2.1-mini"'::jsonb, true
    )
WHERE config_key = 'ai_model';

DELETE FROM system_config WHERE config_key = 'live_backend_model';

ALTER TABLE session_configurations DROP COLUMN IF EXISTS live_backend_model;

UPDATE system_config
SET config_value = config_value - '_deprecated'
WHERE config_key IN ('transcription_model', 'transcription_context')
  AND jsonb_typeof(COALESCE(config_value, '{}'::jsonb)) = 'object';
