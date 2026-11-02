-- Rollback 120: drop the staff outbound-mail audit table.
DROP INDEX IF EXISTS idx_outbound_mail_sender_time;
DROP TABLE IF EXISTS outbound_mail;
