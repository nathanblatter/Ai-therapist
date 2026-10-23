-- Rollback for 110_seed_runtime_config_defaults.sql
--
-- Removes only the rows this migration created: untouched seeds still hold the
-- exact default value and have never been stamped by an admin (updated_by IS
-- NULL). A row that predated 110 (ON CONFLICT DO NOTHING skipped it) or that an
-- operator has since edited is left in place, because deleting it would drop
-- a real setting, not a seed.
BEGIN;

DELETE FROM system_config AS sc
USING (VALUES
    ('crisis', '{"risk_model": "gpt-4o-mini", "risk_check_min_score": 40}'::jsonb),
    ('evals', '{"auto_run_enabled": false, "judge_model": "gpt-4o-mini", "judge_models": ["gpt-4o-mini", "gpt-5-mini"], "self_consistency_runs": 1, "drift_window": 20, "drift_baseline": 100, "drift_threshold": 0.5, "drift_min_window": 10, "drift_page_enabled": false, "harness_schedule": {"enabled": false, "suite": "voice", "hour_utc": 9, "variations": 1}}'::jsonb),
    ('message_embeddings', '{"enabled": true}'::jsonb),
    ('redaction_verifier', '{"enabled": true, "backend": "auto", "threshold": 0.5}'::jsonb),
    ('attention_ranking', '{"crisis_open": 100, "risk_high": 60, "escalation_open": 50, "inactive": 25, "unread_messages": 20, "mood_low": 15, "practice_overdue": 10, "inactivity_days": 14, "low_mood_threshold": 3}'::jsonb),
    ('email_notifications', '{"enabled": true}'::jsonb),
    ('coping_strategies', '{}'::jsonb),
    ('grok_voice', '{"vad": {"threshold": 0.85, "silence_duration_ms": 500, "prefix_padding_ms": 333}, "reasoning_effort": "none", "speed": 1.0}'::jsonb),
    ('grok_refusal_guard', '{"enabled": true, "patterns": ["i cant help with that", "i cannot help with that", "im not able to help with that", "i am not able to help with that", "i cant assist with that", "i cannot assist with that", "i wont be able to help with that", "sorry i cant help", "i cant continue with this"], "maxChars": 200, "steerAfter": 2, "recoverAfter": 4}'::jsonb),
    ('client_logging', '{"enabled": false}'::jsonb)
) AS seed(config_key, config_value)
WHERE sc.config_key = seed.config_key
  AND sc.config_value = seed.config_value
  AND sc.updated_by IS NULL;

COMMIT;
