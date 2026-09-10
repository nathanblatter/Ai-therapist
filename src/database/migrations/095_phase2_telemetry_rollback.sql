-- Rollback for migration 095: Phase 2 research telemetry.

BEGIN;

DROP VIEW IF EXISTS participant_session_rhythm;
DROP TABLE IF EXISTS session_acoustic_features;
DROP TABLE IF EXISTS engagement_events;

UPDATE system_config
SET config_value = config_value
      - 'telemetry_interaction_timing'
      - 'telemetry_engagement_events'
      - 'telemetry_acoustic_features'
WHERE config_key = 'features';

COMMIT;
