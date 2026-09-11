-- Rollback for 100_gpt_live_model_description.sql
-- Restores the pre-099 description string. Cosmetic only.

UPDATE system_config
SET config_value = jsonb_set(
      COALESCE(config_value, '{}'::jsonb),
      '{description}',
      '"Latest highest-quality realtime model"'::jsonb,
      true
    )
WHERE config_key = 'ai_model';
