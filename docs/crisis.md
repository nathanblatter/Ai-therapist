# Crisis Management System

## Overview

The crisis detection system combines a cheap, always-on keyword screen with an LLM context
assessment so that flags reflect actual context (intent vs. reference, negation, talking about
someone else) rather than bare keyword matches. Severity is graduated (none/low/medium/high),
responses are tiered accordingly, and researchers exercise clinical judgment on live sessions —
the automated system surfaces and prioritizes, the human on duty decides how to intervene.

---

## Detection: Two-Stage (Keyword Screen + LLM Assessment)

**File:** `src/server/services/crisisDetection.service.ts`

### Stage 1 — Tiered keyword screen (every message, no API call)

Every analyzed participant message passes a tiered keyword screen:

| Tier | Provisional score | Examples |
|--------|-------------------|----------|
| High | 75 | explicit suicidal/self-harm intent ("kill myself", "end my life", "overdose") |
| Medium | 40 | strong distress/passive-ideation phrases ("better off without me") |
| Low | 15 | milder risk-adjacent language |

The screen's job is SCREENING, not judging: **any** tier match wakes the Stage 2 LLM
assessment. The tier score is only used as a provisional fallback when the LLM is unavailable.

### Stage 2 — LLM context assessment

When Stage 1 matches (or a periodic sweep is due — see below), the recent conversation
excerpt (raw, unredacted text, capped at ~6000 characters) is sent to OpenAI `gpt-4o-mini`,
which returns a risk score (0–100) and a graduated severity: `none`, `low`, `medium`, or
`high`. The prompt explicitly downgrades references (hotline names, media), negations
("I'm not suicidal"), and bystander accounts (someone else's crisis). If the returned
severity is malformed, it is derived from the score bands (`>=75` high, `>=50` medium,
`>=25` low).

Note for IRB/privacy accounting: this means unredacted conversation excerpts are transmitted
to OpenAI for risk assessment, in addition to the conversation-generation calls themselves.

### Periodic sweep

Because keyword screens miss risk expressed without trigger phrases, the system also runs a
full LLM assessment every 8 participant messages (`SWEEP_EVERY = 8`) even when no keyword has
matched. Sweep results feed the same scoring/response path (`method: 'llm_sweep'`).

### Trajectory bonus

`trackEmotionalTrajectory()` examines recent `risk_score_history` rows and adds a bonus of up
to +20 to the risk score when scores are consistently rising (e.g., +15 for a monotonic
increase). Trajectory output is logged with each assessment.

### Fallback behavior

If the LLM call fails, the keyword tier score stands as the provisional score
(`method: 'keyword_fallback'`), with severity derived from the same bands — detection degrades
to keyword-only rather than failing silent. With no keyword match and no LLM, the result is
`llm_unavailable` (indeterminate, score 0).

### Passive logging

`risk_score_history` rows are inserted for every analyzed message (including score 0), giving
researchers a complete passive audit trail. `score_factors` records the keyword score,
matched keywords, LLM assessment, and method.

---

## Graduated Response

**File:** `src/server/services/crisisIntervention.service.ts`

Responses are tiered by severity/score:

- **High severity**: emit `session:crisis-emergency` to the session room and to
  `admin-broadcast` (all monitoring researchers), set monitoring frequency to `critical`,
  page the on-call researcher by SMS (when paging is configured), and inject the safety
  protocol steering (below).
- **Medium severity**: real-time dashboard alert plus a work-queue item for the study team.
  No SMS page.
- **Risk score >= 25 (low and up)**: the system injects hidden de-escalation steering
  guidance into the model's context (sideband system message for realtime sessions; system
  message for chat). This changes how the agent responds — grounding, safety-checking,
  surfacing crisis resources — but is not shown or announced to the participant. Steering
  is rate-limited to once per 3 minutes per session and every injection is logged in
  `intervention_actions` (`risk_steering` / `safety_protocol`) and broadcast to the admin
  dashboard (`session:risk-steering`).

The automated system never sends a chat message *as itself* to the participant; it shapes the
agent's replies via steering and surfaces resources through the agent and the UI. The
researcher on duty decides whether and how to intervene directly.

---

## Auto-Flag Condition

**File:** `src/server/index.js` (crisis detection block)

```js
const shouldFlag = riskAnalysis.severity === 'high' &&
  (!session.crisis_flagged || riskAnalysis.riskScore > currentScore + 10);
```

