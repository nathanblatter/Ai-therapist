# Database Schema Documentation

## Tables

### 1. users

Authentication and authorization table for the AI Therapist application.

**Schema:**

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| userid | SERIAL | PRIMARY KEY | Auto-incrementing unique identifier for each user |
| username | VARCHAR(255) | UNIQUE, NOT NULL | Unique username for login |
| password | VARCHAR(255) | NOT NULL | Bcrypt hashed password (never stored in plaintext) |
| role | VARCHAR(50) | NOT NULL, CHECK | User's role - must be one of: 'therapist', 'researcher', 'participant' |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Timestamp when the user account was created |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Timestamp when the user account was last updated |

**Indexes:**
- `idx_users_username` - Index on username for faster login lookups
- `idx_users_role` - Index on role for filtering users by role

**Roles and Permissions:**

| Role | Permissions |
|------|-------------|
| **therapist** | - Full access to admin dashboard<br>- Can view all data **without redaction** (unredacted PHI)<br>- Can access AI therapist features<br>- Can create new users via /api/auth/register |
| **researcher** | - Full access to admin dashboard<br>- Can view **redacted data only** (PHI is redacted)<br>- Can access AI therapist features<br>- Can create new users via /api/auth/register |
| **participant** | - **Cannot** access admin dashboard<br>- **Cannot** access admin API routes<br>- Can **only** access AI therapist features |

### 2. conversation_logs

Stores all conversation messages from AI therapy sessions.

**Schema:**

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing unique identifier for each message |
| session_id | VARCHAR/TEXT | NOT NULL | Unique identifier for each therapy session |
| role | VARCHAR | NOT NULL | Message sender - 'user' or 'assistant' |
| message_type | VARCHAR | NOT NULL | Type of message - 'voice', 'chat', 'session_start', etc. |
| message | TEXT | | The actual message content (PHI redacted for all entries) |
| extras | JSONB/JSON | | Additional metadata stored as JSON |
| created_at | TIMESTAMP | NOT NULL | Timestamp when the message was created |

**Data Redaction:**
- All messages stored in `conversation_logs` have PHI redacted using the `redactPHI()` function
- Redaction happens at insert time in the `/logs/batch` endpoint
- **Future implementation:** Role-based redaction retrieval will allow therapists to view unredacted data

### 3. GPT-Live voice tables (migration 098)

Added by the GPT-Live migration. Architecture reference: `docs/gpt-live.md`.

#### `therapy_sessions.openai_live_session_id`

| Column | Type | Description |
|--------|------|-------------|
| openai_live_session_id | TEXT | Opaque GPT-Live session id (`live_...`) returned in the JSON body of `POST /v1/live/sessions`. `NULL` for Realtime-era sessions. |

Kept separate from `openai_call_id` on purpose: a Realtime `call_id` and a Live
session id are different namespaces with different attach URLs, and the sideband
reattach query after a restart has to tell them apart. Indexed by
`idx_therapy_sessions_live_reattach` (partial: active sessions with a non-null
live session id).

#### `live_usage`

Per-second voice billing for GPT-Live sessions. **One row per session**,
overwritten as snapshots arrive.

| Column | Type | Description |
|--------|------|-------------|
| session_id | TEXT | PRIMARY KEY, FK → `therapy_sessions(session_id)` ON DELETE CASCADE |
| model | TEXT | Voice model (`gpt-live-1`) |
| duration_seconds | NUMERIC(12,3) | Latest **cumulative** voice duration reported by the API |
| finalized | BOOLEAN | TRUE once `session.closed` has been observed |
| close_reason | TEXT | `close_requested` / `expired` / `content` / `remote_hangup` / `connection_lost`; NULL while running |
| peak_context_ratio | NUMERIC(5,4) | Peak `context_window.usage_ratio` seen |
| created_at, updated_at | TIMESTAMP | |

**The cumulative-snapshot rule.** `session.usage.updated` carries a cumulative
total, **not** an increment. Summing the snapshots would massively overcount a
long session. So each snapshot **overwrites** the row (`GREATEST` of stored and
incoming, so a late out-of-order frame cannot walk the number backwards), and
`finalized` is sticky (`OR`) so a stray in-flight snapshot cannot downgrade a
confirmed total back to provisional.

