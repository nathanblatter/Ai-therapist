-- 062: disclaimer once-per-session wording in stored system prompts
-- (ai-therapist-124 voice-eval finding).
--
-- The 019 seed instructs "Always **remind users you are not licensed**" and
-- "Remind users of limits if conversation goes off-scope", which makes the
-- model re-disclaim on ordinary turns — violating the once-at-start policy the
-- code default (DEFAULT_SYSTEM_PROMPT) and the disclaimer-exactly-once-at-start
-- red-team assertion encode. Prod's REALTIME prompt was hand-fixed on
-- 2026-07-23 but the CHAT prompt and every freshly-seeded DB (CI red-team
-- included) still carry the old text.
--
-- Targeted string replacement, guarded on the exact stale sentences: a prompt
-- already fixed (prod realtime) or manually rewritten is left untouched.

UPDATE system_config
SET config_value = jsonb_set(
      config_value,
      '{realtime,prompt}',
      to_jsonb(
        replace(
          replace(
            config_value->'realtime'->>'prompt',
            'Always **remind users you are not licensed**, and your help is **not a substitute for professional therapy/medical care**.',
            '**Once, at the start of the session**, make clear you are **not licensed** and that your help is **not a substitute for professional therapy/medical care** — then do NOT repeat this disclaimer in later replies unless the participant asks about your limits or requests diagnosis/medical advice.'
          ),
          'Remind users of limits if conversation goes off-scope (e.g., diagnosis, ongoing medical topics).',
          'Give this disclaimer only ONCE, at the start — do NOT repeat it in subsequent replies. Re-state your limits only if the conversation goes off-scope (e.g., they request diagnosis or ongoing medical advice).'
        )
      )
    ),
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'migration 062 (disclaimer once/session)'
WHERE config_key = 'system_prompts'
  AND config_value->'realtime'->>'prompt' LIKE '%Always **remind users you are not licensed**%';

UPDATE system_config
SET config_value = jsonb_set(
      config_value,
      '{chat,prompt}',
      to_jsonb(
        replace(
          replace(
            config_value->'chat'->>'prompt',
            'Always **remind users you are not licensed**, and your help is **not a substitute for professional therapy/medical care**.',
            '**Once, at the start of the session**, make clear you are **not licensed** and that your help is **not a substitute for professional therapy/medical care** — then do NOT repeat this disclaimer in later replies unless the participant asks about your limits or requests diagnosis/medical advice.'
          ),
          'Remind users of limits if conversation goes off-scope (e.g., diagnosis, ongoing medical topics).',
          'Give this disclaimer only ONCE, at the start — do NOT repeat it in subsequent replies. Re-state your limits only if the conversation goes off-scope (e.g., they request diagnosis or ongoing medical advice).'
        )
      )
    ),
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'migration 062 (disclaimer once/session)'
WHERE config_key = 'system_prompts'
  AND config_value->'chat'->>'prompt' LIKE '%Always **remind users you are not licensed**%';
