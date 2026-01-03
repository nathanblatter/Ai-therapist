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
- `GET /token` - Get OpenAI realtime API token (for AI therapist)
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