Because the table stores the latest snapshot rather than appending deltas, it is
safe — and correct — to `SUM(duration_seconds)` **across sessions**. It is never
correct to sum snapshots *within* a session; the schema simply makes that
impossible by holding only one row.

`finalized = FALSE` means the connection dropped before `session.closed` and the
duration is the last in-flight snapshot — formally unconfirmed. It is persisted
anyway so the session is not billed as zero; the cost dashboard reports these
separately as `unfinalized_sessions`. A socket close alone does not establish
finalization.

Billing: `$0.05` per minute for the voice layer, charged per second and not
rounded up. `POST /v1/live/sessions` bills 15 seconds at initialization, credited
back against the running session — so an abandoned session still costs money.
Rates live in `LIVE_RATES_PER_MINUTE` (`src/server/db/liveUsage.queries.ts`) and
are a hand-maintained estimate; invoices are the source of truth.

#### `session_llm_usage.purpose` — new value `live_delegation`

The delegated Responses backend is billed **separately** from the voice layer, at
normal token rates. Those figures arrive as nested `response.completed` events on
the sideband and are written to the existing `session_llm_usage` table with
`purpose = 'live_delegation'`, so the cost dashboard picks them up with no
special handling. Each backend response id is metered once, so a replayed event
cannot double-bill.

Full value set: `insights | redaction | crisis | eligibility | rerank | chat |
live_delegation`. The column is free-text TEXT, so no enum change was needed;
migration 098 only updates the column comment.

This row is also the only per-session record of which backend model a voice
session actually ran on — see `docs/model-pinning.md`.

## Authentication Flow

### Login
1. Client sends POST to `/api/auth/login` with username and password
2. Server verifies credentials using bcrypt
3. On success, creates session and returns user data (without password)
4. Session stored in express-session with 24-hour expiry

### Authorization
- Routes use `requireAuth` middleware to verify user is logged in
- Routes use `requireRole(...roles)` middleware to check user has appropriate role
- Session data includes: `userId`, `username`, `userRole`

### Protected Routes

**Admin API Routes (require therapist or researcher role):**
- `GET /admin/api/sessions` - List all therapy sessions
- `GET /admin/api/sessions/:sessionId` - Get full conversation for a session
- `GET /admin/api/analytics` - Get dashboard analytics
- `GET /admin/api/export` - Export conversation data
- `POST /api/auth/register` - Create new users

**Admin Page Routes (require therapist or researcher role):**
- `GET /admin` - Admin dashboard interface

**Public Routes (no authentication required):**
- `POST /api/auth/login` - Login endpoint
- `POST /api/auth/logout` - Logout endpoint
- `GET /api/auth/status` - Check authentication status
- `POST /api/live/session` - Exchange the browser's SDP offer for a GPT-Live session
  (server holds the project API key; returns `session_id` + SDP answer). Replaces the
  Realtime-era `GET /token` ephemeral-key endpoint.
- `POST /logs/batch` - Log conversation messages
- `/` - Main AI therapist interface

## Setup Instructions

### 1. Create the users table

Run the migration script:

```bash
psql -h <host> -U <user> -d <database> -f migrations/001_create_users_table.sql
```

Or connect to your database and execute the SQL directly:

```sql
-- See migrations/001_create_users_table.sql
```

### 2. Create the initial researcher user

Run the Node.js migration script:

```bash
node migrations/002_insert_initial_user.js
```

This will create a user with:
- Username: `nathan`
- Password: `Utab2Kil`
- Role: `researcher`

### 3. Set session secret (Production)

Add to your `.env` file:

```
SESSION_SECRET=your-secure-random-secret-key-here
```

Generate a secure secret key using:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Security Notes

- All passwords are hashed using bcrypt with 10 salt rounds
- Sessions use httpOnly cookies to prevent XSS attacks
- Sessions use secure cookies in production (HTTPS only)
- Session secret should be changed in production
- PHI is redacted at storage time to protect sensitive information
- Role-based access control prevents unauthorized data access

## Future Enhancements

- [ ] Implement role-based redaction retrieval (therapists see unredacted data)
- [ ] Add password reset functionality
- [ ] Add email verification
- [ ] Add two-factor authentication
- [ ] Add audit logging for admin actions
- [ ] Add user management UI in admin dashboard
