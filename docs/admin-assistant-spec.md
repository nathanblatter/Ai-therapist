# Admin Assistant (natural-language data chat) — spec for approval

**Status: DRAFT — awaiting Nathan approval. Not scheduled, not built.**
Origin: Gaskin suggestion, 2026-09-09 (flightdeck ai-therapist-161).

## Goal

A chat panel in the admin portal where staff ask natural-language questions
about study/system data and get answers computed from the same queries the
portal already runs — with exactly the access the asker's role already has.

Example queries by role:

- **Researcher**: "How many participants have completed the week-3 survey?"
  "Which participants had crisis flags this week?" "Average alliance total by
  study week." "Who hasn't had a session in 10 days?"
- **Therapist**: "Summarize my caseload's mood trend this week." "Which of my
  clients have open escalations?" "When was client 42's last session?"
- **Caseworker**: "What's in my work queue?" "Which of my clients had a risk
  signal since Monday?" (summaries tier — same data their dashboard shows)

## Non-goals (v1)

- **No writes.** Read-only tools; the assistant cannot ack, resolve, message,
  or edit anything.
- **No raw SQL / no generic query tool.** Every tool is a hand-written wrapper
  over an existing `db/*.queries.ts` function.
- **No verbatim participant content.** v1 tools return aggregates, metadata,
  scores, and statuses only — no transcript/message bodies, not even for
  full-tier roles. This is the single biggest safety simplification: it
  eliminates both the tier-leak risk and prompt-injection-via-participant-text
  risk in one stroke (participant free text never enters the model context).
- **No participant-facing surface.** Admin portal only.

## Architecture

```
AdminApp (new "Assistant" view, all staff roles)
   │  POST /admin/api/assistant/chat   { messages: [...] }   (SSE stream back)
   ▼
assistant.routes.ts ── requireAuth + requireRole(therapist|researcher|caseworker)
   │
   ▼
assistant.service.ts — agent loop (max 6 tool rounds, 60s budget)
   │      model: gpt-5.2 (existing chat model + OpenAI key; no new vendor)
   ▼
tool registry — each tool wraps an EXISTING query module and receives
   (sessionUserId, sessionRole) injected server-side. The model never chooses
   the caller identity; scoping is structural, not prompted.
```

### Tool inventory (v1) and role matrix

| Tool | Wraps | researcher | therapist | caseworker |
|---|---|---|---|---|
| `study_overview` | qualtrics surveys_scored aggregates, enrollment funnel | ✓ | — | — |
| `survey_completion` | per-participant completion matrix (ids + weeks, no free text) | ✓ | caseload only | — |
| `instrument_scores` | PHQ-2/GAD-2/WAI-SR aggregates by week | ✓ | caseload only | — |
| `session_stats` | sessions metadata: counts, durations, last-session-at | ✓ | caseload only | caseload only |
| `crisis_events` | crisis event rows (severity, timestamps, status — no content) | ✓ | caseload only | caseload only |
| `escalations` | listEscalations (existing role scoping) | ✓ | own/caseload | own/caseload |
| `work_queue` | listWorkItemsForMember / ForOrg (existing scoping) | org | own | own |
| `caseload_roster` | caseworkerDashboard roster (attention ranking) | ✓ | own | own |
| `user_lookup` | username→id, role, study status (no auth fields) | ✓ | caseload only | caseload only |

Rules:
- Tool handlers call the same functions the existing routes call, passing the
  session's userId/role — a therapist's `session_stats` physically cannot
  query outside `therapist_clients`, same as the portal.
- Tier enforcement is per-tool allowlist (table above), checked server-side
  before execution; a disallowed tool call returns a structured refusal the
  model relays ("your role doesn't have access to that").
- 404-over-403 semantics preserved: off-caseload lookups return "not found".

### Auditability

Every turn appends to a new `assistant_audit` table: user, role, question,
tools called with arguments, row counts returned (not payloads), model,
token usage, timestamp. This is the IRB-grade answer to "who asked what about
participant data" and doubles as the usage/cost monitor.

### Vendor data flow (IRB posture)

Tool outputs (aggregates/metadata/scores) are sent to OpenAI as model context
under the existing account — the same vendor already processing participant
audio/transcripts per the Phase 2 application's Commercial-AI-models
disclosure. Because v1 tools exclude free text, the assistant's vendor
exposure is a strict subset of existing flows. If the IRB text needs a
sentence, it is one sentence in the staff-tools paragraph; likely covered by
the existing model-inventory disclosure (confirm with Gaskin at submission).

### UI

- New nav item **Assistant** (all three staff roles), chat view with:
  - streamed responses; visible tool-call breadcrumbs ("checked: survey
    completion, weeks 1–8") so staff can see where an answer came from;
  - role-appropriate quick-prompt chips (the examples above);
  - a persistent footer note: "Answers are computed from your own data access.
    Verify anything consequential in the underlying panel."
- No emojis; react-feather icons.

### Limits and failure modes

- Rate limit per user (e.g. 30 requests / 10 min) + per-turn tool-round cap.
- Model unavailability degrades to a clear error, never a silent stall.
- The assistant is *advisory*: every answer includes which tools ran; a wrong
  aggregate is discoverable, and no action can be taken through it.

## Rollout

1. Build behind `ASSISTANT_ENABLED=true` env flag; stage first.
2. Kimberly + Nathan stress-test on stage (she has full researcher access and
   can also exercise the therapist/caseworker scoping by role-switching).
3. Prod only after Phase 2 submission and a red-team pass (add 2–3 scenarios:
   caseworker asking for transcript content; therapist asking about an
   off-caseload client; prompt-injection via a crafted username).

## Estimate

- ~1 day MVP (service + 6–8 tools + route + view + audit table + tests).
- Runtime cost: minor (short contexts, aggregates only, gpt-5.2 per-request).

## Open questions

1. Include therapist access to *redacted* transcript excerpts in v2? (Big
   step: reintroduces participant text into model context; needs its own
   injection hardening + IRB sentence. Recommend explicitly deferring.)
2. Conversation persistence (v1 keeps history client-side per browser tab;
   audit table is the durable record). Persist threads later if staff want it.
3. Does Gaskin want scheduled digests ("email me enrollment every Monday")?
   Out of scope v1; the reminder infrastructure could support it later.
