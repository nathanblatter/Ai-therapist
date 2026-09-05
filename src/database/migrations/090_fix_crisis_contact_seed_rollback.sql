-- 090 rollback: intentional no-op. The forward migration corrects factually
-- wrong participant-facing crisis contact copy (HELLO -> HOME, adds 988);
-- restoring the incorrect copy would be unsafe.
SELECT 1;
