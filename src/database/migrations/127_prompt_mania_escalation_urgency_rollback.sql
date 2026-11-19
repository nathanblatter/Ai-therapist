-- Rollback 127: put the post-125 wording back in the stored prompts.
--
-- Restores "call escalate_to_human." with no urgency, which led the model to
-- escalate possible mania as a crisis (high urgency: crisis flag and page).
-- Use it only to back out a faulty apply, not as a steady state.
--
-- Acts only on a row 127 itself last wrote (updated_by starts with
-- 'migration 127 '), only on the prompts named in that stamp, and only while
-- each still holds exactly the text 127 wrote (md5 below). Anything else (an
-- admin save since, a prompt 127 skipped) is left alone with a NOTICE. Apply
-- with psql so the NOTICEs are visible.
--
--   text written by 127  md5 c46bd7fbcf91f25f0109a4a54403151e
--   restored text        md5 cef2f94ab7d84b98d9fb28438d3a9db5

DO $$
DECLARE
  known_old_md5 constant text := 'cef2f94ab7d84b98d9fb28438d3a9db5';
  target_md5 constant text := 'c46bd7fbcf91f25f0109a4a54403151e';
  stamp_prefix constant text := 'migration 127 (mania escalation urgency): ';
  mania_old constant text :=
    E'do one steadying thing (ask about safety or sleep, slow down); call escalate_to_human. Ordinary faith is not a symptom.';
  mania_new constant text :=
    E'do one steadying thing (ask about safety or sleep, slow down); call escalate_to_human with urgency medium, not high (high raises a crisis alert), unless they also say they want to harm themselves or someone else. Ordinary faith is not a symptom.';
  cfg jsonb;
  who text;
  k text;
  p text;
  oldp text;
  reverted int := 0;
BEGIN
  SELECT config_value, updated_by INTO cfg, who FROM system_config WHERE config_key = 'system_prompts' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'rollback 127: no system_prompts row; nothing to do';
    RETURN;
  END IF;
  IF who IS NULL OR left(who, length(stamp_prefix)) <> stamp_prefix THEN
    RAISE NOTICE 'rollback 127: system_prompts was last written by "%", not migration 127; LEFT ALONE', coalesce(who, '(null)');
    RETURN;
  END IF;

  FOREACH k IN ARRAY string_to_array(substr(who, length(stamp_prefix) + 1), '+') LOOP
    p := cfg -> k ->> 'prompt';
    IF p IS NULL OR md5(p) <> target_md5 THEN
      RAISE NOTICE 'rollback 127: stored % prompt (md5 %) is not what migration 127 wrote; LEFT ALONE', k, coalesce(md5(p), '(none)');
      CONTINUE;
    END IF;
    oldp := replace(p, mania_new, mania_old);
    IF md5(oldp) <> known_old_md5 THEN
      RAISE EXCEPTION 'rollback 127: restored % prompt has md5 %, expected %', k, md5(oldp), known_old_md5;
    END IF;
    cfg := jsonb_set(cfg, ARRAY[k, 'prompt'], to_jsonb(oldp));
    reverted := reverted + 1;
    RAISE NOTICE 'rollback 127: restored the post-125 wording in the stored % prompt', k;
  END LOOP;

  IF reverted > 0 THEN
    UPDATE system_config
    SET config_value = cfg,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = 'rollback 127'
    WHERE config_key = 'system_prompts';
  END IF;
END $$;
