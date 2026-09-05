-- 090: correct stale crisis_contact copy (IRB claims audit, 2026-09-04).
-- Migration 007 seeded system_config.crisis_contact with the wrong Crisis Text
-- Line keyword ("HELLO"; the service uses HOME) and a CAPS-only hotline with no
-- 988. This row is interpolated into the live agent's crisis protocol
-- ({{crisis_text}} in the system prompt), served by /api/config/crisis, and
-- spoken in the participant greeting, so a stale row is participant-facing
-- crisis copy. Preserves each environment's enabled flag; only corrects copy.
-- Note: the stored text field deliberately omits the leading "Text " because
-- both render templates prepend "text " themselves.
UPDATE system_config
SET config_value = jsonb_build_object(
      'enabled', COALESCE((config_value->>'enabled')::boolean, true),
      'hotline', '988 Suicide & Crisis Lifeline',
      'phone', '988',
      'text', 'HOME to 741741'
    ),
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'migration_090'
WHERE config_key = 'crisis_contact'
  AND (config_value->>'text' ILIKE '%hello%'
       OR COALESCE(config_value->>'phone', '') NOT LIKE '%988%');
