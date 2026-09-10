-- Migration 097: migrate transcription to gpt-transcribe (ai-therapist-166).
-- Date: 2026-09-09
--
-- OpenAI deprecated whisper-1 and the gpt-4o(-mini)-transcribe family on
-- 2026-08-26 with shutdown 2027-02-26. gpt-transcribe is the replacement for
-- committed-turn realtime transcription and adds context inputs (prompt,
-- keywords, languages) that improve fidelity on crisis vocabulary, campus
-- resources, and medication names — the words the crisis keyword screen and
-- redaction pipeline depend on.
--
-- Model pinning note: only the exact old alias is rewritten. A deliberately
-- pinned dated snapshot (e.g. gpt-4o-mini-transcribe-2025-12-15) is left
-- alone — that is an admin decision — but it dies on the same 2027-02-26
-- shutdown, so re-pin before then.

BEGIN;

UPDATE system_config
SET config_value = jsonb_set(config_value, '{model}', '"gpt-transcribe"')
WHERE config_key = 'transcription_model'
  AND config_value->>'model' = 'gpt-4o-mini-transcribe';

-- Transcription context (prompt/keywords/languages) — admin-tunable override
-- for the code defaults in utils/transcriptionConfig.ts. Seeded empty so the
-- code defaults apply until an admin customizes it.
INSERT INTO system_config (config_key, config_value, description) VALUES
(
  'transcription_context',
  '{}'::jsonb,
  'Optional overrides for gpt-transcribe context: {prompt, keywords[], languages[]}. Empty = code defaults (crisis vocabulary + campus resources).'
)
ON CONFLICT (config_key) DO NOTHING;

COMMIT;
