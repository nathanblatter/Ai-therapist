-- 100_gpt_live_model_description.sql — correct the ai_model description string
--
-- Migration 099 flipped system_config.ai_model.model to 'gpt-live-1' with
-- jsonb_set on the {model} key only, which left the sibling `description`
-- reading "Latest highest-quality realtime model". That string is surfaced in
-- the admin System Config UI, so the dashboard was labelling a GPT-Live model
-- as a Realtime one.
--
-- Split out as its own migration rather than edited into 099, which has already
-- been applied to stage — rewriting an applied migration would leave the two
-- environments diverged with no record of why.

UPDATE system_config
SET config_value = jsonb_set(
      COALESCE(config_value, '{}'::jsonb),
      '{description}',
      '"Full-duplex voice model; delegates reasoning to the backend in live_backend_model"'::jsonb,
      true
    )
WHERE config_key = 'ai_model'
  AND config_value->>'model' LIKE 'gpt-live%';
