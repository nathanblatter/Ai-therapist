# Caseworker Portal — Merged Implementation Spec

Synthesized 2026-08-27 from five slice designs (foundation / dashboard-queue-notifications /
escalations-notes / messaging / sandbox-consent-nav), reconciled against the code at `main`
(4ebd71b). Implements Nathan's six decisions of 2026-08-27. This document is the single
source of truth for the implementation slices in §8.

---

## 0. Conflict register (decisions made at merge, with rationale)

| # | Conflict | Resolution | Rationale |
|---|---|---|---|
| C1 | Care-team model: new `care_team_members` table (assumed by slices 2–5) vs evolve `therapist_clients` with `member_role` (foundation) | **`therapist_clients` + `member_role` column. No new table.** All references to `care_team_members(client_id, member_id, member_role)` in the other designs map to `therapist_clients(client_id, therapist_id, member_role)` — the `therapist_id` column holds any care-team member's userid (legacy name kept). | Verified against `064_caseload.sql`: the table is a bare member↔client edge; a new table adds backfill, dual-write, and re-verification of the just-red-teamed 404-over-403 + socket-revocation surface for zero data-model gain. Additive `ADD COLUMN ... DEFAULT 'therapist'` is forward/backward compatible across the manual-migration deploy window (known deploy gotcha). |
| C2 | Migration numbering (all slices used `07x` placeholders; foundation reserved a spine) | **Final: 069–078, ten migrations, order fixed in §1.** | FK dependencies force: orgs → role/care-team → care_notes → escalations; messaging → crisis-origin ALTER. |
| C3 | Sandbox flags: `organizations.kind='sandbox'` only (foundation) vs `organizations.is_sandbox` + `users.is_sandbox` + ride `therapy_sessions.is_demo` (sandbox slice) vs per-table `is_sandbox` (queue, messaging) | **`organizations.kind='sandbox'` is the source of truth** (no separate org boolean). **`users.is_sandbox` is kept as a denormalization** set at creation, never toggled. **Sandbox-owned sessions set `therapy_sessions.is_demo=TRUE`.** `work_items.is_sandbox` and `message_threads.is_sandbox` are kept, stamped from `users.is_sandbox` at insert. | Hot paths (crisis suppression, export WHEREs, notification guard) must not need an org join; `is_demo=TRUE` makes ~20 existing export/analytics exclusion sites work with zero query changes (verified sites in `export.queries.ts`, `datasetExport.queries.ts`, `analytics.queries.ts`). The `is_demo` overload (demo-role vs harness vs sandbox) is accepted and noted in the migration comment; behavioral gates use role / `is_sandbox`, not `is_demo`. |
| C4 | Escalations schema: `from_user_id`/`to_user_id` (dashboard slice's assumption) vs `raised_by`/`assigned_to` + `escalation_events` (escalation slice) | **Escalation slice's schema wins** (it owns the table). Dashboard roster query uses `escalations.client_id` + `status`. | Owner slice designed the full lifecycle; the assumption was a placeholder. |
| C5 | Messaging tables: dashboard slice assumed `client_messages`; messaging slice specced `message_threads`/`thread_messages`/`thread_read_state` | **Messaging slice's schema wins.** Roster unread counts come from a `messaging.queries.ts` helper (`countUnreadByClientForMember`). | Owner slice. |
| C6 | Caseworker access to `session_insights`: foundation allowed the GET route; dashboard slice excluded the `soap_note` field | **Route allowed for caseworkers with a scrubbed projection: `summary` + metadata yes; `soap_note` (therapist clinical-note draft) excluded.** | Both designs agree AI summaries are the core of the tier; SOAP is a progress-note draft, i.e. clinical documentation above the tier. Open question Q2 for Nathan. |
| C7 | Socket rooms: `caseworker:<id>` (foundation, dashboard) vs `user:<id>` (messaging) | **Both.** `caseworker:<id>` mirrors `therapist:<id>` for admin-broadcast summary-tier fan-out; `user:<id>` is joined by every authenticated socket (incl. participants) and used **only** for messaging events. | Keeps monitoring vs correspondence channels separable; participants need a room and are not admins. |
| C8 | Per-account sandbox org vs shared sandbox org | **One fresh `kind='sandbox'` org per consumed invite.** | 200 strangers in one org would see each other via org-scoped roll-ups; teardown = cascade-delete orgs. Batch id/label is the grouping mechanism. |
| C9 | Middleware gates specced by feature slices (`requireBodyClientAccess`, `requireNoteAccess`, `requireEscalationAccess`, `requireThreadParticipant`, `requireThreadClinician`) | **All built in the foundation slice** (middleware files are foundation-owned) so no feature slice edits `middleware/*.ts`. | Enables the zero-shared-file parallel work plan (§8). |
| C10 | Work-queue/notification hooks and sandbox suppression guards both edit `crisisPipeline.service.ts` / `crisisIntervention.service.ts` / `adverseEvent.service.ts` | **Those three files are edited only in the integration slice**, applying wiring manifests returned by the queue slice (enqueue hooks) and sandbox slice (suppression guards). | Contested files; edits are small, mechanical, specced exactly in §8. |
| C11 | `db/index.ts` barrel: nominally an integration-slice file | **Foundation edits the barrel** (append-only exports of the eight new query modules it creates). | Foundation runs serially before all feature slices — no parallel-conflict risk — and feature-slice route files cannot typecheck without the barrel exports. `src/server/index.ts`, `AdminApp.tsx`, participant `App.tsx`, `package.json` remain strictly integration-only. |
| C12 | Crisis events from messages: parallel table vs widen `crisis_events` | **Widen `crisis_events`** (076): nullable `session_id`, `origin`, `thread_message_id`, `client_user_id`. | 068 precedent (widen, don't fork); one audit trail for all crisis tooling. Pre-ship audit of `session_id IS NOT NULL` assumptions is a named integration task. |
| C13 | Researcher org scope | **Researchers are org-scoped like everyone else; no globally-unscoped role.** All current users backfill into the `irb-study` org, so behavior at cutover is identical. | Practice/sandbox org data has no research consent; scoping is structural IRB protection. Cross-org views become a future explicit superadmin role. |

---

## 1. Migrations (069–078)

Ten migrations, each with a `_rollback.sql`. Run order is the number order; migrate before
deploy (manual-migration convention). All are additive-with-defaults except 076 (drops a
NOT NULL — see its note).

### 069_organizations.sql

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS organizations (
  org_id     SERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'practice'
             CHECK (kind IN ('research', 'practice', 'sandbox')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE organizations IS
  'Lightweight org (agency/practice/study). kind=research is the IRB study; kind=sandbox orgs are demo-seeded and excluded from research & crisis paging pipelines.';

INSERT INTO organizations (slug, name, kind)
VALUES ('irb-study', 'IRB Research Study', 'research')
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER
  REFERENCES organizations(org_id) ON DELETE RESTRICT;
UPDATE users SET organization_id =
  (SELECT org_id FROM organizations WHERE slug = 'irb-study')
WHERE organization_id IS NULL;
ALTER TABLE users ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);

ALTER TABLE client_invites ADD COLUMN IF NOT EXISTS organization_id INTEGER
  REFERENCES organizations(org_id) ON DELETE CASCADE;
UPDATE client_invites ci SET organization_id = u.organization_id
  FROM users u WHERE u.userid = ci.therapist_id AND ci.organization_id IS NULL;
ALTER TABLE client_invites ALTER COLUMN organization_id SET NOT NULL;

COMMIT;
```

Rollback: drop `client_invites.organization_id`, `users.organization_id`, `organizations`.

### 070_caseworker_care_team.sql

```sql
BEGIN;

-- New first-class role (same named-constraint dance as 029).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('therapist', 'researcher', 'participant', 'demo', 'caseworker'));

-- Care-team evolution: therapist_clients rows become care-team edges.
ALTER TABLE therapist_clients ADD COLUMN IF NOT EXISTS member_role TEXT
  NOT NULL DEFAULT 'therapist'
  CHECK (member_role IN ('therapist', 'caseworker'));
CREATE INDEX IF NOT EXISTS idx_therapist_clients_client_role
  ON therapist_clients(client_id, member_role);

COMMENT ON TABLE therapist_clients IS
  'Care-team membership: member (therapist_id column, historically named; holds therapist OR caseworker userid) -> client. member_role selects the data tier (therapist=full, caseworker=summaries+signals). docs/caseload-rbac.md';
COMMENT ON COLUMN therapist_clients.therapist_id IS
  'Care-team member userid (therapist or caseworker; legacy column name kept for deploy compatibility)';

COMMIT;
```

Existing PK `(therapist_id, client_id)` stays. Same-org member↔client integrity is enforced
at write time in `assignClient` (extends the existing `CaseloadRoleError` validation query
to compare `organization_id`), not by trigger. Rollback: delete caseworker rows, drop
column, restore 4-role CHECK (mirror 029's rollback; caseworker users must be demoted first).

### 071_care_notes.sql

Single table for therapist progress notes and caseworker case notes (`note_type`
discriminator). One table, not two: the draft→sign lifecycle, immutability trigger,
sign-hash, amendment chain, visibility filtering, and unified client timeline are identical
machinery for both types; only content shape differs (typed JSONB + per-type validation).

```sql
BEGIN;

CREATE TABLE care_notes (
  note_id        BIGSERIAL PRIMARY KEY,
  org_id         INTEGER NOT NULL REFERENCES organizations(org_id),
  client_id      INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  author_id      INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  author_name    TEXT NOT NULL,                -- snapshot; signed docs must not lose authorship
  author_role    TEXT NOT NULL CHECK (author_role IN ('therapist','caseworker')),
  note_type      TEXT NOT NULL CHECK (note_type IN ('progress','case')),
  case_note_kind TEXT CHECK (case_note_kind IN ('contact','referral','coordination','safety_check','other')),
  session_id     TEXT REFERENCES therapy_sessions(session_id) ON DELETE SET NULL,
  seed_source    TEXT CHECK (seed_source IN ('ai_soap')),
  seed_model     TEXT,
  content        JSONB NOT NULL,   -- progress: {subjective,objective,assessment,plan}; case: {narrative, contact_method?, referral_to?, outcome?}
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed','amended')),
  shared_with_care_team BOOLEAN NOT NULL DEFAULT false,
  signed_at      TIMESTAMPTZ,
  sign_hash      TEXT,             -- sha256 of canonical JSON at sign time
  amends_note_id BIGINT REFERENCES care_notes(note_id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (note_type = 'case' OR case_note_kind IS NULL),
  CHECK (author_role = 'therapist' OR note_type = 'case')    -- caseworkers author case notes only
);
CREATE INDEX idx_care_notes_client ON care_notes (client_id, created_at DESC);
CREATE INDEX idx_care_notes_author_drafts ON care_notes (author_id) WHERE status = 'draft';
CREATE UNIQUE INDEX idx_care_notes_session_progress ON care_notes (session_id)
  WHERE note_type = 'progress' AND session_id IS NOT NULL AND status <> 'amended';

CREATE FUNCTION care_notes_block_signed_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'signed care_notes are immutable; amend instead';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_care_notes_immutable BEFORE UPDATE ON care_notes
  FOR EACH ROW EXECUTE FUNCTION care_notes_block_signed_update();

COMMIT;
```

Lifecycle: `draft` (author edits/deletes freely) → `sign` (computes `sign_hash`, immutable)
→ `amend` (new linked draft; signing the amendment flips original to `amended` in the same
tx). Signing a note seeded from AI SOAP also calls `markSoapReviewed`. Rollback: drop
trigger, function, table.

### 072_escalations.sql

```sql
BEGIN;

CREATE TABLE escalations (
  escalation_id   BIGSERIAL PRIMARY KEY,
  org_id          INTEGER NOT NULL REFERENCES organizations(org_id),
  client_id       INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  raised_by       INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  raised_by_role  TEXT NOT NULL CHECK (raised_by_role IN ('caseworker','therapist')),
  assigned_to     INTEGER REFERENCES users(userid) ON DELETE SET NULL, -- NULL = org unassigned queue
  reason          TEXT NOT NULL,
  urgency         TEXT NOT NULL CHECK (urgency IN ('routine','urgent','emergency')),
  crisis_event_id BIGINT REFERENCES crisis_events(event_id) ON DELETE SET NULL,
  session_id      TEXT REFERENCES therapy_sessions(session_id) ON DELETE SET NULL,
  note_id         BIGINT REFERENCES care_notes(note_id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  acknowledged_by INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  acknowledged_at TIMESTAMPTZ,
  resolved_by     INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_escalations_assignee_open ON escalations (assigned_to, created_at DESC) WHERE status <> 'resolved';
CREATE INDEX idx_escalations_org_unassigned ON escalations (org_id, created_at DESC) WHERE assigned_to IS NULL AND status <> 'resolved';
CREATE INDEX idx_escalations_client ON escalations (client_id, created_at DESC);

CREATE TABLE escalation_events (
  event_id       BIGSERIAL PRIMARY KEY,
  escalation_id  BIGINT NOT NULL REFERENCES escalations(escalation_id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL CHECK (event_type IN
    ('created','acknowledged','resolved','reopened','reassigned','claimed','comment')),
  actor_user_id  INTEGER,
  actor_username TEXT,
  detail         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_escalation_events_escalation ON escalation_events (escalation_id, created_at);

COMMIT;
```

State machine: `open → acknowledged → resolved`, `open → resolved` direct allowed,
`resolved → open` (reopen, by raiser or any care-team member, clears ack/resolve fields).
All transitions are guarded `UPDATE ... WHERE status = $expected` (409 on lost race).
No-therapist case: `assigned_to = NULL` → org unassigned queue; any org therapist may
`claim` (atomic `WHERE assigned_to IS NULL`); the claim handler also inserts a
`therapist_clients` row + `caseload_audit_log` 'assign' entry (the claimer needs access to
act) — flagged for Nathan (Q5). `urgency='emergency'` with no assignee notifies all org
therapists. Rollback: drop both tables.

### 073_work_queue.sql

```sql
BEGIN;

CREATE TABLE work_items (
  item_id      BIGSERIAL PRIMARY KEY,
  org_id       INTEGER NOT NULL REFERENCES organizations(org_id),
  client_id    INTEGER REFERENCES users(userid) ON DELETE CASCADE,
  assignee_id  INTEGER REFERENCES users(userid) ON DELETE SET NULL, -- NULL = pool item for the client's care team
  assignee_role TEXT CHECK (assignee_role IN ('caseworker','therapist')),
  item_type    TEXT NOT NULL CHECK (item_type IN (
    'crisis_flag','message_crisis','adverse_event','escalation_inbound','escalation_response',
    'note_awaiting_signature','inactivity','screener_worsening','message_unread_stale')),
  severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','urgent')),
  title        TEXT NOT NULL,
  detail       JSONB,                       -- reason payload; NEVER transcript/message text
  source_table TEXT NOT NULL,
  source_id    TEXT NOT NULL,               -- covers bigserial ids and synthetic keys like 'inactivity:42:2026-08-27'
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acked','resolved','expired')),
  acked_by     INTEGER REFERENCES users(userid), acked_at TIMESTAMPTZ,
  resolved_by  INTEGER REFERENCES users(userid), resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  is_sandbox   BOOLEAN NOT NULL DEFAULT false,   -- stamped from users.is_sandbox at insert
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_type, source_table, source_id)    -- idempotent producers
);
CREATE INDEX idx_work_items_assignee_open ON work_items(assignee_id, status) WHERE status IN ('open','acked');
CREATE INDEX idx_work_items_client ON work_items(client_id, created_at DESC);

COMMIT;
```

Materialized table, not a view: the ack/resolve lifecycle and pool-assignment routing are
state no source table owns; the `inactivity` type has no source row at all. Idempotent
upsert (`ON CONFLICT DO NOTHING`) + daily reconciliation sweep mitigate producer drift.
Rollback: drop table.

### 074_notifications.sql

```sql
BEGIN;

CREATE TABLE notifications (
  notification_id BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  work_item_id BIGINT REFERENCES work_items(item_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,          -- see §5 catalog
  title        TEXT NOT NULL,
  body         TEXT,
  read_at      TIMESTAMPTZ,
  emailed_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE notification_preferences (
  user_id    INTEGER PRIMARY KEY REFERENCES users(userid) ON DELETE CASCADE,
  email_mode TEXT NOT NULL DEFAULT 'digest' CHECK (email_mode IN ('immediate','digest','off')),
  urgent_email_immediate BOOLEAN NOT NULL DEFAULT true,
  digest_hour_local INTEGER NOT NULL DEFAULT 8 CHECK (digest_hour_local BETWEEN 0 AND 23),
  in_app_enabled BOOLEAN NOT NULL DEFAULT true
);

COMMIT;
```

Rollback: drop both tables.

### 075_messaging.sql

One thread per (client, clinician) pair — not a shared care-team thread — so the caseworker
tier is structurally enforced (a caseworker never has read access to the client↔therapist
thread; nothing to redact). Threads are bound to an active care-team assignment; unassign
freezes (read-only, retained), re-assign of the same pair unfreezes the same thread.

```sql
BEGIN;

CREATE TABLE message_threads (
  thread_id     BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(org_id),
  client_id     INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  clinician_id  INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  clinician_role TEXT NOT NULL CHECK (clinician_role IN ('therapist','caseworker')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
  frozen_at     TIMESTAMPTZ,
  frozen_reason TEXT,                            -- 'unassigned' | 'client_deactivated' | 'manual'
  is_sandbox    BOOLEAN NOT NULL DEFAULT FALSE,  -- stamped from users.is_sandbox at creation
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ,
  UNIQUE (client_id, clinician_id)
);
CREATE INDEX idx_message_threads_clinician ON message_threads(clinician_id, last_message_at DESC);
CREATE INDEX idx_message_threads_client ON message_threads(client_id);

CREATE TABLE thread_messages (
  message_id    BIGSERIAL PRIMARY KEY,
  thread_id     BIGINT NOT NULL REFERENCES message_threads(thread_id) ON DELETE CASCADE,
  sender_id     INTEGER NOT NULL REFERENCES users(userid),
  sender_role   TEXT NOT NULL CHECK (sender_role IN ('participant','therapist','caseworker')),
  body          TEXT NOT NULL CHECK (char_length(body) <= 4000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  risk_score    INTEGER,                         -- scan results: participant messages only
  risk_severity TEXT CHECK (risk_severity IN ('low','medium','high')),
  scan_status   TEXT NOT NULL DEFAULT 'not_applicable'
                CHECK (scan_status IN ('not_applicable','pending','clear','flagged','scan_failed')),
  crisis_event_id BIGINT REFERENCES crisis_events(event_id)
);
CREATE INDEX idx_thread_messages_thread ON thread_messages(thread_id, message_id DESC);
CREATE INDEX idx_thread_messages_flagged ON thread_messages(thread_id) WHERE scan_status = 'flagged';

CREATE TABLE thread_read_state (
  thread_id  BIGINT NOT NULL REFERENCES message_threads(thread_id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  last_read_message_id BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

COMMIT;
```

No edit/delete of sent messages in v1 (clinical record integrity). Rollback: drop three tables.

### 076_crisis_message_origin.sql

Widens `crisis_events` (068 pattern) so message-scan flags share the crisis audit trail.
**Riskiest migration** — integration slice runs a grep audit of every consumer assuming
`session_id IS NOT NULL` (`export.queries`, AE assembler, insights riskContext,
CrisisManagement queries) before this ships.

```sql
BEGIN;
ALTER TABLE crisis_events ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE crisis_events ADD COLUMN origin TEXT NOT NULL DEFAULT 'session'
  CHECK (origin IN ('session','thread_message'));
ALTER TABLE crisis_events ADD COLUMN thread_message_id BIGINT REFERENCES thread_messages(message_id);
ALTER TABLE crisis_events ADD COLUMN client_user_id INTEGER REFERENCES users(userid);
ALTER TABLE crisis_events ADD CONSTRAINT crisis_events_origin_check CHECK (
  (origin = 'session' AND session_id IS NOT NULL) OR
  (origin = 'thread_message' AND thread_message_id IS NOT NULL AND client_user_id IS NOT NULL)
);
CREATE INDEX idx_crisis_events_client ON crisis_events(client_user_id) WHERE client_user_id IS NOT NULL;
COMMIT;
```

Message flags use `trigger_method='auto'`, `triggered_by='system'`, `event_type='flagged'`.
`risk_score_history` is NOT written for message scans (session-local trajectory logic);
message risk lives on `thread_messages`. Rollback: drop constraint/columns, restore NOT NULL
(requires no thread-origin rows; delete them first).

### 077_sandbox.sql

```sql
BEGIN;

-- Denormalized per-user flag so hot paths (crisis suppression, export WHEREs,
-- notification guard) never need the org join. Set at creation, never toggled.
-- Source of truth is organizations.kind='sandbox' (069).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_users_sandbox ON users(is_sandbox) WHERE is_sandbox;

CREATE TABLE IF NOT EXISTS sandbox_invites (
  invite_id    SERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,                 -- sha256 hex, raw token never stored (065 pattern)
  batch_id     UUID NOT NULL,
  invite_role  TEXT NOT NULL CHECK (invite_role IN ('therapist','caseworker')),
  seed_profile TEXT NOT NULL DEFAULT 'standard',
  label        TEXT,
  created_by   INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  used_by      INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  org_id       INTEGER REFERENCES organizations(org_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_invites_batch ON sandbox_invites(batch_id);

COMMIT;
```

Rollback: drop `sandbox_invites`, drop `users.is_sandbox`.

### 078_consent_audience.sql

```sql
BEGIN;
ALTER TABLE consent_documents
  ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'research'
  CHECK (audience IN ('research','clinical'));
-- Replace the effective_at index with an audience-composite one
-- (verify the 047 index's actual name before writing the DROP).
DROP INDEX IF EXISTS idx_consent_documents_effective_at;
CREATE INDEX idx_consent_documents_effective ON consent_documents(audience, effective_at DESC);
-- Seed the clinical care-team consent doc (body in §6), version '2026-08-27.c1',
-- audience 'clinical', effective_at now(); body_hash computed the same way 047 seeds do.
COMMIT;
```

Rollback: drop the seeded row, restore the original index, drop the column.

---

## 2. Permission matrix — role × surface

Tiers: **Full** = message-level/transcript content; **Summaries** = AI summaries, risk/crisis
signals, screeners/mood, engagement metadata, safety plans, check-ins — never verbatim
therapy-session content; **Blocked** = 403/404 (404-over-403 semantics preserved everywhere
row scoping applies). Therapist and caseworker are always additionally row-scoped to their
caseload via `therapist_clients`; researcher is org-scoped (C13). Demo role behavior is
unchanged (synthetic fixtures, write-swallowed); participant has no admin access.

| Surface (routes / sockets) | Therapist | Caseworker | Researcher |
|---|---|---|---|
| GET `/admin/api/sessions/active` | Full (scoped) | **Summaries** (scoped, metadata-only) | Full (org) |
| GET `/admin/api/sessions` (list) | Full (scoped) | **Summaries** — `search` filter nulled if it matches message content (audit `listSessions`) | Full (org) |
| GET `/admin/api/sessions/:id` (detail incl. messages) | Full | **Blocked** (SessionDetail shows the "summary view" card via profile-side data instead) | Full (redacted) |
| POST session end / DELETE session / message edit-delete | Full | Blocked | Full |
| Recording / redaction-status routes | Full | Blocked | Full |
| GET participant profile | Full | **Summaries** (conditional on payload audit for embedded quotes — Q3) | Full |
| GET prep brief, `/users/:id/prep` | Full | **Blocked** initially (AI-composed from transcripts, likely quotes) | Full |
| GET `/users/:id/sessions` (metadata list) | Full | Summaries | Full |
| GET session insights | Full | **Summaries — scrubbed projection: `summary` yes, `soap_note` no** (C6) | Full |
| POST insights review/regenerate/notes | Full | Blocked | Full |
| POST `/users/:id/risk-context` | Full | Summaries | Full |
| GET crisis all/events/active | Full (scoped) | **Summaries** (scoped; extend the inline session check in `/crisis/events` to caseworkers) | Full (org) |
| GET risk-history | Full | **Summaries with scrub**: scores/severity/timestamps only — `score_factors` LLM reasoning can quote messages | Full |
| POST crisis flag | Yes | **Yes** (triage is the job) | Yes |
| POST wind-down / unflag | Yes | Blocked (de-escalation is clinical) | Yes |
| GET `/admin/api/caseload` (own) | Yes | Yes | Yes (all, org) |
| Caseload admin (assign/unassign, therapists list, audit) | Blocked | Blocked | Yes |
| POST/GET client invites | Yes | **Yes** (intake minting; consumed client gets inviter's `member_role` + org) | Yes |
| Export routes (bulk, aggregated, dataset) | per current | Blocked | Yes (org-scoped — highest-stakes org filter) |
| Sideband routes (all 8) | per current | Blocked | per current |
| Adverse events | per current | **Blocked** initially (Q6) | per current |
| userSessions (login-session admin) | Blocked | Blocked | Yes |
| **Caseworker dashboard/roster** `/admin/api/caseworker/roster*` | Yes | Yes | Yes (org) |
| **Work queue** `/admin/api/work-items*` | Yes (own/pool) | Yes (own/pool) | Yes (org read) |
| **Notifications** `/admin/api/notifications*` | Self-scoped | Self-scoped | Self-scoped |
| **Escalations** list/detail/comment | Yes (assignee, caseload, org-unassigned) | Yes (raiser or care team) | Yes (org, metadata) |
| Escalation create | Yes | Yes | No |
| Escalation ack/resolve | Assignee | No (reopen: raiser yes) | No |
| Escalation claim | Yes (org therapists) | No | No |
| **Notes** — case notes | Read care-team, author case? No — author role check: therapist reads all care-team notes | Author + read care-team case notes | **Blocked** initially (Q7) |
| Notes — progress notes | Author + care-team therapists | Only if `shared_with_care_team=true` | Blocked initially |
| **Messaging** admin inbox/threads | Own threads only | Own threads only | **Blocked** v1 (clinical correspondence, not study data — Q8) |
| Messaging participant routes | n/a | n/a | n/a (participant self-scoped) |
| **Sandbox invites** `/admin/api/sandbox/invites*` | Blocked | Blocked | Yes |
| Consent version admin (+ audience) | per current | Blocked | Yes |
| **Sockets:** live transcript streams / session-watch rooms (`canAdminAccessSessionLive`) | Yes | **No** (explicit `false` branch) | Yes |
| Sockets: `admin-broadcast` room | n/a | n/a | Yes |
| Sockets: `therapist:<id>` room (full-tier events) | Yes | No | n/a |
| Sockets: `caseworker:<id>` room (summary-tier events only) | No | Yes | n/a |
| Sockets: `user:<id>` room (messaging events only) | Yes | Yes | No (no threads) |

Enforcement principle: tier is enforced at the **route allowlist level** (`requireRole`)
wherever possible — blocked routes cannot leak. Response-level scrubbing
(`scrubForSummariesTier()` serializer) only where a summaries payload embeds verbatim text:
risk-history `score_factors`, crisis event excerpt fields, insights projection, participant
profile (pending audit). A caseworker-targeted red-team round is an integration-slice task.

---

## 3. API route map

### Middleware changes (foundation)

`src/server/middleware/auth.ts`
- `canAccessAdmin`: + `'caseworker'`.
- `canViewUnredactedData` / `canViewRedactedData`: unchanged (caseworkers see no message content).
- New export `requireFullContent = requireRole('therapist','researcher')` applied to every transcript/message/recording route (documents intent; behavior unchanged today).

`src/server/middleware/caseload.ts`
- `requireClientAccess` / `requireSessionClientAccess` / `requireMessageClientAccess`: guard changes from `role !== 'therapist'` to `!isCareTeamRole(role)`; caseworkers get the identical assignment lookup + 404-over-403. No SQL change (caseworker rows live in `therapist_clients`).
- `therapistScopeId` → `careTeamScopeId` (returns userId for any care-team role); old name kept as deprecated alias.
- `canAdminAccessSessionLive`: explicit `caseworker → false` branch.
- New gates (foundation-built, feature-consumed): `requireBodyClientAccess(field)` (client id from `req.body`), `requireNoteAccess()` (loads note → 404; §2 visibility matrix), `requireEscalationAccess()` (researcher passes; therapist: assignee OR caseload OR same-org-unassigned; caseworker: raiser OR care team).

New `src/server/middleware/org.ts` — `orgIdFor(req)` with lazy session write-back for
pre-069 sessions; login stamps `req.session.orgId`.

New `src/server/middleware/messaging.ts` — `requireThreadParticipant` (404 unless thread's
`client_id` = me; send additionally requires `status='active'` → 409 `thread_frozen`),
`requireThreadClinician` (404 unless `clinician_id` = me), `messagingRateLimit`
(~30 msgs/hour/user).

New shared types `src/shared/roles.ts` — `UserRole` (adds `caseworker`, fixes the latent
missing-`demo` bug in `src/server/types.ts`), `CareTeamRole`, `DataTier`, `isCareTeamRole`,
`dataTierFor`, `CareTeamMember`. `src/server/types.ts` re-exports; `SessionUser` gains
`organizationId`.

### New route files

| File | Routes | Middleware chain |
|---|---|---|
| `src/server/routes/admin/caseworkerDashboard.routes.ts` | GET `/admin/api/caseworker/roster`; GET `/admin/api/caseworker/roster/:userId/detail` | `requireAuth, requireRole('caseworker','therapist','researcher')` (+ `requireClientAccess()` on detail) |
| `src/server/routes/admin/workQueue.routes.ts` | GET `/admin/api/work-items`; POST `/admin/api/work-items/:itemId/ack`; POST `.../resolve` | `requireAuth, requireRole('caseworker','therapist','researcher')`; ownership enforced in query (assignee = me, or pool item on my caseload), 404-over-403; state changes append to `caseload_audit_log` |
| `src/server/routes/admin/notifications.routes.ts` | GET `/admin/api/notifications`; POST `.../read`; GET/PUT `.../preferences` | `requireAuth` (rows self-scoped by `user_id`) |
| `src/server/routes/admin/escalations.routes.ts` | POST `/admin/api/escalations` (`requireBodyClientAccess('client_id')`); GET list; GET `/:id` ; POST `/:id/acknowledge` `/resolve` `/reopen` `/comments` (all `requireEscalationAccess()`); POST `/:id/claim` (`requireRole('therapist')` + org check) | `requireAuth, requireRole(...)` per §2 |
| `src/server/routes/admin/notes.routes.ts` | POST/GET `/admin/api/users/:userId/notes` (`requireClientAccess()`); GET/PUT/DELETE `/admin/api/notes/:noteId`, POST `/:noteId/sign` `/amend` `/share` (all `requireNoteAccess()`); POST `/admin/api/sessions/:sessionId/notes/from-insights` (`requireRole('therapist'), requireSessionClientAccess()`, idempotent via the unique partial index) | caseworker ⇒ `note_type='case'` enforced in handler (400) |
| `src/server/routes/admin/messaging.routes.ts` | GET `/api/admin/messaging/inbox`; POST `/threads` (verifies active assignment, get-or-create); GET/POST `/threads/:threadId/messages`; POST `/threads/:threadId/read`; GET `/clients/:userId/threads` (`requireClientAccess()`) | `requireAuth, requireRole('therapist','caseworker'), requireThreadClinician` on thread routes |
| `src/server/routes/public/messaging.routes.ts` | GET `/api/messaging/threads`; GET/POST `/api/messaging/threads/:threadId/messages`; POST `.../read` | `requireAuth, requireThreadParticipant` (+ `messagingRateLimit` on send). Participants cannot create threads (auto-created on assignment) |
| `src/server/routes/admin/sandboxInvites.routes.ts` | POST `/admin/api/sandbox/invites` (count 1–500, role, label, ttl; returns raw links once); GET `/admin/api/sandbox/invites` (batches + counts) | `requireAuth, requireRole('researcher')`; audits via `insertCaseloadAudit` |

### Changed route/service files (by owning slice; foundation edits happen first, serially)

| File | Change | Slice |
|---|---|---|
| Admin route files (`sessions`, `crisis`, `caseload`, `invites`, `participantProfile` routes) | `requireRole` arg additions + `careTeamScopeId` per §2; scrub serializers | foundation |
| `src/server/routes/public/users.routes.ts` | login stamps `session.orgId`; auth-status returns `is_sandbox` | foundation |
| `src/server/routes/join.routes.ts` | consume assigns inviter's `member_role` + org (foundation); then `GET|POST /join-sandbox/:token` flow (sandbox slice, §7) | foundation → sandbox |
| `src/server/db/*` (caseload, sessions, crisis, export, users, consent queries) | org-scope param `(filters, {memberId, orgId})`; `assignClient` role+org validation + `member_role`; `getCareTeam`/`getCareTeamMemberIdsForClient`; `isSandboxAccountSession`; sandbox belt-and-suspenders filters (`datasetExport`, pseudonym assignment, `stats`, `studyOps`); `createUser` options arg `{orgId, isSandbox}`; consent audience param + per-audience cache | foundation |
| `src/server/utils/adminBroadcast.ts` | `tier: 'full'|'summary' = 'full'` param — default fail-closed; `'summary'` additionally fans out to `caseworker:<id>` rooms. Summary-safe events marked: session-started/ended, risk-score-updated (score+severity only), crisis-event-created (scrubbed) | foundation |
| `src/server/routes/admin/insights.routes.ts` | GET gains `authored_note` via `getLiveProgressNoteForSession`; caseworker scrubbed projection | escalations-notes slice |
| `src/server/routes/admin/prep.routes.ts` | + `recent_notes` (`getRecentSignedNotes(userId, viewer, 3)`) | escalations-notes slice |
| `src/server/routes/admin/caseload.routes.ts` | unassign path calls `freezeThreadsForPair(clinicianId, clientId, 'unassigned')` + emits `messaging:thread-frozen` | messaging slice |
| `src/server/services/crisisDetection.service.ts` | extract exported `analyzeStandaloneRisk(content, historyLines)` — stage-1 keyword + stage-2 LLM, no trajectory, no `risk_score_history`, no sweep counter | messaging slice |
| `src/server/utils/consent.ts`, `routes/admin/consent.routes.ts` | audience resolution from `deployment_mode`; research-doc fallback + warning; version admin accepts `audience` | sandbox slice |
| `chat.routes.ts` (minor safeguard), `dataRetention.service.ts`, `contentWipe.service.ts`, `sessionEval.service.ts` | `isSyntheticAccountSession` gate; sandbox exempt from wipe sweeps; skip eval enqueue for `is_demo` (verify) | sandbox slice |
| `crisisPipeline.service.ts`, `crisisIntervention.service.ts`, `adverseEvent.service.ts` | enqueueWorkItem hooks (queue slice manifest) + sandbox suppression guards (sandbox slice manifest): suppress `sendCrisisAlert` + AE auto-draft when `isSandboxAccountSession`, log `crisis_sms_suppressed_sandbox` intervention action; dashboard emits and sideband safety protocol stay ON | **integration** (C10) |
| `src/server/index.ts` | mount 8 routers; socket: `isAdmin` + caseworker, join `caseworker:<id>` and `user:<id>` rooms; register work-queue daily sweep + digest hourly sweep next to existing intervals (~line 832) | **integration** |

### New services / db modules

Services (feature slices): `workQueue.service.ts` (single entry `enqueueWorkItem`,
best-effort, never throws into callers), `notification.service.ts` (single choke point,
called only from workQueue.service; sandbox guard), `emailer.service.ts` (nodemailer over
SMTP: `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM` env; missing config → log-warn no-op;
`system_config` key `email_notifications` kill switch; **no client PHI in email bodies** —
"a client on your caseload has a new urgent item" + login link), `emailTemplates.ts`,
`messageSafety.service.ts` (§4 of messaging design: fire-and-forget scan; sandbox
short-circuit; keyword screen every participant message, LLM on hit; flag on
medium/high → crisis_events origin row + `message_crisis` work item + care-team
notifications without the verbatim body + `sendCrisisAlert` page on high — Q9),
`sandboxSeed.ts` + `sandboxSeed.fixtures.ts` (§7).

DB modules (foundation): `organizations.queries.ts`, `careNotes.queries.ts`,
`escalations.queries.ts`, `workQueue.queries.ts`, `notifications.queries.ts`,
`messaging.queries.ts` (incl. `listMessageOriginCrisisEvents`,
`countUnreadByClientForMember`, `freezeThreadsForPair`), `sandboxInvites.queries.ts`,
`caseworkerDashboard.queries.ts` (+ vitest for each). The dashboard module is the audit
boundary: it selects only from `users`, `therapy_sessions` (timestamps + `checkin` JSONB),
`session_insights.summary`, `risk_score_history`, `crisis_events`, `scale_responses`,
`practice_assignments`, `escalations`, messaging counts, safety plans — the `messages`
table is never joined. Roster is one lateral-join round trip (caseloads are tens of rows);
"needs attention" ranking computed in TS with explainable `{code,label,points}` reasons
(crisis_open 100, risk_high 60/risk_rising 40, escalation_open 50, screener_worsening 30,
inactive 25, unread_messages 20, mood_drop 15, practice_overdue 10), thresholds in
`system_config` key `attention_ranking`.

---

## 4. Frontend component map

### Admin SPA (`src/client/admin/`)

New:
- `components/CaseworkerDashboard.tsx`, `components/ClientStatusRow.tsx` — triage roster (StatCard row + Panel table, react-feather trend arrows, reason chips)
- `components/WorkQueue.tsx` (prop `role: 'caseworker'|'therapist'`, presentation-only default filters), `components/WorkItemRow.tsx`, `hooks/useWorkQueue.ts`
- `components/NotificationBell.tsx` (Bell + badge, dropdown), `components/NotificationPreferences.tsx`, `hooks/useNotifications.ts`
- `components/escalations/{EscalationInbox,EscalationComposer,EscalationDetail,MyEscalations}.tsx`
- `components/notes/{NotesPanel,NoteEditor,NoteDetail}.tsx` (SOAP 4-field / case-kind forms, autosave drafts, sign-with-confirm, amendment chain, provenance line "Drafted by AI, edited and signed by ...")
- `components/MessagingInbox.tsx`, `components/MessageThreadView.tsx` (+ small `FlaggedMessageRow` for CrisisManagement embed)
- `components/SandboxInvites.tsx` (mint form, links-shown-once + client-side CSV Blob download, batch history), `components/SandboxBanner.tsx` (persistent amber "Sandbox environment — all client data is synthetic")

Changed (owning slice in parens; AdminApp/ParticipantProfile/CrisisManagement/AdminHeader
are integration-only):
- `AdminApp.tsx` (integration): `NavItem.roles?: string[]`; new views `triage` (Operations), `work-queue`, `escalations` (Safety, open-count badge), `messages` (People), `sandbox` (Research, researcherOnly+researchOnly); caseworker hides Live Monitoring, Sessions, Adverse Events; role-dependent landing view (caseworker→triage, therapist→caseload, else sessions) with `ViewLoading` until auth resolves; SandboxBanner + one-time onboarding callout for sandbox users
- `AdminHeader.tsx` (integration): NotificationBell
- `ParticipantProfile.tsx` (integration): NotesPanel embed, escalation history strip, Messages tab (clinician's own thread only)
- `CrisisManagement.tsx` (integration): "Escalate to therapist" button (pre-links crisis_event), "Flagged message" row type for `origin='thread_message'` (links to thread, not session)
- `CaseloadView.tsx` (escalations-notes): per-client "Escalate" action for caseworkers
- `PrepBrief.tsx`, `SessionInsightsPanel.tsx` (escalations-notes): "Recent notes" card; "Start progress note from this draft" seed button / existing-note link
- `SessionDetail.tsx` (sandbox): empty-state card for transcript-less sandbox sessions and the caseworker "Summary view — full transcript is available to the treating therapist" card (one component, two uses)
- `ConsentVersions.tsx` (sandbox): audience tabs

### Participant SPA (`src/client/main/`)

New: `components/Messages.tsx` (thread list → conversation; frozen-thread state; permanent
banner: Info icon, "Messages are usually answered within 1–2 business days and are not
monitored in real time. If you need help right now:" + 988/741741 from `/api/config/crisis`;
system resources banner under flagged messages), `hooks/useMessaging.ts`,
`lib/userSocket.ts` (persistent authenticated socket; **HTTP poll fallback on view focus +
60s while open — sockets are latency sugar only**, per the known tunnel flakiness).

Changed (integration): `App.tsx` (`activeView: 'home'|'messages'`, mount userSocket, header
unread badge), `Home.tsx` (Messages card with MessageSquare icon + unread count; hidden for
anonymous/zero-thread users).

---

## 5. Notification event catalog (shared by dashboard, escalations, notes, messaging)

### Work item types (`work_items.item_type`) — the canonical enum

| type | producer | default assignee | severity |
|---|---|---|---|
| `crisis_flag` | session crisis pipeline hook | pool (client care team) | urgent |
| `message_crisis` | messageSafety.service | pool (client care team) | urgent (high) / warning (medium) |
| `adverse_event` | adverseEvent.service hook | pool | warning |
| `escalation_inbound` | escalation create | target therapist (or org pool if unassigned) | per urgency |
| `escalation_response` | escalation ack/resolve/comment | raising caseworker | info |
| `note_awaiting_signature` | notes: seeded draft created / draft stale | authoring therapist | info |
| `inactivity` | daily sweep (synthetic `source_id='inactivity:<clientId>:<date>'`; auto-expired on re-engagement) | pool | info |
| `screener_worsening` | daily sweep | pool | warning |
| `message_unread_stale` | daily sweep | thread clinician | info |

### Notification kinds (`notifications.kind`)

The nine work-item types above, plus `digest` (daily roll-up) and `note_shared` (therapist
shared a progress note / caseworker signed a case note — in-app only, no work item).

### Delivery policy

| kinds | in-app | email |
|---|---|---|
| `crisis_flag`, `message_crisis` (high), `escalation_inbound` (urgent/emergency) | immediate | immediate if `urgent_email_immediate` (default on) |
| `adverse_event`, `escalation_response`, `message_crisis` (medium) | immediate | per `email_mode` |
| `inactivity`, `screener_worsening`, `note_awaiting_signature`, `message_unread_stale`, `note_shared` | immediate | daily digest only |

Hard rules: sandbox users/orgs **never** receive email and **never** trigger
`sendCrisisAlert` paging (in-app only); email bodies carry zero client PHI.
`notification.service.ts` is called only from `workQueue.service.ts` (single choke point);
digest is an hourly sweep matching `digest_hour_local` via `utils/timezoneHelpers.ts`.

### Socket events

| event | rooms | tier / payload rule |
|---|---|---|
| `work_item:new` / `work_item:updated` | `therapist:<id>` / `caseworker:<id>` of assignee or pool members | work_items row only (transcript-free by construction) |
| `notification:new` | recipient's own `therapist:`/`caseworker:` room | title/kind/id |
| `escalation:created` / `escalation:updated` | client's therapist rooms + `admin-broadcast` + `caseworker:<raised_by>` | ids/urgency/reason headline, no clinical content |
| `note:signed` | care-team rooms per §2 visibility (shared progress or case notes only) | note_id, client_id, note_type, shared |
| `messaging:new-message` | `user:<recipient>` | thread + message |
| `messaging:read` | `user:<sender>` | thread, lastReadMessageId |
| `messaging:thread-frozen` | both `user:` rooms | thread, reason |
| `messaging:message-scanned` | `user:<clientId>` | `{threadId, messageId, flagged}` — no score/severity leaked to participant |
| `message:crisis-detected` | `broadcastAdminEvent(..., tier='summary')` → researcher + therapist + caseworker rooms | severity, factors, refs — **never the message body** to non-thread clinicians |
| existing session events via `broadcastAdminEvent` | + `caseworker:<id>` only when call site passes `tier='summary'` | default `'full'` = fail closed; transcript deltas, message events, sideband echoes stay full |

---

## 6. Clinical-mode consent copy — **NATHAN MUST REVIEW (verbatim draft)**

Seeded by migration 078 as `consent_documents` row, version `2026-08-27.c1`, audience
`clinical`. Selected when `deployment_mode='clinical'` via audience-aware
`getActiveConsentDocument()`; falls back to the research doc with a logged warning if no
clinical doc exists (never blocks session start). `ConsentScreen.tsx` needs no changes;
acceptance bookkeeping (`participant_consents` + `body_hash`, re-consent on new version)
works unchanged.

```markdown
## Before we begin

Please review and accept before starting your session.

- **What this is.** This app provides AI-assisted support sessions as part of the care you receive from your provider. It is not a replacement for your therapist and does not provide medical diagnoses.
- **Transcription.** What you say is transcribed to text so the assistant can respond and so your care team can review your sessions.
- **Your care team.** Your therapist can see your full sessions, including transcripts. If a care coordinator (caseworker) is part of your care team, they can see summaries and signals only — AI-written session summaries, mood and questionnaire trends, safety plans, check-ins, and safety alerts — never your word-for-word conversation.
- **Live monitoring.** A member of your care team may monitor sessions in real time and can send messages into your conversation if needed.
- **Crisis protocol.** If anything you say suggests you may be in danger, the system may show you crisis resources (e.g. the 988 Suicide & Crisis Lifeline), and a member of your care team may be notified so they can reach out to you directly.
- **Data handling.** Your session content is stored securely, is visible only to your care team as described above, and is retained according to your provider's records policy. Identifying details are redacted before any long-term storage.
- **Messaging.** If you and your care team use in-app messages, those messages are automatically screened for safety concerns and may trigger the same crisis protocol.

You can ask your provider any questions about this before accepting.
```

Review points for Nathan: is "care coordinator (caseworker)" the participant-facing term;
does the messaging bullet ship with v1 or behind the messaging feature. Sandbox note: fake
clients never log in, so no consent fires in a sandbox; the sandbox disclosure lives on the
`/join-sandbox` page + `SandboxBanner` ("This is a demonstration sandbox. All client
records are synthetic. Do not enter real patient information...") and is deliberately NOT a
`consent_documents` row.

---

## 7. Sandbox seeding spec

**Flow** (`POST /join-sandbox/:token`, mirroring `join.routes.ts` compensating-action
structure): atomic `consumeSandboxInvite` (410 if dead) → `createOrganization({name:
"<username>'s Sandbox", kind:'sandbox'})` → `createUser(username, password,
invite.invite_role, {orgId, isSandbox:true})` → `seedSandboxCaseload(user, org, rng)` in
the same request, single client, `BEGIN/COMMIT` → mark invite used + stamp `org_id` → audit
→ establish session. On any throw: delete user, delete org, `releaseSandboxInvite`, 410.

**Generator**: deterministic template pools, **no LLM calls at signup** (~1–2s, zero cost
at 200 accounts). PRNG mulberry32 seeded from `token_hash` (reproducible per account).
Content ports `demoFixtures.ts` archetypes (improving-anxiety, crisis-and-recovery,
long-continuity-burnout, brand-new) into DB-writing pools in `sandboxSeed.fixtures.ts`
(~10 personas × session summaries, SOAP drafts, note snippets, screener trajectories).

Per account (6–9 fake clients, rng):

| What | Table | ~Rows |
|---|---|---|
| Fake clients (role `participant`, `is_sandbox=TRUE`, org_id, unguessable password — never logged into) | `users` | 6–9 |
| Care-team edges (caseworker sandboxes also get one seeded fake therapist so escalation is demoable) | `therapist_clients` (+`member_role`) | 6–10 |
| Sessions (`status='ended'`, **`is_demo=TRUE`**, spread over 6–10 weeks) | `therapy_sessions` | ~35 |
| AI SOAP drafts (mix draft/reviewed) | `session_insights` | ~35 |
| Transcripts — **only 2 showcase sessions per client** (12–16 persona-scripted turns incl. one crisis exchange); other sessions have NO transcript (SessionDetail shows the empty-state card) | `messages` | ~200 |
| PHQ-9/GAD-7 trajectories (arcs ~50% improving / 25% flat / 25% declining) | `scale_responses` | ~60 |
| Risk history | `risk_score_history` | ~50 |
| Crisis events (crisis-arc client: resolved + one recent unresolved, direct inserts — no pipeline) + `intervention_actions` | `crisis_events` | ~6 |
| Safety plans | `safety_plans` | 2–3 |
| Practice + completed worksheets | `practice_assignments`, `worksheet_instances` | ~10 |
| Notes in the inviter's role voice | `care_notes` | ~10 |
| Mood check-ins | check-in store | ~30 |
| One open escalation (work queue never empty) | `escalations` | 1 |

Sizing: ~450 rows/account ≈ 90k rows at 200 accounts — trivial. If seeding grows past ~2s,
fall back to background seeding with an "assembling your caseload" state (additive change).

**Exclusion points** (sandbox data must never reach research/crisis pipelines):
1. Session create for `is_sandbox` owners sets `is_demo=TRUE` → research/dataset exports and analytics excluded with zero query changes (verified existing `is_demo IS NOT TRUE` sites).
2. Belt-and-suspenders `u.is_sandbox IS NOT TRUE` on `datasetExport` user enumeration, pseudonym assignment, `stats`/`studyOps` user counts.
3. `crisisIntervention.service.ts` (~line 270): suppress `sendCrisisAlert` paging when `isSandboxAccountSession`, log `crisis_sms_suppressed_sandbox`; dashboard visuals + sideband safety protocol stay ON (that is the product being demoed).
4. `adverseEvent` auto-draft skipped for sandbox sessions (no IRB AE pollution).
5. Session evals/drift: skip enqueue for `is_demo` sessions (verify current behavior).
6. Minor safeguard (`chat.routes.ts:175`): `isSyntheticAccountSession` = demo role OR `is_sandbox`.
7. Notifications: in-app only, never email, never page.
8. Message safety scan: short-circuit to `not_applicable`.
9. Retention/content-wipe sweeps: sandbox sessions **exempt** (a wiped sandbox is a broken demo) — Q11.

Teardown: batch-level "retire batch" (cascade-delete sandbox orgs) as follow-up; no TTL auto-delete.

---

## 8. Implementation work plan

Rules: slice F runs first, alone. Slices A–D run **in parallel with zero shared-file
edits** — each only creates new files plus edits files it exclusively owns (foundation's
serial edits to some of those files land before the parallel phase, which is fine). All
edits to `src/server/index.ts`, `AdminApp.tsx`, `AdminHeader.tsx`, `ParticipantProfile.tsx`,
`CrisisManagement.tsx`, participant `App.tsx`/`Home.tsx`, `package.json`, and the three
contested crisis service files go to slice I, driven by the wiring manifests each feature
slice returns. Exception per C11: the `db/index.ts` barrel is edited by foundation.
Verify after F and after I: `npm run typecheck`, `npm test`, `npm run lint`; feature
slices must keep their own new tests green but full-suite green is asserted at F and I.

### Slice F — foundation (serial, first)

Creates: migrations `069`–`078` + rollbacks; `src/shared/roles.ts`;
`src/server/middleware/org.ts`, `src/server/middleware/messaging.ts`;
`src/server/db/{organizations,careNotes,escalations,workQueue,notifications,messaging,sandboxInvites,caseworkerDashboard}.queries.ts` + tests.

Edits (serial, so allowed): `src/server/types.ts`, `src/server/middleware/auth.ts`,
`src/server/middleware/caseload.ts` (incl. the three new gates of C9),
`src/server/db/index.ts` barrel, `src/server/db/{caseload,sessions,crisis,export,users,consent}.queries.ts`
(+ sandbox filters in `datasetExport`/`stats`/`studyOps` queries),
`src/server/utils/adminBroadcast.ts`, `src/server/routes/public/users.routes.ts`,
`src/server/routes/join.routes.ts` (member_role + org on consume),
admin route files per the §2 matrix (RR args + scope + scrub only).

Exit criteria: full verify green; existing behavior unchanged for all current roles
(researchers scoped to `irb-study` see exactly today's data).

### Slice A — dashboard, work queue, notifications (parallel)

Creates: `routes/admin/{caseworkerDashboard,workQueue,notifications}.routes.ts` + tests;
`services/{workQueue,notification,emailer}.service.ts`, `services/emailTemplates.ts` + tests;
admin components `CaseworkerDashboard`, `ClientStatusRow`, `WorkQueue`, `WorkItemRow`,
`NotificationBell`, `NotificationPreferences`; hooks `useWorkQueue`, `useNotifications`.
Owns exclusively: nothing pre-existing.
Returns wiring manifest: mount 3 routers in `index.ts`; register daily work-item sweep +
hourly digest sweep in `index.ts` interval block (~832); `enqueueWorkItem` hook call sites
in `crisisPipeline.service.ts` (flag/severity-change → `crisis_flag`) and
`adverseEvent.service.ts` (new report → `adverse_event`); nav entries `triage`
(Operations, roles t/c/r) + `work-queue` (t/c); `NotificationBell` into `AdminHeader`;
`nodemailer` + `@types/nodemailer` into `package.json`; env vars `SMTP_*`, `EMAIL_FROM`.

### Slice B — escalations + notes (parallel)

Creates: `routes/admin/{escalations,notes}.routes.ts` + tests; admin components
`escalations/{EscalationInbox,EscalationComposer,EscalationDetail,MyEscalations}`,
`notes/{NotesPanel,NoteEditor,NoteDetail}`.
Owns exclusively: `routes/admin/insights.routes.ts` (authored_note field),
`routes/admin/prep.routes.ts` (recent_notes), `SessionInsightsPanel.tsx` (seed button),
`PrepBrief.tsx` (recent-notes card), `CaseloadView.tsx` (escalate action).
Returns wiring manifest: mount 2 routers; nav entry `escalations` (Safety, t/c, open-count
badge endpoint `GET /admin/api/escalations?count_only=1`); `ParticipantProfile` embeds
`NotesPanel` + escalation strip; `CrisisManagement` "Escalate to therapist" button;
escalation lifecycle calls `enqueueWorkItem('escalation_inbound'|'escalation_response')`
and note-seed creates `note_awaiting_signature` (calls go directly to the foundation-built
`workQueue.queries` insert if slice A's service isn't merged yet — integrator swaps to
`workQueue.service.enqueueWorkItem`).

### Slice C — messaging (parallel)

Creates: `routes/public/messaging.routes.ts`, `routes/admin/messaging.routes.ts` + tests;
`services/messageSafety.service.ts` + test; participant `components/Messages.tsx`,
`hooks/useMessaging.ts`, `lib/userSocket.ts`; admin `MessagingInbox.tsx`,
`MessageThreadView.tsx`, `FlaggedMessageRow.tsx`.
Owns exclusively: `services/crisisDetection.service.ts` (extract `analyzeStandaloneRisk`),
`routes/admin/caseload.routes.ts` (freeze-threads-on-unassign hook).
Returns wiring manifest: mount 2 routers; `user:<id>` room join in `index.ts` socket
handler; nav entry `messages` (People, t/c, unread badge); participant `App.tsx`
activeView + userSocket mount, `Home.tsx` Messages card, header badge; `ParticipantProfile`
Messages tab (`MessageThreadView` via `/clients/:userId/threads`); `CrisisManagement`
flagged-message row (`FlaggedMessageRow` + `listMessageOriginCrisisEvents`); pre-076
consumer audit checklist (C12).

### Slice D — sandbox + consent (parallel)

Creates: `routes/admin/sandboxInvites.routes.ts` + test; `services/sandboxSeed.ts`,
`services/sandboxSeed.fixtures.ts` + test; admin `SandboxInvites.tsx`, `SandboxBanner.tsx`.
Owns exclusively: `routes/join.routes.ts` (`/join-sandbox` flow), `utils/consent.ts`
(audience-aware cache), `routes/admin/consent.routes.ts` (audience param),
`ConsentVersions.tsx` (audience tabs), `SessionDetail.tsx` (empty-transcript + caseworker
summary cards), `chat.routes.ts` (minor-safeguard `isSyntheticAccountSession`),
`dataRetention.service.ts` + `contentWipe.service.ts` (sandbox exemption),
`sessionEval.service.ts` (is_demo skip verify/add).
Returns wiring manifest: mount 1 router; nav entry `sandbox` (Research, researcherOnly +
researchOnly); `SandboxBanner` + landing-view + onboarding callout in `AdminApp`;
suppression guards for `crisisIntervention.service.ts` (paging, ~line 270) and
`adverseEvent.service.ts` (auto-draft skip); `datasetExport.service.ts` README sentence.

### Slice I — integration (last; depends on A, B, C, D)

Edits: `src/server/index.ts` (all mounts, socket rooms/isAdmin, sweeps), `package.json`,
`crisisPipeline.service.ts` / `crisisIntervention.service.ts` / `adverseEvent.service.ts`
(A+D manifests), `AdminApp.tsx` (all nav/roles/landing/banner per manifests),
`AdminHeader.tsx`, `ParticipantProfile.tsx`, `CrisisManagement.tsx`, participant
`App.tsx`/`Home.tsx`/header. Tasks: apply all wiring manifests; run the 076 consumer audit
(grep `crisis_events` for `session_id` NOT NULL assumptions); `scrubForSummariesTier`
spot-audit of every caseworker-allowed payload (risk factors, crisis excerpts, insights,
profile); swap slice-B direct queue inserts to `workQueue.service`; full verify
(typecheck/test/lint) + a caseworker-targeted red-team round with the existing harness;
update `docs/caseload-rbac.md`.

Dependency graph: F → {A, B, C, D} → I. Total: 6 slices, 10 migrations.

---

## 9. Open questions for Nathan

1. **SOAP drafts for caseworkers**: route allowed but `soap_note` field excluded (summary only). Confirm the line — and whether verbatim quotes *inside* AI summaries are acceptable for the caseworker tier or need a redacted projection.
2. **Prep brief for caseworkers**: blocked v1 (likely quotes transcripts). Want a summaries-only caseworker brief variant later?
3. **Participant profile payload** must be audited for embedded message snippets before caseworker access flips on — approval is conditional on that audit.
4. **Escalation claim grants caseload access** (claiming therapist is auto-assigned to the client, audited). OK, or should emergencies stay org-admin-mediated?
5. **High-severity flagged messages page the on-call** (`sendCrisisAlert`), and the caseworker's crisis notification for a flag in the *therapist's* thread carries severity+factors but not the message body. Confirm both.
6. **Adverse events**: blocked for caseworkers v1 — should caseworkers be able to file AEs?
7. **Researcher access to notes/messages**: both blocked v1; content-free aggregates (counts, latency-to-sign) later?
8. **Async messages have no retention policy today** — retention window, participant-export inclusion, and IRB stance on out-of-session disclosures (no AE auto-draft in v1) need decisions before pilot.
9. **Email content**: PHI-free ("a client on your caseload...") is the default; client names in email is a BAA question.
10. **Sandbox data retained indefinitely** (exempt from wipe sweeps) until batch teardown — confirm.
11. **Consent copy** (§6) — wording review, incl. "care coordinator (caseworker)" terminology and whether the messaging bullet ships with v1.

---

## 10. ADDENDUM — Nathan's decisions on §9 open questions (approved in-chat 2026-08-28)

1. **SOAP/summaries for caseworkers**: summaries shown AS-IS (verbatim quotes inside AI summaries acceptable). No redacted projection.
2. **Prep brief**: SCOPE CHANGE — build the caseworker summaries-only brief variant NOW (screener deltas, engagement, open escalations, latest case note; zero transcript quotes). Therapist brief unchanged.
3. **Participant profile for caseworkers**: audit gate APPROVED — caseworker access flips on only after the integrator's embedded-verbatim audit passes; offending fields scrubbed or surface stays blocked.
4. **Escalation claim auto-grants caseload access** (audited): APPROVED.
5. **Flagged messages**: APPROVED both — high severity pages on-call via sendCrisisAlert; cross-thread caseworker notifications carry severity+factors, never message body.
6. **Adverse events**: SCOPE CHANGE — caseworkers CAN FILE AEs (submit form only); AE review/management stays therapist+researcher.
7. **Researcher access to notes/messages**: blocked v1 CONFIRMED; content-free aggregates are a later, separately-reviewed change.
8. **Message retention**: SCOPE CHANGE — messages RETAIN LIKE SESSIONS: include message threads/messages in dataRetention + contentWipe sweeps and in participant data exports. One consistent records policy.
9. **Emails**: PHI-free CONFIRMED (no client names/content in any email).
10. **Sandbox retention exemption** (kept until researcher-triggered batch teardown): CONFIRMED.
11. **Consent copy §6**: APPROVED AS DRAFTED — ships as v2026-08-27.c1, audience=clinical. Remove any "draft/needs review" badge from the UI.
12. **Sandbox invites in prod**: ALLOWED EVERYWHERE — no env kill-switch; sandbox org isolation is the boundary (useful for sales demos on the real domain).

Items 2, 6, 8 are net-new scope: implement as a follow-up slice after slice I verifies green (or fold into slice I if it has not started).
