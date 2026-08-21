# Therapist pilot one-pager (internal)

Groundwork for selling the platform to licensed therapists as a supervised
practice companion. Companion artifacts: the therapist caseload demo track
(magic link + synthetic fixtures) and the `deployment_mode` config flag.

## 1. Positioning: what we are, and what we never claim

**One sentence:** A clinician-supervised AI practice companion that helps your
clients practice skills between sessions — under your supervision, on your
caseload, with every conversation visible to you.

Say: "supports skills practice between sessions under your therapist's
supervision", "your therapist reviews everything", "a tool the therapist
supervises", "practice companion", "between-session support".

Never say or imply:

- "AI therapy", "AI therapist", "AI-delivered therapy", "AI counseling", or
  that the AI diagnoses or treats. AI systems providing therapy or making
  therapeutic decisions are banned or restricted by state law: Illinois
  (HB 1806, Wellness and Oversight for Psychological Resources Act), Nevada
  (AB 406), and similar restrictions in Rhode Island and Maine. Our framing —
  a licensed clinician supervises and remains the treatment provider — is the
  compliant posture everywhere, so use it everywhere.
- Anything that crosses the FDA wellness-vs-device line. We are general
  wellness / skills practice: no diagnosis claims, no treatment or cure
  claims, no "reduces depression" outcome claims. Screeners (PHQ-2/GAD-2) are
  described as check-ins the therapist reviews, not diagnostic instruments.
- "Replaces sessions", "therapy on demand", or crisis-service claims. The
  product detects risk and escalates to the human therapist and public crisis
  resources (988); it is not a crisis service.

## 2. HIPAA posture checklist

Once one paying therapist uses this with real clients, we are a business
associate. Before pilot launch:

- [ ] **BAA from OpenAI.** Required before any real-client traffic.
      **Flag: Realtime API BAA eligibility must be verified explicitly** —
      zero-retention/BAA coverage for the Realtime (voice) endpoint is not
      guaranteed by a standard API BAA. Get it in writing; if Realtime is not
      covered, pilot launches chat-only.
- [ ] **BAAs WITH each pilot therapist** (we are their business associate).
      Use a standard template; free pilot does not waive this.
- [ ] Existing controls to present (already built):
  - PHI redaction pipeline, 18 HIPAA identifier categories, role-split
    transcripts (researchers see redacted; therapist role sees clinical
    content).
  - MFA on all admin accounts; session-based auth.
  - Data retention service with configurable windows + audit log; content
    wipe endpoint.
  - Encrypted backups.
  - Crisis escalation protocol with full audit trail (risk history,
    interventions, adverse-event reports).
- [ ] Gaps to close for clinical posture: caseload-scoped access (see
      section 4), clinical-mode consent copy (client consents to their
      therapist supervising, not to an IRB study).

## 3. Demo script for a therapist prospect (about 15 minutes)

1. **Magic link.** Send the `/demo/<token>` link. It self-provisions a demo
   account and lands on the demo overview; open the Clinician dashboard.
2. **Caseload week.** Users tab: four pseudonymous clients. Tell the week as
   a story: "Client A is six sessions in — open the profile: worksheets
   completed, PHQ-2 and GAD-2 trending down. Client D started their first
   session five minutes ago (Live Monitoring shows it)."
3. **Crisis drill.** Crisis Management: Client B's evening session was
   auto-flagged (risk 12 -> 46 -> 82 as ideation surfaced). Walk the
   intervention timeline: direct risk inquiry in-session, safety plan
   activated, therapist notified within seconds, clinician review that
   evening, next-morning follow-up session, flag resolved, incident report
   auto-drafted and signed off. Open the session detail and show the risk
   sparkline with the model's reasoning per message. This is the slide that
   sells supervision.
4. **"What the AI remembers."** Client C's profile: case profile, remembered
   facts, session summaries — exactly the bundle injected into the AI's
   prompt, so "what you see is what it knows". Contrast Client A (worksheet +
   screener trend) and Client D (empty first-session profile).
5. **Live voice session.** Switch to the Therapy bot and have the prospect
   talk to it for two minutes (real model, capped demo account). Then point
   out the session appearing in the dashboard.
6. **Close.** "You supervise all of it: transcripts, trends, alerts, and a
   kill switch per session. Your client gets structured practice between
   your sessions."

## 4. Pilot-readiness gaps (in priority order)

1. **Caseload RBAC** — DONE 2026-08-21 (`docs/caseload-rbac.md`,
   ai-therapist-119). Therapist accounts are row-scoped to
   `therapist_clients` assignments across every participant surface (HTTP,
   exports, Socket.io live events), with 404-over-403 semantics, immediate
   socket revocation on unassign, and an append-only
   `caseload_audit_log`. Adversarially reviewed twice (pre-ship coverage
   sweep + post-ship red team) and live-verified end to end in prod.
2. **Client invite flow** — DONE 2026-08-21. Therapist mints a single-use
   hashed-token link (`/join/<token>`, 7-day default TTL) from the Caseload
   view; the client self-registers and is auto-assigned to the inviting
   therapist. Link delivery is copy-paste (no email sending yet).
3. **Clinical-mode consent copy.** Current consent flow is IRB study
   language; clinical mode needs plain "your therapist supervises this tool"
   consent (the versioned-consent machinery can be reused as-is). NOW THE
   TOP REMAINING BLOCKER.
4. **Billing.** None exists. Not needed for a free pilot; needed before any
   paid conversion (likely per-seat per-month).
5. Smaller: therapist-facing onboarding docs; BAA paperwork from section 2;
   confirm `deployment_mode=clinical` hides the research surfaces end to
   end; email delivery for invite links.

## 5. Suggested pilot structure

- **Who:** 3-5 solo private-practice therapists (no group-practice IT or
  enterprise procurement), each with 2-5 volunteer clients.
- **Terms:** free, 8 weeks, BAA signed, clear off-ramp (data export +
  deletion at end).
- **Cadence:** 30-minute weekly feedback call per therapist; one shared
  metric sheet (sessions/week per client, worksheet completion, alerts and
  time-to-review, therapist-reported usefulness 1-5).
- **Success criteria:** therapists check the dashboard weekly without
  prompting; at least one "the alert caught something I would have missed a
  week of" story; 2 of 5 willing to pay something at the end.
- **Exit:** written case-study permission ask, pricing conversation, and a
  prioritized gap list from real usage.
