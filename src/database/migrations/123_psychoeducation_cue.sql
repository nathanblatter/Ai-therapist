-- 123: psychoeducation_cue — per-session arm of the retrieval-cue experiment
-- (ai-therapist-202).
--
-- Records whether a session's tool guidance told the model when to call
-- retrieve_psychoeducation. Assigned 50/50 per session at session start, the
-- same way as proactive_offering (migration 042), and only while
-- system_config features.psychoeducation_cue_ab_enabled is true. Until this
-- migration is applied the server runs every session as control (no cue) and
-- records nothing.
--
-- Tool-call outcomes per arm: join tool_invocations on session_id.

ALTER TABLE session_configurations
  ADD COLUMN IF NOT EXISTS psychoeducation_cue BOOLEAN;

COMMENT ON COLUMN session_configurations.psychoeducation_cue IS
  'ai-therapist-202 A/B condition: TRUE = tool guidance cued retrieve_psychoeducation, FALSE = control (no cue), NULL = experiment off for this session (no cue)';
