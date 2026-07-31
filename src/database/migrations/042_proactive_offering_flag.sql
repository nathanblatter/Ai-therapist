-- Migration: Proactive-vs-reactive exercise offering research condition
-- (ai-therapist-74)
-- Date: 2026-07-30
--
-- Records which arm of the proactive-offering A/B condition a session was
-- assigned to, so researchers can correlate the system-prompt steering
-- (see sessionHelpers.buildProactiveOfferingGuidance) with outcomes.
-- Assignment happens in token.routes.ts at session-creation time.

ALTER TABLE session_configurations
  ADD COLUMN IF NOT EXISTS proactive_offering BOOLEAN;

COMMENT ON COLUMN session_configurations.proactive_offering IS
  'ai-therapist-74 A/B condition: TRUE = model was steered to proactively offer exercises, FALSE = reactive-only, NULL = feature not evaluated for this session';
