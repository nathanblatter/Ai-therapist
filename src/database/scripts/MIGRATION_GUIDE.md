# Database Schema Migration Guide

## Overview

This migration normalizes the database schema to Third Normal Form (3NF), improving data organization and enabling new features like session history and user-session associations.

## What's Changing

### New Tables

1. **therapy_sessions** - Tracks therapy sessions with user associations
2. **session_configurations** - Stores OpenAI session settings per session
3. **messages** - Replaces `conversation_logs` with normalized structure
4. **user_sessions** - Persists Express.js sessions to database

### Preserved Tables

- **users** - No changes
- **conversation_logs** - Kept for historical data (read-only going forward)

## Migration Steps

### 1. Backup Your Database

**CRITICAL:** Always backup before migrating!

```bash
# Example using pg_dump
pg_dump -h ai-therapist-conversationlog-db.cduiqimmkaym.us-west-1.rds.amazonaws.com \
  -U your_username -d postgres > backup_$(date +%Y%m%d_%H%M%S).sql
```

### 2. Run the Migration

```bash
node runMigration.js
```

This will:
- Create 4 new tables with proper indexes
- Enable UUID extension (pgcrypto)
- Preserve existing `conversation_logs` data
- Set up foreign key relationships

Expected output:
```
🔄 Starting database migration to 3NF schema...
📝 Executing migration script...
✅ Migration completed successfully!

New tables created:
  - therapy_sessions
  - session_configurations
  - messages
  - user_sessions
```

### 3. Verify Migration

Check that all tables were created:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

### 4. Restart Your Application

```bash
npm start
```

The application will now use the new schema for all new sessions.

## Rollback Instructions

If you need to revert the migration:

```bash
node rollbackMigration.js
```

**WARNING:** This will delete all data in the new tables. Make sure you have backups!

## New Features Enabled

### 1. User-Session Association

Users can now have multiple therapy sessions associated with their account:

```javascript
// Get all sessions for a user
GET /api/sessions
```

### 2. Session History

View past sessions:

```javascript
{
  "session_id": "abc-123...",
  "session_name": "Coping with work anxiety",
  "status": "ended",
  "created_at": "2025-12-20T10:30:00Z",
  "ended_at": "2025-12-20T11:15:00Z"
}
```

### 3. Auto-Generated Session Names

When a session ends, AI automatically generates a descriptive name:

```javascript
POST /api/sessions/:sessionId/end
// Triggers background AI summarization
```

### 4. Persistent Login Sessions

Express sessions now survive server restarts (stored in `user_sessions` table).

### 5. Separate Original & Redacted Content

Messages now store both:
- `content` - Original message (therapists only)
- `content_redacted` - HIPAA-compliant version (researchers)

## API Changes

### New Endpoints

#### Create Session
```
POST /api/sessions/create
Body: { "sessionName": "Optional name" }
Response: { session_id, user_id, status, created_at, ... }
```

#### List User Sessions
```
GET /api/sessions
Headers: Authentication required
Response: [{ session_id, session_name, status, ... }]
```

#### Get Session Details
```
GET /api/sessions/:sessionId
Response: {
  session: { session_id, session_name, ... },
  messages: [...],
  config: { voice, modalities, ... }
}
```

#### End Session
```
POST /api/sessions/:sessionId/end
Response: { session_id, status: "ended", ended_at, ... }
Note: Triggers auto-naming in background
```

### Updated Admin Endpoints

All admin endpoints now use the new schema:

- `GET /admin/api/sessions` - Now includes `session_name`, `username`, `status`
- `GET /admin/api/sessions/:sessionId` - Returns both session metadata and messages
- `GET /admin/api/analytics` - Enhanced metrics with session status breakdown
- `GET /admin/api/export` - Exports from `messages` table with redaction based on role

## Database Schema Reference

### therapy_sessions

| Column | Type | Description |
|--------|------|-------------|
| session_id | UUID | Primary key (auto-generated) |
| user_id | INTEGER | FK to users (NULL for anonymous) |
| session_name | VARCHAR(255) | Auto-generated descriptive name |
| status | VARCHAR(20) | 'active', 'ended', or 'archived' |
| created_at | TIMESTAMP | Session start time |
| updated_at | TIMESTAMP | Last update time |
| ended_at | TIMESTAMP | Session end time |

### session_configurations

| Column | Type | Description |
|--------|------|-------------|
| config_id | SERIAL | Primary key |
| session_id | UUID | FK to therapy_sessions (UNIQUE) |
| voice | VARCHAR(50) | OpenAI voice (default: 'alloy') |
| modalities | TEXT[] | ['text', 'audio'] |
| instructions | TEXT | System prompt |
| turn_detection | JSONB | Turn detection settings |
| tools | JSONB | OpenAI function tools |
| temperature | DECIMAL(3,2) | Default: 0.8 |
| max_response_output_tokens | INTEGER | Default: 4096 |

### messages

| Column | Type | Description |
|--------|------|-------------|
| message_id | BIGSERIAL | Primary key |
| session_id | UUID | FK to therapy_sessions |
| role | VARCHAR(20) | 'user', 'assistant', 'system' |
| message_type | VARCHAR(50) | 'voice', 'chat', etc. |
| content | TEXT | Original message content |
| content_redacted | TEXT | HIPAA-redacted content |
| metadata | JSONB | Additional metadata |
| created_at | TIMESTAMP | Message timestamp |

### user_sessions

| Column | Type | Description |
|--------|------|-------------|
| sid | VARCHAR | Primary key (session ID) |
| sess | JSONB | Session data |
| expire | TIMESTAMP | Expiration time |

## Code Changes Summary

### Files Created

- `dbQueries.js` - Helper functions for new schema
- `generateSessionName.js` - AI session naming logic
- `runMigration.js` - Migration runner
- `rollbackMigration.js` - Rollback script
- `migrations/003_normalize_schema.sql` - Forward migration
- `migrations/003_normalize_schema_rollback.sql` - Rollback migration

### Files Modified

- `server.js`
  - Added `connect-pg-simple` for persistent sessions
  - Updated `/logs/batch` to use messages table
  - Added session management endpoints
  - Updated admin endpoints for new schema
  - Integrated auto-naming on session end

- `package.json`
  - Added `connect-pg-simple` dependency

## Testing Checklist

After migration, verify:

- [ ] Existing users can still log in
- [ ] New therapy sessions are created in `therapy_sessions` table
- [ ] Messages are stored in `messages` table with both original and redacted content
- [ ] Session end triggers auto-naming (check server logs)
- [ ] Admin dashboard shows sessions with new fields
- [ ] Export functionality works with role-based redaction
- [ ] Analytics dashboard displays correct metrics
- [ ] Login sessions persist after server restart

## Troubleshooting

### Migration Fails

1. Check database connection in `db.js`
2. Verify AWS Secrets Manager credentials
3. Ensure PostgreSQL user has CREATE TABLE permissions
4. Check server logs for detailed error messages

### Auto-Naming Not Working

1. Verify OpenAI API key is set
2. Check server logs for AI generation errors
3. Ensure session has messages before ending

### Sessions Not Persisting

1. Verify `user_sessions` table was created
2. Check `connect-pg-simple` configuration in `server.js`
3. Restart server after migration

## Support

For issues or questions:
1. Check server logs: `tail -f server.log`
2. Review migration output
3. Contact system administrator

## Rollback Considerations

Rolling back will:
- ✅ Preserve `users` table
- ✅ Preserve `conversation_logs` table
- ❌ Delete all data in new tables
- ❌ Require application restart
- ❌ Break new features (session history, auto-naming, etc.)

Only rollback if absolutely necessary!
