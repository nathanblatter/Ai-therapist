# Data Access Boundary — AI Therapist Study

**Purpose:** a one-page reference for the IRB describing exactly who can see which
participant data, at what level of identifiability, and where each boundary is
enforced in code. Written for the Phase 2 longitudinal protocol; the same
architecture backs Phase 1. Every claim below is enforced in the deployed
system, not aspirational.

> Verified against the codebase 2026-09-02. File references point to the
> enforcement site so reviewers (and future auditors) can confirm each claim.

---

## 1. Roles and what each may access

Five roles exist (`src/shared/roles.ts`). Access is enforced at two layers: a
role allowlist on every admin route (`requireRole`, `src/server/middleware/auth.ts`),
and — for the care team — a per-participant row scope on top of it
(`src/server/middleware/caseload.ts`).

| Role | Identifiable content | Redacted content | Scope |
| --- | --- | --- | --- |
| **Participant** | Own conversations only | n/a | Only their own account (ownership check) |
| **Therapist** | Yes — raw transcripts, for clinical care | Yes | Only participants assigned to them |
| **Researcher** | No (redacted only, except live-monitoring — see §3) | Yes | Study/organization scope |
| **Caseworker** | No — never verbatim therapy content | Summary tier only | Only participants on their caseload |
| **Demo** | Admin surfaces show synthetic fixtures only | n/a | Demo therapy sessions are real rows flagged `is_demo` and excluded from research export/paging |

"Sandbox" accounts (internal testers) are flagged in the database and are
**structurally excluded** from research export, crisis paging, adverse-event
drafting, and retention sweeps.

Key enforcement helpers (`src/server/middleware/auth.ts`):
`requireFullContent = requireRole('therapist','researcher')` gates every
transcript/message/recording route — caseworkers are excluded from verbatim
content by construction; `canViewUnredactedData` is **true for therapists only**.

---

## 2. Two copies of every message

Each conversation message is stored in two columns (`docs/anonymity.md`):
`content` (raw, as typed/spoken) and `content_redacted` (de-identified). The
column a viewer receives is chosen by role at query time
(`src/server/routes/admin/sessions.routes.ts`): therapists get raw `content`;
researchers get `content_redacted`. A researcher doing live crisis monitoring
sees raw content **only while a session is active**, reverting to the redacted
column the moment it ends.

Participants viewing their **own** history see their own unredacted words
(ownership-checked, `src/server/routes/public/sessions.routes.ts`).

---

## 3. The redaction boundary (who de-identifies, and who checks it)

1. **Automated redaction** (`src/server/services/redaction.service.ts`): every
   message passes through a dual-pass model redactor (OpenAI `gpt-5`) targeting
   the 18 HIPAA Safe Harbor identifiers. As of 2026-09-02 the per-session batch
   redactor is index-anchored with a retry and a per-item fallback, so a
   malformed model response can no longer leave a session unredacted
   (ai-therapist-150). Evidence: `docs/redaction-evidence-*.md`.
2. **Human verification** (`src/server/routes/admin/redaction.routes.ts`,
   researcher-only): a trained RA reviews and corrects redactions **seeing only
   the already-redacted text** — the verification queue never selects the raw
   `content` column (`src/server/db/redaction.queries.ts`). Corrections write
   only to `content_redacted`.

So the people who statistically analyze the data (researchers, RAs) never see
raw identifiers; the only role with raw access is the treating therapist, for
care.

---

## 4. What leaves the system (research export)

The dataset export (`src/server/services/datasetExport.service.ts`,
researcher-only route) emits a **de-identified** bundle keyed by pseudonym:

- **participants / sessions / screeners / moods / feedback / evals /
  crisis_events / surveys** CSVs — engagement, PHQ-2/GAD-2 scores, metadata,
  timestamps. Free-text is excluded (feedback exports a `has_comments` boolean,
  not the comment; crisis exports no notes; evals export scores, not
  rationales; surveys export completion + timing, not answers).
- Participants and sessions are pseudonyms (`P001…`, `S0001…`) minted from
  `research_pseudonyms`. **The pseudonym→identity mapping table is never
  exported** — re-identification requires direct database access.
- Demo and sandbox traffic are excluded from the default bundle. Anonymous
  sessions ARE included (flagged `is_anonymous`) but are deliberately not
  linkable to a person or across sessions — no account exists and the
  ownership cookie is never persisted server-side.

**Two gated egress paths beyond the default bundle:** transcripts leave only via
an opt-in `includeTranscripts=true` flag and even then only the redacted column;
verbatim participant feedback comments leave only via a separate opt-in file the
codebook labels "treat as identifiable data." Neither is in the default export.

---

## 5. Retention and destruction

- **Raw content is short-lived.** A nightly sweep
  (`src/server/services/contentWipe.service.ts`, default 24-hour retention)
  nulls the raw `content` column. By default (`require_redaction_complete:
  true`, a documented admin config toggle) it wipes **only after** redaction is
  confirmed complete, and messages with redaction errors are skipped, not
  blindly wiped. Every wipe is logged (`content_wipe_log`).
- **De-identified data is retained** indefinitely for analysis (disclosed in
  consent).
- **Audio recordings**: a separate retention job
  (`src/server/services/dataRetention.service.ts`) deletes recordings from
  object storage after a configurable window; every deletion is logged
  (`data_deletion_log`). This job ships **disabled** and is enabled deliberately.
- Redacted excerpts attached to adverse-event reports are deliberately retained
  as IRB regulatory records.

---

## 6. Infrastructure and audit

- **Operational data** lives in PostgreSQL (encrypted at rest at the volume
  level) and audio in S3-compatible object storage; de-identified analysis
  exports are shared via BYU Box with least-privilege access.
- **Access grants are audited**: caseload assignments, invites, and
  escalation claims are recorded in the append-only `caseload_audit_log`
  (no FK cascades — rows survive account deletion). Audit inserts are
  best-effort (a failed insert is logged, not rolled back), so the log is an
  investigative record rather than a transactional guarantee.
  Content-destruction jobs write their own logs (`content_wipe_log`,
  `data_deletion_log`), and those ARE written in the same transaction as the
  deletion.
- **Caseworker isolation is structural, not just cosmetic**: caseworker
  websocket connections join only their own summary-tier channels, never the
  admin broadcast, therapist, or per-session rooms — a caseworker cannot receive
  live transcript streams even in principle.

---

## Known limitations (disclosed for accuracy)

- Viewing a transcript in the admin UI is not itself audit-logged (only access
  *grants* and *deletions* are). If per-view read auditing is required, it is a
  known gap.
- Object storage relies on storage-/transport-level encryption; no additional
  application-layer envelope encryption is applied to recordings.
- Database TLS is enabled via configuration (`DATABASE_SSL`); the self-hosted
  deployment terminates TLS at the network boundary rather than the DB socket.
- The redaction and analysis model is currently OpenAI `gpt-5`; keep the model
  name in the IRB application in sync with `src/server/services/redaction.service.ts`.

---

*Maintained alongside the code. If a boundary changes, update this file and the
IRB Confidentiality of Data section together.*
