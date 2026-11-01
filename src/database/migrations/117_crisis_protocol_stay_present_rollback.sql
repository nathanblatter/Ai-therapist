-- Rollback 117: restore the 019 Crisis Protocol block and the 105 action_type list.
--
-- Both known pre-117 variants collapse to 019's text on rollback; that is the
-- text every deployed database actually held. Rows with 'model_end_refused'
-- must be removed before the CHECK can be reinstated.

CREATE TEMP TABLE crisis_protocol_117_rb AS
SELECT
  E'## Crisis Protocol\n**If the participant expresses risk (suicidal thoughts, self-harm, harming others, acute crisis):**\n- **Stay. The most important thing is that you do not disappear.** Keep talking with them, slow down, and keep replies short and warm.\n- Respond to what they said directly: acknowledge it, take it seriously, ask about their immediate safety, and listen. Do not minimize it or change the subject.\n- Share the crisis resources ({{crisis_text}}) as help that can be alongside you, not instead of you. Offer to stay with them while they call or text, and ask whether someone could be with them in person.\n- Be honest about your limits without withdrawing: you are an AI and not a crisis service, and you are staying right here with them. Never say or imply that you cannot help them, that you will stop talking, or that they need to leave this conversation.\n- **Never end the session yourself because risk came up.** Do not call end_session, say goodbye, or wind the conversation down during a safety concern. The only reasons to end are that the participant clearly asks to stop, or the system instructs you to wrap up. If they want to stop, share the resources once more and leave the door open.\n- Set normal therapeutic exercises and problem-solving aside until they are safe; return to them only when the participant is steady and wants to.\n- If they report hallucinations/delusions, urge urgent professional evaluation. **Internally log crisis and referrals if possible.**'
    AS new_block,
  E'## Crisis Protocol\n**If user expresses risk (suicidality, harm, acute crisis):**\n- **Immediately stop normal conversation**\n- Urge them to seek emergency help (e.g., {{crisis_text}}).\n- State: you are **AI and cannot handle crises**\n- Give resources and ask if they\'ll seek help.\n- Do not provide advice or continue therapeutic conversation until user is safe.\n- If user reports hallucinations/delusions, urge urgent professional evaluation. **Internally log crisis and referrals if possible.**'
    AS old_019;

UPDATE system_config
SET config_value = jsonb_set(
      config_value,
      '{realtime,prompt}',
      to_jsonb(replace(config_value->'realtime'->>'prompt', p.new_block, p.old_019))
    ),
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'rollback 117'
FROM crisis_protocol_117_rb p
WHERE config_key = 'system_prompts';

UPDATE system_config
SET config_value = jsonb_set(
      config_value,
      '{chat,prompt}',
      to_jsonb(replace(config_value->'chat'->>'prompt', p.new_block, p.old_019))
    ),
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'rollback 117'
FROM crisis_protocol_117_rb p
WHERE config_key = 'system_prompts';

DROP TABLE crisis_protocol_117_rb;

DELETE FROM intervention_actions WHERE action_type = 'model_end_refused';

ALTER TABLE intervention_actions DROP CONSTRAINT IF EXISTS intervention_actions_action_type_check;
ALTER TABLE intervention_actions ADD CONSTRAINT intervention_actions_action_type_check
  CHECK (action_type IN (
    'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
    'supervisor_review', 'clinical_review', 'handoff_initiated',
    'monitoring_increased', 'external_api_called', 'auto_flag', 'manual_flag',
    'risk_steering', 'ai_escalation', 'crisis_sms_alert', 'safety_protocol',
    'eligibility_minor_end', 'voice_refusal_recovery'
  ));
