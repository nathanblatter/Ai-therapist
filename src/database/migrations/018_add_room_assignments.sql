-- Migration 018: Add Room Assignment System
-- Description: Adds tables for room assignments, researcher stations, and room queues

-- Create room_assignments table for tracking current assignments
CREATE TABLE IF NOT EXISTS room_assignments (
  assignment_id SERIAL PRIMARY KEY,
  assignment_type VARCHAR(20) NOT NULL CHECK (assignment_type IN ('room', 'monitoring', 'checkin')),
  room_number INTEGER CHECK (room_number BETWEEN 1 AND 5 OR room_number IS NULL),
  position INTEGER CHECK (position BETWEEN 1 AND 3 OR position IS NULL),
  user_id INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

  -- Ensure unique assignments
  CONSTRAINT unique_room_assignment UNIQUE (assignment_type, room_number, position)
);

-- Create room_queue table for on-deck participants
CREATE TABLE IF NOT EXISTS room_queue (
  queue_id SERIAL PRIMARY KEY,
  room_number INTEGER NOT NULL CHECK (room_number BETWEEN 1 AND 5),
  queue_position INTEGER NOT NULL CHECK (queue_position BETWEEN 1 AND 4),
  user_id INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

  -- Ensure unique position in each room's queue
  CONSTRAINT unique_queue_position UNIQUE (room_number, queue_position)
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_room_assignments_user ON room_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_room_assignments_type ON room_assignments(assignment_type);
CREATE INDEX IF NOT EXISTS idx_room_assignments_room ON room_assignments(room_number) WHERE room_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_room_queue_room ON room_queue(room_number);
CREATE INDEX IF NOT EXISTS idx_room_queue_user ON room_queue(user_id);

-- Add comments for documentation
COMMENT ON TABLE room_assignments IS 'Tracks current room and researcher station assignments';
COMMENT ON TABLE room_queue IS 'Tracks on-deck participants waiting for each room';
COMMENT ON COLUMN room_assignments.assignment_type IS 'Type: room (participant in room 1-5), monitoring (RA 1-3), checkin (RA 1-2)';
COMMENT ON COLUMN room_assignments.room_number IS 'Room number (1-5) for participant assignments, NULL for researcher stations';
COMMENT ON COLUMN room_assignments.position IS 'Position number for monitoring (1-3) or checkin (1-2), NULL for rooms';
COMMENT ON COLUMN room_queue.queue_position IS 'Position in queue (1-4) for each room';
