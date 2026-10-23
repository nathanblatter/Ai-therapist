-- Migration 110: seed the system_config rows the server reads but never seeded (ai-therapist-275).
-- Date: 2026-10-22
--
-- Ten keys were consulted at runtime with a code default but had no migration
-- creating the row (docs/system-config-keys.md, "Read but never seeded"), and
-- the admin PUT was an UPDATE, so on a fresh database the Grok Voice form and
-- the email_notifications kill switch reported success and changed nothing.
-- Each value below is EXACTLY the default the reader falls back to when the
-- row is absent (verified against the read site named in the description), so
-- applying this migration changes no behaviour; it only makes the setting
-- visible and editable. ON CONFLICT DO NOTHING leaves existing rows alone.
BEGIN;

INSERT INTO system_config (config_key, config_value, description) VALUES
(
    'crisis',
    '{"risk_model": "gpt-4o-mini", "risk_check_min_score": 40}'::jsonb,
    'Crisis risk assessor: risk_model runs the assessment (crisisDetection.resolveRiskModel), risk_check_min_score (0-100) is the score at which the model is steered to run the risk check (crisisIntervention.resolveRiskCheckMinScore)'
),
(
    'evals',
    '{"auto_run_enabled": false, "judge_model": "gpt-4o-mini", "judge_models": ["gpt-4o-mini", "gpt-5-mini"], "self_consistency_runs": 1, "drift_window": 20, "drift_baseline": 100, "drift_threshold": 0.5, "drift_min_window": 10, "drift_page_enabled": false, "harness_schedule": {"enabled": false, "suite": "voice", "hour_utc": 9, "variations": 1}}'::jsonb,
    'Eval-system settings (drift monitoring, harness schedule): LLM-judge ensemble and auto-run gate (sessionEval, pairwiseEval), drift detector thresholds (evalDrift), nightly red-team harness schedule (harnessRunner)'
),
(
    'message_embeddings',
    '{"enabled": true}'::jsonb,
    'Background embedding of redacted messages for semantic search (messageEmbedding.service); enabled=false pauses the embedder'
),
(
    'redaction_verifier',
    '{"enabled": true, "backend": "auto", "threshold": 0.5}'::jsonb,
    'LLM leak check on redacted transcripts (redactionVerifier.service): backend decisions | responses | auto, threshold 0..1 is the leak probability that flags a message'
),
(
    'attention_ranking',
    '{"crisis_open": 100, "risk_high": 60, "escalation_open": 50, "inactive": 25, "unread_messages": 20, "mood_low": 15, "practice_overdue": 10, "inactivity_days": 14, "low_mood_threshold": 3}'::jsonb,
    'Needs-attention scoring for the caseworker dashboard roster (caseworkerDashboard.routes): points per reason, inactivity window in days, low-mood cutoff'
),
(
    'email_notifications',
    '{"enabled": true}'::jsonb,
    'Kill switch for all outbound email (emailer.service); enabled=false makes every send a logged no-op'
),
(
    'coping_strategies',
    '{}'::jsonb,
    'Per-category overrides for the built-in coping technique library (utils/copingLibrary): {"<category>": [{"name", "how"}]} replaces that category; {} keeps the code defaults'
),
(
    'grok_voice',
    '{"vad": {"threshold": 0.85, "silence_duration_ms": 500, "prefix_padding_ms": 333}, "reasoning_effort": "none", "speed": 1.0}'::jsonb,
    'Grok Voice turn-taking and latency knobs forwarded to session.update (utils/grokVoiceConfig): vad.threshold 0.1-0.9, vad.silence_duration_ms and vad.prefix_padding_ms 0-10000, reasoning_effort none | high, speed 0.7-1.5'
),
(
    'grok_refusal_guard',
    '{"enabled": true, "patterns": ["i cant help with that", "i cannot help with that", "im not able to help with that", "i am not able to help with that", "i cant assist with that", "i cannot assist with that", "i wont be able to help with that", "sorry i cant help", "i cant continue with this"], "maxChars": 200, "steerAfter": 2, "recoverAfter": 4}'::jsonb,
    'Grok Voice refusal-loop breaker (utils/grokRefusalGuard): normalized substrings that mark a canned refusal in a short turn (maxChars), consecutive refusals before the system steer (steerAfter) and the server-authored recovery line (recoverAfter)'
),
(
    'client_logging',
    '{"enabled": false}'::jsonb,
    'Enable client-side console logging for debugging'
)
ON CONFLICT (config_key) DO NOTHING;

COMMIT;
