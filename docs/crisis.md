# Crisis Management System

## Overview

The crisis detection system surfaces only truly imminent crisis signals (explicit suicidal/self-harm
intent) to the admin monitoring team. All scoring complexity has been removed to reduce false
positives and maintain researcher trust in the flagging system. Researchers exercise clinical
judgment on live sessions — the automated system only needs to alert on unambiguous danger.

---

## Detection: Keyword-Only

**File:** `src/server/services/crisisDetection.service.js`

### Imminent-Risk Keywords (score: 75 → HIGH severity)

| Category        | Keywords                                             |
|-----------------|------------------------------------------------------|
| Suicidal intent | `suicide`, `kill myself`, `end my life`, `want to die` |
| Self-harm       | `self-harm`, `cut myself`                            |
| Substance crisis | `overdose`                                          |

A single match immediately scores 75 and crosses the HIGH threshold. Nothing else triggers a flag.

### Scoring Logic

```
riskScore = min(keywordScore, 100)
severity  = riskScore >= 75 ? 'high' : 'none'
```

There are no medium or low severity levels in the automated system. Manual flagging via
SessionDetail can still assign any severity.

### Passive Logging

`trackEmotionalTrajectory()` is called on every analyzed message to maintain `risk_score_history`
for longitudinal research. Its output is **not** added to the risk score.

`risk_score_history` rows are inserted unconditionally for every analyzed message (score 0 or 75),
giving researchers a complete passive audit trail.

---

## Graduated Response

**File:** `src/server/services/crisisIntervention.service.js`

Only **high** severity triggers an automated response. There are no low-risk or medium-risk
automated branches.

### High Severity Response (admin alert only)

1. Emit `session:crisis-emergency` to the session room (client can surface a UI indicator)
2. Emit `session:crisis-emergency` to `admin-broadcast` (notifies all monitoring researchers)
3. Call `updateMonitoringFrequency(sessionId, 'critical')`

**No automated messages are sent to the participant.** The researcher on duty decides whether
and how to intervene.

---

## Auto-Flag Condition

**File:** `src/server/index.js` (crisis detection block, ~line 2218)

```js
const shouldFlag = riskAnalysis.severity === 'high' &&
  (!session.crisis_flagged || riskAnalysis.riskScore > currentScore + 10);
```

If the session is already flagged and the new score is not meaningfully higher, the flag is
not re-triggered (avoids duplicate events on repeated keywords in the same session).

---

## Manual Flag / Unflag

Unchanged. Researchers use the SessionDetail UI to flag/unflag with any severity and optional
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

Log of all automated and manual interventions. Columns: `action_id`, `session_id`, `action_type`,
`risk_score`, `action_details` (JSONB), `performed_by`, `performed_at`, `outcome`, `notes`.

### `risk_score_history`

Time-series passive log. Columns: `history_id`, `session_id`, `message_id`, `risk_score`,
`severity`, `score_factors` (JSONB: `keyword_score`, `keywords`), `calculated_at`.

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
  "riskScore": 75,
  "factors": ["kill myself"],
  "messageId": 123,
  "detectedAt": "...",
  "message": "HIGH risk detected (score: 75)"
}
```

**`session:crisis-emergency`** → session room + `admin-broadcast`
```json
{
  "sessionId": "...",
  "severity": "high",
  "riskScore": 75,
  "priority": "critical",
  "emergencyAt": "...",
  "requiresImmediateIntervention": true
}
```

---

## Verification Checklist

- [ ] Message containing `kill myself` → session flagged HIGH, `session:crisis-emergency` emitted to admin-broadcast, **no automated message in chat**
- [ ] Message containing `hopeless`, `overwhelmed`, `alone` → session **not** flagged, risk_score_history row inserted with score 0
- [ ] Manual flag via SessionDetail → still works, any severity selectable
- [ ] Manual unflag → session cleared, crisis_events audit record created
