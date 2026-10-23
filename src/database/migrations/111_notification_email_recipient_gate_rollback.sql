-- Rollback for 111_notification_email_recipient_gate.sql
--
-- Removes only the seeded row when it still holds the seeded value and has
-- never been stamped by an admin; an edited row is a real setting and stays.
-- Without the row the reader fails closed (no notification email), the same
-- behaviour the seed expresses.
BEGIN;

DELETE FROM system_config
WHERE config_key = 'notification_email_recipients'
  AND config_value = '{"enabled": false, "allowed_domains": []}'::jsonb
  AND updated_by IS NULL;

COMMIT;
