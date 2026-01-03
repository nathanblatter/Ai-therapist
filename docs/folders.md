# AI Therapist Project Structure

This document provides a comprehensive guide to the project's folder structure, explaining where everything is located and what each component does.

## Table of Contents
- [Project Overview](#project-overview)
- [Root Directory](#root-directory)
- [Source Directory (`src/`)](#source-directory-src)
  - [Server (`src/server/`)](#server-srcserver)
  - [Client (`src/client/`)](#client-srcclient)
  - [Database (`src/database/`)](#database-srcdatabase)
- [Configuration Files](#configuration-files)
- [Build Output](#build-output)

---

## Project Overview

This is a real-time AI therapy assistant application built with:
- **Backend**: Express.js server with PostgreSQL database
- **Frontend**: React with Server-Side Rendering (SSR)
- **AI Integration**: OpenAI Realtime API for voice-based therapy sessions
- **Build Tool**: Vite for bundling and development

The application supports multiple users having simultaneous therapy sessions with configurable voice, language, and other settings. It includes both a participant interface and an admin dashboard for therapists/researchers.

---

## Root Directory

```
/
├── src/                    # All source code
├── docs/                   # Documentation
├── dist/                   # Build output (generated)
├── vite.config.js          # Vite config for main client app
├── vite.admin.config.js    # Vite config for admin dashboard
├── package.json            # Dependencies and scripts
├── reorganize-project.js   # Migration script for folder restructuring
└── participant_credentials.csv  # User credentials (not in git)
```

### Key Root Files

- **`package.json`**: Defines npm scripts and dependencies
  - `npm run dev` - Start development server
  - `npm run start` - Start production server
  - `npm run build` - Build for production

- **`vite.config.js`**: Build configuration for main participant app
  - Root: `src/client/main`
  - Outputs to: `dist/client` and `dist/server`

- **`vite.admin.config.js`**: Build configuration for admin dashboard
  - Root: `src/client/admin`
  - Outputs to: `dist/admin-client` and `dist/admin-server`

- **`reorganize-project.js`**: Script that moved files from old flat structure to organized `src/` structure

---

## Source Directory (`src/`)

All application source code is organized under `src/` with three main subdirectories:

```
src/
├── server/      # Backend API and server logic
├── client/      # Frontend React applications
└── database/    # Database migrations and scripts
```

---

## Server (`src/server/`)

The backend server handles API endpoints, authentication, database operations, and integrations with OpenAI.

```
src/server/
├── index.js                          # Main Express server entry point
├── config/                           # Configuration modules
│   ├── db.js                         # PostgreSQL connection pool
│   └── secrets.js                    # AWS Secrets Manager integration
├── middleware/                       # Express middleware
│   ├── auth.js                       # Authentication & authorization
│   └── ipFilter.js                   # Geographic IP filtering
├── models/                           # Data access layer
│   └── dbQueries.js                  # Database query functions
└── services/                         # Business logic services
    ├── sessionName.service.js        # AI-powered session naming
    └── redaction.service.js          # HIPAA PHI redaction
```

### Server Components Explained

#### **`index.js`** (Main Server File)
- **Lines 1-100**: Imports, configuration, middleware setup
- **Lines 101-400**: Session management, analytics endpoints
- **Lines 401-550**: `/token` endpoint - Creates OpenAI Realtime session with idempotency check
- **Lines 551-680**: Session CRUD endpoints (`/api/sessions/*`)
- **Lines 681-850**: Admin analytics endpoints (`/admin/api/analytics`)
- **Lines 851-1000**: Admin session/message management endpoints
- **Lines 1001-1200**: User management endpoints
- **Lines 1201-1300**: SSR rendering for production
- **Lines 1301+**: Development server with Vite middleware

**Key Features**:
- Idempotent session start (prevents duplicate sessions per user)
- Multi-language support with dynamic system prompts
- Real-time WebRTC connection management
- Role-based access control (participant, therapist, researcher)

#### **`config/db.js`**
PostgreSQL connection pool configuration:
- Connects to AWS RDS instance
- Uses AWS Secrets Manager for credentials
- Sets timezone to Mountain Time (America/Denver)
- SSL enabled with `rejectUnauthorized: false`

#### **`config/secrets.js`**
AWS Secrets Manager integration:
- `getOpenAIKey()` - Retrieves OpenAI API key
- `getDbCredentials()` - Retrieves database credentials
- Uses `@aws-sdk/client-secrets-manager`

#### **`middleware/auth.js`**
Authentication and authorization:
- `requireAuth(req, res, next)` - Ensures user is logged in
- `requireRole(...roles)` - Checks user has required role
- `verifyCredentials(username, password)` - Login verification
- `createUser()`, `getAllUsers()`, `getUserById()`, etc. - User CRUD operations
- Uses bcrypt for password hashing (10 salt rounds)

#### **`middleware/ipFilter.js`**
Geographic access control:
- `restrictParticipantsToUs(req, res, next)` - Middleware to restrict participants to US IP addresses
- Therapists/researchers can access from anywhere
- Uses `geoip-lite` for IP geolocation
- Allows localhost for development

#### **`models/dbQueries.js`**
Database access layer with functions for:

**Sessions**:
- `createSession(userId, sessionName)` - Create new therapy session
- `getSession(sessionId)` - Get session by ID
- `getUserSessions(userId)` - Get all sessions for user
- `updateSessionStatus(sessionId, status)` - Update session status (with idempotency)
- `getActiveSessionForUser(userId)` - Get user's active session (for idempotency check)
- `deleteSession(sessionId)` - Delete session and related data
- `updateSessionName(sessionId, name)` - Update session name

**Messages**:
- `insertMessagesBatch(sessionId, messages)` - Batch insert messages with PHI redaction
- `getSessionMessages(sessionId, includeRedacted)` - Get messages (therapists see redacted, researchers see original)
- `updateMessage(messageId, field, content)` - Update message content
- `deleteMessage(messageId)` - Delete message

**Session Configuration**:
- `upsertSessionConfig(sessionId, config)` - Save session settings (voice, language, temperature, etc.)
- `getSessionConfig(sessionId)` - Get session configuration

**Analytics**:
- `getLanguageStats()` - Session count by language with percentages
- `getVoiceStats()` - Session count by voice with percentages
- `getConfigStats()` - All configuration statistics

#### **`services/sessionName.service.js`**
AI-powered session naming:
- `generateSessionName(sessionId)` - Generates concise session name from conversation
- `generateSessionNameAsync(sessionId)` - Non-blocking wrapper
- Uses OpenAI GPT-4 to analyze first 10 messages and create 3-5 word name
- **Idempotent**: Checks if name already exists before calling OpenAI
- Falls back to "Therapy Session [timestamp]" on error

#### **`services/redaction.service.js`**
HIPAA-compliant PHI redaction:
- `redactPHI(input)` - Redacts 18 HIPAA Safe Harbor identifiers
- Uses OpenAI GPT-5 with specialized redaction prompt
- Replaces PHI with tags like `[REDACTED: NAME]`, `[REDACTED: SSN]`, etc.
- Preserves conversation content while protecting privacy

---

## Client (`src/client/`)

Frontend React applications organized by purpose:

```
src/client/
├── main/           # Participant therapy interface
├── admin/          # Therapist/researcher dashboard
└── shared/         # Shared components across apps
```

### Main App (`src/client/main/`)

Participant-facing therapy interface:

```
src/client/main/
├── entry-client.jsx              # Client-side hydration entry point
├── entry-server.jsx              # Server-side rendering entry point
├── base.css                      # Global styles
├── pages/
│   └── index.jsx                 # Home page component
└── components/
    ├── App.jsx                   # Main therapy session component
    ├── Login.jsx                 # Login page
    ├── Profile.jsx               # User profile page
    ├── Header.jsx                # App header with user info
    ├── ChatLog.jsx               # Message history display
    ├── SessionControls.jsx       # Start/stop session buttons
    ├── SessionSettings.jsx       # Voice & language settings modal
    ├── UserSessionDetail.jsx     # Individual session view
    ├── EventLog.jsx              # Technical event log
    └── Settings.jsx              # User settings
```

#### Key Main Components

**`App.jsx`** (Main Therapy Interface)
- **State Management**: Session state, messages, audio streams, settings
- **WebRTC Integration**: Manages peer connection to OpenAI Realtime API
- **Audio Handling**: Captures user microphone, plays assistant responses
- **Real-time Communication**: DataChannel for sending/receiving messages
- **Session Lifecycle**: Start session, end session, save messages to database
- **Language Support**: Sends initial prompt in user's selected language
- **Idempotency**: Handles "session already exists" response from server

**`SessionSettings.jsx`** (Settings Modal)
- Modal popup for configuring session before start
- **Voice Selection**: 10 OpenAI voices (Alloy, Ash, Ballad, Cedar, Coral, Echo, Marin, Sage, Shimmer, Verse)
- **Language Selection**: 12 languages with native script display (English, Español, Français, Deutsch, Italiano, Português, 中文, 日本語, 한국어, العربية, हिन्दी, Русский)
- Clean, minimalist design with custom dropdowns

**`ChatLog.jsx`**
- Displays conversation messages in chat bubbles
- User messages on right (blue), assistant on left (gray)
- Auto-scrolls to newest message
- Shows streaming assistant responses in real-time

**`Profile.jsx`**
- Shows user's session history
- Lists all past sessions with names and dates
- Click to view session details
- Logout button

### Admin App (`src/client/admin/`)

Dashboard for therapists and researchers:

```
src/client/admin/
├── admin-entry-client.jsx        # Client-side entry point
├── admin-entry-server.jsx        # Server-side entry point
└── components/
    ├── AdminApp.jsx              # Main admin interface
    ├── AdminHeader.jsx           # Admin navigation header
    ├── Analytics.jsx             # Analytics dashboard
    ├── SessionList.jsx           # List of all sessions
    ├── SessionDetail.jsx         # Detailed session view
    ├── ConversationBubble.jsx    # Individual message display
    ├── FilterBar.jsx             # Session filtering controls
    ├── ExportPanel.jsx           # CSV export functionality
    └── UserManagement.jsx        # User CRUD interface
```

#### Key Admin Components

**`AdminApp.jsx`** (Main Dashboard)
- Tab-based navigation: Analytics, Sessions, Export, Users
- Role-based permissions (therapist vs researcher)
- Real-time data updates

**`Analytics.jsx`** (Analytics Dashboard)
- **Session Statistics**: Total sessions, active sessions, ended sessions, archived sessions
- **User Metrics**: Total users, participants, therapists, researchers
- **Time-based Analytics**: Sessions this week/month
- **Message Analytics**: Total messages, avg messages per session
- **Language Distribution**: Bar chart of session count by language
- **Voice Distribution**: Bar chart of session count by voice
- Uses Recharts for visualizations

**`SessionList.jsx`**
- Displays all therapy sessions in table format
- Columns: Session Name, User, Status, Created Date, Duration
- Filtering by status, date range, user
- Click to view full session details
- Delete session action (therapist only)

**`SessionDetail.jsx`**
- Shows complete conversation for a session
- **Therapist View**: Sees redacted messages (PHI removed)
- **Researcher View**: Sees original messages
- Edit message content inline
- Delete individual messages
- Export session to CSV

**`ConversationBubble.jsx`**
- Single message display component
- Different styling for user vs assistant messages
- Edit and delete buttons (admin only)

**`UserManagement.jsx`**
- Create new users with username/password/role
- View all users in table
- Edit user details
- Delete users
- Role assignment (participant, therapist, researcher)

**`ExportPanel.jsx`**
- Export session data to CSV
- Filtering options: date range, user, status
- Includes messages in export
- Respects PHI redaction rules

### Shared Components (`src/client/shared/`)

Reusable components used by both main and admin apps:

```
src/client/shared/components/
├── Button.jsx              # Styled button component
├── CopyButton.jsx          # Copy-to-clipboard button
└── ProtectedRoute.jsx      # Route authentication wrapper
```

**`ProtectedRoute.jsx`**
- Wrapper for React Router routes requiring authentication
- Checks `/api/auth/status` endpoint
- Redirects to `/login` if not authenticated
- Used to protect therapy interface and admin dashboard

---

## Database (`src/database/`)

Database schema, migrations, and scripts:

```
src/database/
├── migrations/                                      # SQL migration files
│   ├── 001_create_users_table.sql                 # Initial users table
│   ├── 002_insert_initial_user.js                 # Seed admin user
│   ├── 003_normalize_schema.sql                   # Normalized schema
│   ├── 003_normalize_schema_rollback.sql          # Rollback for 003
│   ├── 004_change_session_id_to_text.sql          # UUID to TEXT
│   ├── 004_change_session_id_to_text_rollback.sql # Rollback for 004
│   ├── 005_add_language_to_session_config.sql     # Language column
│   └── 005_add_language_to_session_config_rollback.sql
└── scripts/                                         # Migration runners
    ├── runMigration.js                             # Run migration 003
    ├── runMigration004.js                          # Run migration 004
    ├── runMigration005.js                          # Run migration 005
    ├── rollbackMigration.js                        # Rollback 003
    └── MIGRATION_GUIDE.md                          # Migration instructions
```

### Database Schema (After All Migrations)

**`users`** - User accounts
- `user_id` (SERIAL PRIMARY KEY)
- `username` (VARCHAR UNIQUE)
- `password_hash` (VARCHAR)
- `role` (VARCHAR) - 'participant', 'therapist', 'researcher'
- `created_at` (TIMESTAMP)

**`therapy_sessions`** - Therapy sessions
- `session_id` (TEXT PRIMARY KEY) - OpenAI session ID
- `user_id` (INT) - References users, nullable for anonymous
- `session_name` (TEXT) - Auto-generated or custom name
- `status` (VARCHAR) - 'active', 'ended', 'archived'
- `created_at` (TIMESTAMP)
- `updated_at` (TIMESTAMP)
- `ended_at` (TIMESTAMP)

**`session_configurations`** - Session settings
- `config_id` (SERIAL PRIMARY KEY)
- `session_id` (TEXT) - References therapy_sessions
- `voice` (VARCHAR) - OpenAI voice name
- `language` (VARCHAR) - Language code (e.g., 'en', 'es')
- `temperature` (DECIMAL)
- `max_response_output_tokens` (INT)
- `turn_detection_threshold` (DECIMAL)
- `turn_detection_silence_duration_ms` (INT)
- `turn_detection_prefix_padding_ms` (INT)
- `created_at` (TIMESTAMP)

**`messages`** - Conversation messages
- `message_id` (SERIAL PRIMARY KEY)
- `session_id` (TEXT) - References therapy_sessions
- `item_id` (TEXT) - OpenAI message ID
- `role` (VARCHAR) - 'user' or 'assistant'
- `content` (TEXT) - Original message content
- `content_redacted` (TEXT) - PHI-redacted version
- `created_at` (TIMESTAMP)

**`user_sessions`** - Express session store (managed by express-session)

### Migration Scripts

**How to Run Migrations**:
```bash
# Run migration 003 (normalized schema)
node src/database/scripts/runMigration.js

# Run migration 004 (session_id to TEXT)
node src/database/scripts/runMigration004.js

# Run migration 005 (add language column)
node src/database/scripts/runMigration005.js

# Rollback migration 003
node src/database/scripts/rollbackMigration.js
```

Each migration script:
1. Connects to database using `pool` from `src/server/config/db.js`
2. Reads SQL file from `src/database/migrations/`
3. Executes SQL within a transaction
4. Verifies changes
5. Provides rollback instructions on error

---

## Configuration Files

### `vite.config.js` (Main Client Build)
```javascript
{
  root: "src/client/main",
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: ["www.byuisresearch.com", "byuisresearch.com"]
  }
}
```
- Entry point: `src/client/main/entry-client.jsx`
- Server entry: `src/client/main/entry-server.jsx`
- Output: `dist/client` (static) and `dist/server` (SSR)

### `vite.admin.config.js` (Admin Dashboard Build)
```javascript
{
  root: "src/client/admin",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: "src/client/admin/admin.html"
    }
  }
}
```
- Entry point: `src/client/admin/admin-entry-client.jsx`
- Server entry: `src/client/admin/admin-entry-server.jsx`
- Output: `dist/admin-client` and `dist/admin-server`

### `package.json` Scripts
- **`npm run dev`**: Start development server with Vite hot-reload
- **`npm run start`**: Production server (requires build first)
- **`npm run build`**: Build both client and admin apps for production
- **`npm run build:client`**: Build main client app
- **`npm run build:admin-client`**: Build admin dashboard
- **`npm run build:server`**: Build main SSR bundle
- **`npm run build:admin-server`**: Build admin SSR bundle

---

## Build Output

Generated by `npm run build` (not in git):

```
dist/
├── client/                    # Main app static files
│   ├── index.html            # Main entry HTML
│   └── assets/               # JS, CSS bundles
├── admin-client/             # Admin app static files
│   ├── admin.html            # Admin entry HTML
│   └── assets/               # JS, CSS bundles
├── server/                    # Main app SSR bundle
│   └── entry-server.js       # Server rendering module
└── admin-server/             # Admin app SSR bundle
    └── admin-entry-server.js # Admin server rendering module
```

In production (`NODE_ENV=production`):
1. Server loads from `dist/` directories
2. Serves static files from `dist/client` and `dist/admin-client`
3. Uses SSR modules from `dist/server` and `dist/admin-server`

In development (`npm run dev`):
1. Vite middleware handles hot-reload
2. No build step required
3. Instant updates on file changes

---

## Data Flow Architecture

### Therapy Session Flow
1. **User Login** (`Login.jsx` → `/api/login` → `auth.js`)
2. **Session Configuration** (`SessionSettings.jsx` - select voice/language)
3. **Session Start** (`App.jsx` → `/token` → `index.js`)
   - Idempotency check via `getActiveSessionForUser()`
   - Create session in database
   - Get OpenAI ephemeral token
   - Establish WebRTC connection
4. **Real-time Conversation** (WebRTC DataChannel)
   - User speaks → microphone → OpenAI
   - OpenAI responds → speaker
   - Messages buffered in client
5. **Session End** (`App.jsx` → `/api/sessions/:id/end` → `index.js`)
   - Update session status to 'ended'
   - Batch save messages with PHI redaction
   - Trigger async session name generation
6. **View History** (`Profile.jsx` → `/api/sessions` → `dbQueries.js`)

### Admin Analytics Flow
1. **Admin Login** (Same auth system, role='therapist' or 'researcher')
2. **View Dashboard** (`Analytics.jsx` → `/admin/api/analytics`)
3. **Query Database** (Complex SQL with CTEs for statistics)
4. **Render Charts** (Recharts bar charts for language/voice distribution)

### PHI Protection Flow
1. **Message Created** (User or assistant sends message)
2. **Batch Save** (`insertMessagesBatch()` in `dbQueries.js`)
3. **Redaction** (Each message passed to `redactPHI()`)
4. **Dual Storage** (Original in `content`, redacted in `content_redacted`)
5. **Role-based Retrieval**:
   - Therapists see `content_redacted`
   - Researchers see `content` (for analysis)

---

## Environment Variables

Required environment variables (set in hosting environment or `.env`):

```bash
# Server
PORT=3000
NODE_ENV=production  # or 'development'
SESSION_SECRET=your-secret-key-here

# AWS
AWS_REGION=us-west-1

# Database (loaded from AWS Secrets Manager, not env vars)
# DB credentials stored in: rds!db-9fa8f192-60a6-4918-ac0d-4c26a8a7bad3
# OpenAI key stored in: prod/ai-therapist/oaiAPIKey
```

---

## Security Features

1. **Authentication**: Session-based auth with bcrypt password hashing
2. **Authorization**: Role-based access control (RBAC)
3. **PHI Protection**: Automatic HIPAA-compliant redaction using AI
4. **Geographic Restriction**: Participants limited to US IPs (therapists/researchers exempt)
5. **SSL/TLS**: Database connections use SSL
6. **Secrets Management**: API keys stored in AWS Secrets Manager, not code
7. **Session Isolation**: Each user can only access their own sessions
8. **Idempotency**: Prevents duplicate session creation on repeated requests

---

## Development Workflow

### Setup
```bash
npm install
```

### Run Development Server
```bash
npm run dev
# Server at http://localhost:3000
# Main app at http://localhost:3000/
# Admin at http://localhost:3000/admin
```

### Build for Production
```bash
npm run build
npm run start
```

### Run Migrations
```bash
node src/database/scripts/runMigration005.js
```

### Common Development Tasks

**Add a new API endpoint**:
1. Add route handler in `src/server/index.js`
2. Add database function in `src/server/models/dbQueries.js` if needed
3. Call endpoint from React component

**Add a new React component**:
1. Create component in `src/client/main/components/` or `src/client/admin/components/`
2. Import and use in parent component
3. Shared components go in `src/client/shared/components/`

**Add a new database column**:
1. Create migration SQL in `src/database/migrations/`
2. Create rollback SQL
3. Create migration runner script in `src/database/scripts/`
4. Run migration
5. Update `dbQueries.js` to use new column

---

## Architecture Decisions

### Why This Structure?

**Server Organization** (`config/`, `middleware/`, `models/`, `services/`):
- **Separation of Concerns**: Each directory has a single responsibility
- **Testability**: Services and models can be unit tested independently
- **Scalability**: Easy to add new middleware, services, or data models
- **Standard Pattern**: Follows MVC-like architecture common in Express apps

**Client Separation** (`main/`, `admin/`, `shared/`):
- **Code Splitting**: Admin bundle doesn't bloat participant app
- **Different Build Configs**: Each app can optimize separately
- **Shared Code Reuse**: Common components in `shared/` used by both
- **Clear Boundaries**: Therapist features separated from participant features

**Database Migrations**:
- **Version Control**: Each schema change tracked in git
- **Rollback Safety**: Every migration has a rollback script
- **Reproducibility**: Any developer can set up same database schema
- **Production Safety**: Tested migrations reduce deployment risk

### Technology Choices

- **React + SSR**: SEO, faster initial load, better UX
- **Vite**: Fast builds, hot module replacement, modern tooling
- **PostgreSQL**: ACID compliance for medical data, JSON support, powerful queries
- **OpenAI Realtime API**: Low-latency voice conversation, natural interactions
- **WebRTC**: Real-time audio streaming, works across browsers
- **Express Session + PostgreSQL**: Secure, scalable session storage
- **AWS Secrets Manager**: Secure credential storage, automatic rotation support

---

## Future Considerations

### Potential Improvements
1. **Split `index.js`**: Move routes to separate files (`src/server/routes/`)
2. **Environment-based Config**: Create `config/development.js`, `config/production.js`
3. **API Versioning**: Add `/api/v1/` prefix to allow future API changes
4. **WebSocket Support**: Add real-time updates to admin dashboard
5. **Testing**: Add `src/server/__tests__/` and `src/client/__tests__/`
6. **Logging**: Integrate Winston or Pino for structured logging
7. **Monitoring**: Add health check endpoints and metrics

### Scaling Considerations
- Current architecture supports horizontal scaling (stateless server)
- Sessions stored in database (not in-memory), allows load balancing
- Consider Redis for session storage if performance becomes issue
- WebRTC connections are peer-to-peer with OpenAI (not through server)

---

## Getting Help

- **Database Schema**: See `docs/db.md`
- **Migration Guide**: See `src/database/scripts/MIGRATION_GUIDE.md`
- **Code Issues**: Check console logs in browser and server terminal
- **Build Errors**: Clear `dist/` and rebuild: `rm -rf dist && npm run build`

---

**Last Updated**: January 1, 2026 (After project reorganization)
