-- Rollback 091: restore the care-team-only CHECKs. Fails if researcher-owned
-- rows exist — delete or reassign them first (SELECT ... WHERE clinician_role
-- = 'researcher' / sender_role = 'researcher' / raised_by_role = 'researcher').

ALTER TABLE message_threads DROP CONSTRAINT message_threads_clinician_role_check;
ALTER TABLE message_threads ADD CONSTRAINT message_threads_clinician_role_check
  CHECK (clinician_role IN ('therapist', 'caseworker'));

ALTER TABLE thread_messages DROP CONSTRAINT thread_messages_sender_role_check;
ALTER TABLE thread_messages ADD CONSTRAINT thread_messages_sender_role_check
  CHECK (sender_role IN ('participant', 'therapist', 'caseworker'));

ALTER TABLE escalations DROP CONSTRAINT escalations_raised_by_role_check;
ALTER TABLE escalations ADD CONSTRAINT escalations_raised_by_role_check
  CHECK (raised_by_role IN ('caseworker', 'therapist'));

ALTER TABLE work_items DROP CONSTRAINT work_items_assignee_role_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_assignee_role_check
  CHECK (assignee_role IN ('caseworker', 'therapist'));
