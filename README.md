# AI Therapist

This is a real-time, voice-based AI therapy assistant built using the OpenAI Realtime API, WebRTC, and React. The application provides an empathetic, low-latency therapeutic conversation experience while maintaining strict HIPAA-compliant data practices and robust administrative oversight.

## Key Features

* **Real-time Voice Interaction**: Provides low-latency, natural conversations using OpenAI's gpt-realtime-mini model.
* **Multi-language and Voice Support**: Supports 12+ languages—including English, Spanish, French, German, and Japanese—and 10 distinct OpenAI voices such as Alloy, Cedar, and Sage.
* **HIPAA-Compliant Redaction**: Automatically identifies and redacts 18 HIPAA PHI identifiers, such as names and SSNs, using AI before storing logs.
* **Dual-Role Dashboard**:
    * **Therapists**: Can view unredacted logs for clinical oversight.
    * **Researchers**: Can view redacted logs and aggregate analytics.
* **Advanced Analytics**: Visualizes session trends, language distribution, and usage metrics using Recharts.
* **Session Guardrails**: Enforces daily session limits, cooldown periods, and crisis protocols, such as redirection to emergency services or counseling hotlines.

---

## Tech Stack

| Component | Technology |
| :--- | :--- |
| **Frontend** | React, Vite, Tailwind CSS, Recharts |
| **Backend** | Node.js, Express, Socket.io |
| **Database** | PostgreSQL (AWS RDS) |
| **AI/ML** | OpenAI Realtime API (WebRTC), Whisper-1 |
| **Security** | AWS Secrets Manager, Bcrypt, GeoIP Filtering |

---

## Project Structure

```text
/
├── src/
│   ├── client/
│   │   ├── main/      # Participant therapy interface (SSR)
│   │   ├── admin/     # Therapist/researcher dashboard
│   │   └── shared/    # Reusable UI components
│   ├── server/
│   │   ├── config/    # DB and AWS Secrets integration
│   │   ├── middleware/# Auth, RBAC, and IP filtering
│   │   ├── models/    # PostgreSQL data access layer
│   │   └── services/  # PHI redaction and AI session naming
│   └── database/      # SQL migrations and rollback scripts
├── dist/              # Production build output
├── vite.config.js     # Build config for participant app
└── vite.admin.config.js # Build config for admin dashboard

## Installation and Local Development

### Prerequisites
* Node.js (v20.x recommended)
* PostgreSQL
* OpenAI API Key

### Setup

1. **Clone the repository**:
   ```bash
   git clone <repo-url>
   cd ai-therapist
