-- Migration 060: deployment_mode system-config flag (pass-4 groundwork).
-- Date: 2026-08-14
--
-- 'research' (default) is the IRB study posture: all research/study surfaces
-- visible in the admin UI. 'clinical' is the therapist-pilot posture: the
-- research-only nav items (Study Ops, Consent Versions, dataset Export) are
-- hidden. This is UI framing only — no server-side authorization changes.

INSERT INTO system_config (config_key, config_value, description) VALUES
(
    'deployment_mode',
    '{"mode": "research"}'::jsonb,
    'Deployment posture: research (IRB study, all research surfaces visible) or clinical (therapist pilot, research-only admin views hidden)'
)
ON CONFLICT (config_key) DO NOTHING;