If the session is already flagged and the new score is not meaningfully higher, the flag is
not re-triggered (avoids duplicate events on repeated signals in the same session).

---

## Manual Flag / Unflag

Researchers use the SessionDetail UI to flag/unflag with any severity and optional
notes. Endpoints:

- `POST /admin/api/sessions/:sessionId/crisis/flag`
- `DELETE /admin/api/sessions/:sessionId/crisis/flag`

Both require `requireRole('therapist', 'researcher')`.

---

## Database Schema

### `therapy_sessions` additions

| Column                 | Type          | Notes                                        |
|------------------------|---------------|----------------------------------------------|
| `crisis_flagged`       | BOOLEAN       | Default FALSE                                |
| `crisis_severity`      | VARCHAR(10)   | `low`, `medium`, `high`                      |
| `crisis_risk_score`    | INTEGER       | 0–100                                        |
| `crisis_flagged_at`    | TIMESTAMPTZ   |                                              |
| `crisis_flagged_by`    | VARCHAR(255)  | `system` for auto, username for manual       |
| `crisis_unflagged_at`  | TIMESTAMPTZ   |                                              |
| `crisis_unflagged_by`  | VARCHAR(255)  |                                              |
| `monitoring_frequency` | VARCHAR(20)   | `normal`, `high`, `critical`                 |

### `crisis_events` (audit trail)

Complete audit trail of all crisis management events. Columns: `event_id`, `session_id`,
`event_type`, `severity`, `previous_severity`, `risk_score`, `previous_risk_score`,
`triggered_by`, `trigger_method` (`auto` / `manual` / `system`), `message_id`, `risk_factors`
(JSONB), `intervention_details` (JSONB), `notes`, `created_at`.

### `intervention_actions`

Log of all automated and manual interventions, including every `risk_steering` /
`safety_protocol` injection. Columns: `action_id`, `session_id`, `action_type`,
`risk_score`, `action_details` (JSONB), `performed_by`, `performed_at`, `outcome`, `notes`.

### `risk_score_history`

Time-series passive log. Columns: `history_id`, `session_id`, `message_id`, `risk_score`,
`severity`, `score_factors` (JSONB: keyword score, keywords, LLM assessment, method),
`calculated_at`.

### `human_handoffs`

Tracks handoffs initiated by researchers (manual process). Columns: `handoff_id`, `session_id`,
`risk_score`, `handoff_type`, `status`, `initiated_at`, `initiated_by`, `assigned_to`,
`completed_at`, `outcome`, `external_reference`, `notes`.

### `clinical_reviews`

Post-incident reviews. Columns: `review_id`, `session_id`, `risk_score`, `review_reason`,
`review_type`, `status`, `requested_at`, `requested_by`, `assigned_to`, `reviewed_at`,
`review_findings`, `recommendations`, `compliance_status`.

---

## Socket.io Events

### Emitted by server on auto-detection

**`session:crisis-detected`** → `admin-broadcast`
```json
{
  "sessionId": "...",
  "severity": "high",
  "riskScore": 82,
  "factors": ["kill myself"],
  "messageId": 123,
  "detectedAt": "...",
  "message": "HIGH risk detected (score: 82)"
}
```

**`session:crisis-emergency`** → session room + `admin-broadcast`
```json
{
  "sessionId": "...",
  "severity": "high",
  "riskScore": 82,
  "priority": "critical",
  "emergencyAt": "...",
  "requiresImmediateIntervention": true
}
```

**`session:risk-steering`** → admin dashboard, on every steering injection.

---

## Verification Checklist

- [ ] Message with explicit intent ("kill myself") → LLM assessment runs, session flagged HIGH,
      `session:crisis-emergency` emitted to admin-broadcast, safety-protocol steering injected
- [ ] Reference/negation ("I'd never hurt myself") → LLM assessment runs, severity `none`,
      session **not** flagged, risk_score_history row inserted
- [ ] 8 participant messages with no keyword hits → periodic sweep assessment runs
- [ ] LLM unavailable + keyword hit → keyword tier score stands (`keyword_fallback`)
- [ ] Medium severity → dashboard alert + work-queue item, no SMS
- [ ] Manual flag via SessionDetail → still works, any severity selectable
- [ ] Manual unflag → session cleared, crisis_events audit record created
