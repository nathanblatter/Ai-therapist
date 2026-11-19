-- 127: tell the model which urgency to use when it escalates possible mania
-- or unusual beliefs, so a sleepless, elated participant is not handled as a
-- suicide crisis.
--
-- Date: 2026-11-19. Depends on 125 (the stored text this guards on is what 125
-- leaves behind). Runs in its own transaction at its numeric position.
--
-- The problem (red-team re-measurement after PR #39, docs/redteam.md "Mania
-- escalation urgency"): the "Days without sleep, racing grand plans, or unusual
-- beliefs" bullet that 125 added says "call escalate_to_human" and nothing
-- about urgency. In 8 of 8 rel-elevated-mood runs the model called it with
-- urgency high, which raises a full crisis flag (flagSessionCrisis + the high
-- risk response: page, crisis card). From then on the risk assessor is woken
-- by the session's context on every turn, the chat gets crisis steering, and
-- the next reply drops the plan and the referral the participant needed and
-- asks only whether they are thinking of ending their life. With urgency
-- medium (the tool alerts the monitoring team without a crisis flag) the
-- model called it with medium in 4 of 4 runs, nothing paged, and the reply
-- went back to pausing the plan, protecting the money and naming same-day care.
--
-- One edit, byte-for-byte what sessionHelpers.DEFAULT_SYSTEM_PROMPT now holds,
-- applied to both the realtime and the chat prompt:
--   mania  "call escalate_to_human." -> "call escalate_to_human with urgency
--          medium, not high (high raises a crisis alert), unless they also say
--          they want to harm themselves or someone else."
-- The Crisis Protocol and every other section are untouched. The edited text is
-- identical in the stored and the code-default section order.
--
-- Guarded on the WHOLE prompt, exactly like 124 and 125: each prompt is
-- rewritten only if its md5 is the known post-125 text. A prompt already at the
-- target is a no-op; any other text (hand-edited) is left alone with a NOTICE
-- naming its md5. Nothing here fails on an unexpected prompt: the NOTICE is the
-- signal, so apply this with psql (runMigrationRange.js does not print NOTICEs)
-- and read the output.
--
--   known pre-127 text  md5 cef2f94ab7d84b98d9fb28438d3a9db5  (20526 chars)
--   text after 127      md5 c46bd7fbcf91f25f0109a4a54403151e  (20652 chars)
--
-- updated_by records which prompts this migration actually rewrote
-- ("...: realtime+chat"); the rollback only touches those, and only while the
-- row is still stamped by this migration.

DO $$
DECLARE
  known_old_md5 constant text := 'cef2f94ab7d84b98d9fb28438d3a9db5';
  target_md5 constant text := 'c46bd7fbcf91f25f0109a4a54403151e';
  mania_old constant text :=
    E'do one steadying thing (ask about safety or sleep, slow down); call escalate_to_human. Ordinary faith is not a symptom.';
  mania_new constant text :=
    E'do one steadying thing (ask about safety or sleep, slow down); call escalate_to_human with urgency medium, not high (high raises a crisis alert), unless they also say they want to harm themselves or someone else. Ordinary faith is not a symptom.';
  cfg jsonb;
  k text;
  p text;
  newp text;
  written text[] := ARRAY[]::text[];
BEGIN
  SELECT config_value INTO cfg FROM system_config WHERE config_key = 'system_prompts' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'migration 127: no system_prompts row; nothing to do (sessions use the code default, which already has this wording)';
    RETURN;
  END IF;

  FOREACH k IN ARRAY ARRAY['realtime', 'chat'] LOOP
    p := cfg -> k ->> 'prompt';
    IF p IS NULL THEN
      RAISE NOTICE 'migration 127: no stored % prompt; nothing to do', k;
    ELSIF md5(p) = target_md5 THEN
      RAISE NOTICE 'migration 127: stored % prompt already has the escalation-urgency wording; left unchanged', k;
    ELSIF md5(p) <> known_old_md5 THEN
      RAISE NOTICE 'migration 127: stored % prompt (md5 %) is not the known post-125 text; LEFT ALONE. Make the change by hand in Admin -> System Config.', k, md5(p);
    ELSE
      newp := replace(p, mania_old, mania_new);
      IF md5(newp) <> target_md5 THEN
        -- Cannot happen for the known input; a bug here must not write anything.
        RAISE EXCEPTION 'migration 127: rewritten % prompt has md5 %, expected %', k, md5(newp), target_md5;
      END IF;
      cfg := jsonb_set(cfg, ARRAY[k, 'prompt'], to_jsonb(newp));
      written := written || k;
      RAISE NOTICE 'migration 127: rewrote the stored % prompt (mania escalation urgency)', k;
    END IF;
  END LOOP;

  IF cardinality(written) > 0 THEN
    UPDATE system_config
    SET config_value = cfg,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = 'migration 127 (mania escalation urgency): ' || array_to_string(written, '+')
    WHERE config_key = 'system_prompts';
  END IF;
END $$;
