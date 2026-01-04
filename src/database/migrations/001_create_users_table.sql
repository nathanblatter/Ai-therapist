-- Migration: Create users table for authentication
-- Description: Creates the users table with userid, username, password hash, and role

CREATE TABLE IF NOT EXISTS users (
  userid SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL, -- Stores bcrypt hash
  role VARCHAR(50) NOT NULL CHECK (role IN ('therapist', 'researcher', 'participant')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index on username for faster lookups
CREATE INDEX idx_users_username ON users(username);

-- Create index on role for filtering users by role
CREATE INDEX idx_users_role ON users(role);
