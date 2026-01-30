-- Rollback Migration 018: Remove Room Assignment System

-- Drop indexes
DROP INDEX IF EXISTS idx_room_queue_user;
DROP INDEX IF EXISTS idx_room_queue_room;
DROP INDEX IF EXISTS idx_room_assignments_room;
DROP INDEX IF EXISTS idx_room_assignments_type;
DROP INDEX IF EXISTS idx_room_assignments_user;

-- Drop tables
DROP TABLE IF EXISTS room_queue;
DROP TABLE IF EXISTS room_assignments;
