-- 091: researcher joins the care-comms role CHECKs.
-- The researcher role is the unscoped study role with full admin access
-- (2026-09-09 decision: it must be able to exercise every admin surface,
-- driven by the therapist stress-test). Three CHECK constraints still
-- excluded it from acting: owning message threads, sending thread messages,
-- and raising escalations. Caseload assignment (therapist_clients.member_role)
-- deliberately stays care-team-only — researchers are unscoped and never
-- need an assignment edge.

ALTER TABLE message_threads DROP CONSTRAINT message_threads_clinician_role_check;
ALTER TABLE message_threads ADD CONSTRAINT message_threads_clinician_role_check
  CHECK (clinician_role IN ('therapist', 'caseworker', 'researcher'));

ALTER TABLE thread_messages DROP CONSTRAINT thread_messages_sender_role_check;
ALTER TABLE thread_messages ADD CONSTRAINT thread_messages_sender_role_check
  CHECK (sender_role IN ('participant', 'therapist', 'caseworker', 'researcher'));

ALTER TABLE escalations DROP CONSTRAINT escalations_raised_by_role_check;
ALTER TABLE escalations ADD CONSTRAINT escalations_raised_by_role_check
  CHECK (raised_by_role IN ('caseworker', 'therapist', 'researcher'));

-- Work items flow the actor's role into assignee_role (escalation_response
-- items for the raiser; messaging notification items for the thread owner).
ALTER TABLE work_items DROP CONSTRAINT work_items_assignee_role_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_assignee_role_check
  CHECK (assignee_role IN ('caseworker', 'therapist', 'researcher'));
