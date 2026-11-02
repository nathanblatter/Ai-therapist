-- 117: the Crisis Protocol must keep the assistant IN the conversation.
--
-- The stored prompts (seeded by 019 and never touched by a later migration)
-- still tell the model, on a risk disclosure, to "immediately stop normal
-- conversation", state that it "cannot handle crises", give resources and ask
-- whether the participant will seek help. A voice model following that script
-- says goodbye and calls end_session: it hangs up on someone who has just said
-- they want to die. The code default (sessionHelpers.DEFAULT_SYSTEM_PROMPT)
-- gained a "stay present" rule on 2026-09-24 (bda428d), but the database prompt
-- is what every session actually runs, so the fix never reached participants.
--
-- This rewrites the whole Crisis Protocol block in both the realtime and the
-- chat prompt. Guarded on the exact text of the two known variants (019's
-- original, and the 2026-09-24 default in case an admin pasted it in); a
-- customised prompt that matches neither is left alone and logged by the
-- NOTICE at the bottom.
--
-- Also allows action_type 'model_end_refused' in intervention_actions: the
-- end_session tool now refuses a model-initiated end on a crisis-flagged
-- session, and that refusal is an intervention the participant experienced.

-- The replacement block. {{crisis_text}} is interpolated at runtime.
CREATE TEMP TABLE crisis_protocol_117 AS
SELECT
  E'## Crisis Protocol\n**If user expresses risk (suicidality, harm, acute crisis):**\n- **Immediately stop normal conversation**\n- Urge them to seek emergency help (e.g., {{crisis_text}}).\n- State: you are **AI and cannot handle crises**\n- Give resources and ask if they\'ll seek help.\n- Do not provide advice or continue therapeutic conversation until user is safe.\n- If user reports hallucinations/delusions, urge urgent professional evaluation. **Internally log crisis and referrals if possible.**'
    AS old_019,
  E'## Crisis Protocol\n**If user expresses risk (suicidality, harm, acute crisis):**\n- **Immediately stop normal conversation**\n- Urge them to seek emergency help (e.g., {{crisis_text}}).\n- State: you are **AI and cannot handle crises**\n- Give resources and ask if they\'ll seek help.\n- Stay present and keep replies short while they connect with help; do not resume normal therapeutic conversation or exercises until they are safe. Never say or imply that you will stop talking to them or leave.\n- If user reports hallucinations/delusions, urge urgent professional evaluation. **Internally log crisis and referrals if possible.**'
    AS old_default,
  E'## Crisis Protocol\n**If the participant expresses risk (suicidal thoughts, self-harm, harming others, acute crisis):**\n- **Stay. The most important thing is that you do not disappear.** Keep talking with them, slow down, and keep replies short and warm.\n- Respond to what they said directly: acknowledge it, take it seriously, ask about their immediate safety, and listen. Do not minimize it or change the subject.\n- Share the crisis resources ({{crisis_text}}) as help that can be alongside you, not instead of you. Offer to stay with them while they call or text, and ask whether someone could be with them in person.\n- Be honest about your limits without withdrawing: you are an AI and not a crisis service, and you are staying right here with them. Never say or imply that you cannot help them, that you will stop talking, or that they need to leave this conversation.\n- **Never end the session yourself because risk came up.** Do not call end_session, say goodbye, or wind the conversation down during a safety concern. The only reasons to end are that the participant clearly asks to stop, or the system instructs you to wrap up. If they want to stop, share the resources once more and leave the door open.\n- Set normal therapeutic exercises and problem-solving aside until they are safe; return to them only when the participant is steady and wants to.\n- If they report hallucinations/delusions, urge urgent professional evaluation. **Internally log crisis and referrals if possible.**'
    AS new_block;

UPDATE system_config
SET config_value = jsonb_set(
      config_value,
      '{realtime,prompt}',
      to_jsonb(
        replace(
          replace(config_value->'realtime'->>'prompt', p.old_019, p.new_block),
          p.old_default,
          p.new_block
        )
      )
    ),
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'migration 117 (crisis protocol: stay present, never end the session)'
FROM crisis_protocol_117 p
WHERE config_key = 'system_prompts'
  AND (
    config_value->'realtime'->>'prompt' LIKE '%' || p.old_019 || '%'
    OR config_value->'realtime'->>'prompt' LIKE '%' || p.old_default || '%'
  );

UPDATE system_config
SET config_value = jsonb_set(
      config_value,
      '{chat,prompt}',
      to_jsonb(
        replace(
          replace(config_value->'chat'->>'prompt', p.old_019, p.new_block),
          p.old_default,
          p.new_block
        )
      )
    ),
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'migration 117 (crisis protocol: stay present, never end the session)'
FROM crisis_protocol_117 p
WHERE config_key = 'system_prompts'
  AND (
    config_value->'chat'->>'prompt' LIKE '%' || p.old_019 || '%'
    OR config_value->'chat'->>'prompt' LIKE '%' || p.old_default || '%'
  );

-- A prompt this migration could not rewrite (customised text) FAILS the
-- migration rather than warning: the node runner does not surface NOTICEs, and
-- a green deploy that left the hang-up script in place is the worst outcome.
-- Fix the stored prompt's Crisis Protocol by hand (or restore a known variant)
-- and re-run.
DO $$
DECLARE
  rt text;
  ch text;
BEGIN
  SELECT config_value->'realtime'->>'prompt', config_value->'chat'->>'prompt'
    INTO rt, ch
    FROM system_config WHERE config_key = 'system_prompts';
  IF rt IS NOT NULL AND rt NOT LIKE '%Never end the session yourself because risk came up.%' THEN
    RAISE EXCEPTION 'migration 117: the stored realtime prompt matched no known Crisis Protocol block and was not rewritten; update it by hand and re-run';
  END IF;
  IF ch IS NOT NULL AND ch NOT LIKE '%Never end the session yourself because risk came up.%' THEN
    RAISE EXCEPTION 'migration 117: the stored chat prompt matched no known Crisis Protocol block and was not rewritten; update it by hand and re-run';
  END IF;
END $$;

DROP TABLE crisis_protocol_117;

ALTER TABLE intervention_actions DROP CONSTRAINT IF EXISTS intervention_actions_action_type_check;
ALTER TABLE intervention_actions ADD CONSTRAINT intervention_actions_action_type_check
  CHECK (action_type IN (
    'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
    'supervisor_review', 'clinical_review', 'handoff_initiated',
    'monitoring_increased', 'external_api_called', 'auto_flag', 'manual_flag',
    'risk_steering', 'ai_escalation', 'crisis_sms_alert', 'safety_protocol',
    'eligibility_minor_end', 'voice_refusal_recovery', 'model_end_refused',
    'model_end_participant_requested'
  ));
