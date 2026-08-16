-- Rollback for 062: restore the pre-062 "always remind" disclaimer wording in
-- stored system prompts. Guarded on the 062 replacement text so manually
-- edited prompts are left untouched.

UPDATE system_config
SET config_value = jsonb_set(
      config_value,
      '{realtime,prompt}',
      to_jsonb(
        replace(
          replace(
            config_value->'realtime'->>'prompt',
            '**Once, at the start of the session**, make clear you are **not licensed** and that your help is **not a substitute for professional therapy/medical care** — then do NOT repeat this disclaimer in later replies unless the participant asks about your limits or requests diagnosis/medical advice.',
            'Always **remind users you are not licensed**, and your help is **not a substitute for professional therapy/medical care**.'
          ),
          'Give this disclaimer only ONCE, at the start — do NOT repeat it in subsequent replies. Re-state your limits only if the conversation goes off-scope (e.g., they request diagnosis or ongoing medical advice).',
          'Remind users of limits if conversation goes off-scope (e.g., diagnosis, ongoing medical topics).'
        )
      )
    ),
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'migration 062 rollback'
WHERE config_key = 'system_prompts'
  AND config_value->'realtime'->>'prompt' LIKE '%Once, at the start of the session%';

UPDATE system_config
SET config_value = jsonb_set(
      config_value,
      '{chat,prompt}',
      to_jsonb(
        replace(
          replace(
            config_value->'chat'->>'prompt',
            '**Once, at the start of the session**, make clear you are **not licensed** and that your help is **not a substitute for professional therapy/medical care** — then do NOT repeat this disclaimer in later replies unless the participant asks about your limits or requests diagnosis/medical advice.',
            'Always **remind users you are not licensed**, and your help is **not a substitute for professional therapy/medical care**.'
          ),
          'Give this disclaimer only ONCE, at the start — do NOT repeat it in subsequent replies. Re-state your limits only if the conversation goes off-scope (e.g., they request diagnosis or ongoing medical advice).',
          'Remind users of limits if conversation goes off-scope (e.g., diagnosis, ongoing medical topics).'
        )
      )
    ),
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'migration 062 rollback'
WHERE config_key = 'system_prompts'
  AND config_value->'chat'->>'prompt' LIKE '%Once, at the start of the session%';
