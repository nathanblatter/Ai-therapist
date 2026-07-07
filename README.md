# AI Therapist

A real-time, voice-based AI therapy research demo built on the OpenAI Realtime API (WebRTC), Express, and React. Participants talk to a low-latency AI assistant; therapists and researchers oversee sessions live from an admin dashboard, with PHI redaction and crisis-detection guardrails.

## Key Features

* **Real-time Voice Interaction**: Low-latency conversations over WebRTC using the OpenAI Realtime API, with a server-side "sideband" WebSocket observer for live monitoring and steering.
* **Chat-Only Fallback**: A text-based therapy flow (chat completions) when voice is disabled.
* **Multi-language and Voice Support**: 12+ languages and 10 OpenAI voices, selectable per participant.
* **PHI Redaction**: All 18 HIPAA PHI identifier categories are redacted by an AI pass once per session at session end; researchers see redacted transcripts, therapists see the originals.
* **Live Monitoring**: Admins watch active sessions in real time (transcript + mixed session audio) and can send visible or invisible steering messages.
* **Crisis Detection**: Multi-layered per-message risk analysis with graduated responses and admin alerts.
* **Session Guardrails**: Daily session limits, cooldowns, max durations, and US-only participant geo-filtering.
* **Session Recording**: Mixed mic+assistant audio is recorded to object storage (MinIO) and playable from the admin dashboard.

## Tech Stack

| Component | Technology |
| :--- | :--- |
| **Frontend** | React 18, Vite (SSR, three apps: main/admin/redact), Tailwind CSS, Recharts |
| **Backend** | Node.js (tsx, no compile step), Express, Socket.io |
| **Database** | PostgreSQL (self-hosted) |
| **Object storage** | MinIO (session audio recordings) |
| **AI** | OpenAI Realtime API (WebRTC + sideband WS), chat completions, Whisper-1 transcription |
| **Auth/Security** | express-session (Postgres store), bcrypt, TOTP MFA, helmet, rate limiting, GeoIP filtering |
| **Deploy** | Docker (blue-green via GitHub Actions on a self-hosted runner), Cloudflare Tunnel |

## Project Structure

```text
src/
├── client/
│   ├── main/       # Participant therapy interface (SSR)
│   ├── admin/      # Therapist/researcher dashboard (SSR, /admin)
│   ├── redact/     # Redaction-verification app (SSR, /redact)
│   └── shared/     # Reusable UI components
├── server/
│   ├── index.ts    # Composition root: middleware, Socket.io, route mounting, SSR
│   ├── routes/
│   │   ├── public/ # Participant-facing API (auth, token, sessions, chat, logs…)
│   │   └── admin/  # Role-gated admin API (sessions, config, crisis, export…)
│   ├── db/         # All SQL, one domain module per area, behind db/index.ts
│   ├── services/   # Redaction, crisis detection, sideband, recorder, MFA…
│   ├── middleware/ # Session auth, RBAC, IP geo-filter, error handler
│   ├── config/     # DB pool, secrets, object storage
│   └── utils/      # Session limits, ownership, timezone helpers, logger
└── database/       # SQL migrations (+ rollbacks)
```

## Local Development

### Prerequisites
* Node.js 20.x
* PostgreSQL (run migrations in `src/database/migrations` in order)
* MinIO (or any S3-compatible store) for audio recordings
* An OpenAI API key

### Setup

```bash
npm ci
cp .env.example .env   # fill in DATABASE_URL, SESSION_SECRET, keys, MinIO settings
npm run dev            # dev server with Vite middleware on PORT (default 3067)
```

### Verify

```bash
npm run typecheck
npm run lint
npm test
```

## Deployment

Pushing to `main` runs typecheck + lint + tests in CI, then a blue-green Docker deploy on the self-hosted runner (new container must pass its health check before the old one is stopped). Public URL is served through a Cloudflare Tunnel.
