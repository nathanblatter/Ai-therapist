# Caseload RBAC — spec (ai-therapist-119, therapist-pilot blocker #1)

Status: SHIPPED 2026-08-21 (migrations 064-067 applied; live-verified E2E in
prod, 12/12 checks; two adversarial review rounds — 5 pre-ship + 5 post-ship
findings, all fixed). Owner: Nathan (review); built by agent fleet.

> **2026-08-28 update — care-team / data-tier model (caseworker portal,
> migrations 069-078).** The sections below describe the original
> therapist-only model and remain accurate for therapists; this update layers
> the care-team model on top. Full spec: `docs/caseworker-portal.md`.

## 2026-08-28: care-team edges, caseworker tier, org scoping

- **`therapist_clients` is now the care-team table** (070). Each row is a
  member -> client edge with `member_role IN ('therapist','caseworker')`;
  the `therapist_id` column holds ANY care-team member's userid (legacy name
  kept for deploy compatibility). No new table, no backfill: existing rows
  default to `member_role='therapist'`.
- **New first-class role `caseworker`** (070 widens the users role CHECK).
  Data tiers:
  - *Full* (therapist, researcher): message-level/transcript content.
  - *Summaries* (caseworker): AI session summaries (as-is, per Nathan's
    2026-08-28 decision 1), risk/crisis signals, screeners/mood, engagement
    metadata, safety plans, check-ins — **never verbatim therapy-session
    content**. Enforced at the `requireRole` allowlist wherever possible;
    response-level scrubbing where a summaries payload embeds verbatim text
    (crisis `risk_factors`/`intervention_details`/`notes`, risk-history
    `score_factors`, insights `soap_note` projection). Participant profile
    bundle (`/admin/api/users/:id/profile`, `/brief`) stays therapist-only —
    the 2026-08-28 embedded-verbatim audit found remembered facts, thought
    records, and clinician notes above the tier; caseworker drill-down uses
    the roster-detail endpoint + notes/escalations/messaging panels instead.
  - Live transcript streams / session-watch rooms: caseworker is an explicit
    `false` branch in `canAdminAccessSessionLive`.
- **Organizations + researcher scoping** (069, conflict decision C13).
  `organizations(org_id, slug, kind IN ('research','practice','sandbox'))`;
  every user has `organization_id` (all pre-069 users backfilled into the
  `irb-study` org). **Researchers are org-scoped like everyone else** — no
  globally-unscoped role. Same-org member<->client integrity is enforced at
  write time in `assignClient`.
- **Middleware**: `requireClientAccess` / `requireSessionClientAccess` /
  `requireMessageClientAccess` now gate on `isCareTeamRole(role)` (caseworker
  gets the identical assignment lookup + 404-over-403). `therapistScopeId`
  is deprecated in favor of `careTeamScopeId`. New foundation gates:
  `requireBodyClientAccess(field)`, `requireNoteAccess()`,
  `requireEscalationAccess()`, plus `middleware/org.ts` (`orgIdFor`) and
  `middleware/messaging.ts` (`requireThreadParticipant`,
  `requireThreadClinician`, `messagingRateLimit`).
- **Sockets**: caseworker sockets join `caseworker:<id>` (summary-tier
  events only; never `admin-broadcast`, never `therapist:<id>`).
  `broadcastAdminEvent` gained a `tier: 'full'|'summary'='full'` param —
  default fail-closed; `'summary'` additionally fans out to caseworker
  rooms. Every authenticated socket (incl. participants) also joins
  `user:<id>`, which carries ONLY `messaging:*` events.
- **Escalation claim** (approved decision 4): an org therapist claiming an
  unassigned escalation is auto-assigned to the client via `assignClient` +
  a `caseload_audit_log` 'assign' row (`{via:'escalation_claim'}`).
- **Invites**: a consumed client invite now grants the inviter's
  `member_role` and organization; caseworkers may mint invites (intake).
- **Sandbox** (077): per-signup `kind='sandbox'` orgs with `users.is_sandbox`
  denormalized; sandbox data is excluded from research exports, crisis
  paging, AE drafting, retention/wipe sweeps, and email — see
  `docs/caseworker-portal.md` section 7.
- **404-over-403 semantics are unchanged** and apply to every new surface
  (notes, escalations, work items, messaging threads).

## Problem

Every `therapist`-role account can see every participant's sessions, crisis
data, insights, profiles, and live sessions (`requireRole` is the only gate —
role-based, not row-scoped). A therapist pilot requires each therapist to see
ONLY their assigned clients. `docs/therapist-pilot.md` §4 names this gap #1;
the client invite flow is gap #2 and ships here too.

## Semantics (the security contract)

- **researcher**: unscoped, unchanged (study staff need the full view).
- **demo**: unchanged (served synthetic fixtures by the demo interceptor
  before real routers; never touches real data).
- **therapist**: scoped to assigned clients on every participant-scoped
  surface: session lists/details/transcripts, active sessions, crisis, risk
  history, insights, participant profiles/briefs, prep, sideband control,
  user-sessions listing, and the users roster. Non-participant surfaces
  (analytics aggregates, evals, config, knowledge, study ops) stay
  role-gated as today — MVP explicitly does not row-scope aggregates.
- **Unassigned access returns 404 for :userId/:sessionId resources** (not
  403 — don't confirm existence) **and filtered lists otherwise.**
- **Cutover backfill**: migration 064 assigns every existing participant to
  every existing therapist account, exactly preserving current behavior for
  the research deployment. New therapists/participants after cutover get
  explicit assignments only (via researcher UI or the invite flow).
- **Live monitoring (Socket.io)**: therapists may only join
  `session:<id>` rooms for assigned clients' sessions; therapist sockets
  never join `admin-broadcast` — participant-linked events fan out through
  `broadcastAdminEvent(ForSession)` to `therapist:<id>` rooms of assigned
  therapists only. (Researcher sockets unchanged.)
- **Revocation**: unassigning a client immediately kicks the therapist's
  live sockets out of that client's `session:<id>` rooms
  (`revokeTherapistSessionRooms`); event fan-out re-resolves the caseload
  per emit, so no restart is needed for either direction.
- **Exports**: therapists may export only a single named, assigned session
  (full/metadata/anonymized). `aggregated` exports are researcher-only —
  the aggregate query is platform-wide by design.

## Data model

```sql
-- 064_caseload.sql
CREATE TABLE therapist_clients (
  therapist_id INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  client_id    INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  assigned_by  INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (therapist_id, client_id)
);
CREATE INDEX idx_therapist_clients_client ON therapist_clients(client_id);
-- backfill: all existing participants -> all existing therapists
INSERT INTO therapist_clients (therapist_id, client_id)
SELECT t.userid, p.userid FROM users t CROSS JOIN users p
WHERE t.role = 'therapist' AND p.role = 'participant'
ON CONFLICT DO NOTHING;
```

```sql
-- 065_client_invites.sql
CREATE TABLE client_invites (
  invite_id    SERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,          -- sha256 hex of the raw token
  therapist_id INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  label        TEXT,                          -- therapist's note, e.g. client initials
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  used_by      INTEGER REFERENCES users(userid) ON DELETE SET NULL
);
CREATE INDEX idx_client_invites_therapist ON client_invites(therapist_id);
```

## Interface contracts (agents build to these exactly)

### `src/server/db/caseload.queries.ts`  (agent A)
```ts
export async function assignClient(therapistId: number, clientId: number, assignedBy: number | null): Promise<void>;  // idempotent (ON CONFLICT DO NOTHING); throws CaseloadRoleError if therapistId is not role=therapist or clientId not role=participant
export async function unassignClient(therapistId: number, clientId: number): Promise<boolean>; // true if a row was deleted
export async function isAssigned(therapistId: number, clientId: number): Promise<boolean>;
export async function getCaseloadClientIds(therapistId: number): Promise<number[]>;
export async function listCaseload(therapistId: number): Promise<Array<{ userid: number; username: string; created_at: string; assigned_at: string }>>;
export async function listAllAssignments(): Promise<Array<{ therapist_id: number; therapist_username: string; client_id: number; client_username: string; assigned_at: string }>>;
export class CaseloadRoleError extends Error {}
```

### `src/server/middleware/caseload.ts`  (agent B)
```ts
// All three: demo + researcher pass through untouched; unauthenticated -> 401 (reuse requireAuth upstream).
export function requireClientAccess(paramName?: string): RequestHandler;
//   therapist -> 404 unless isAssigned(session.userId, Number(req.params[paramName ?? "userId"]))
export function requireSessionClientAccess(paramName?: string): RequestHandler;
//   resolves the therapy session's user_id via getSessionAccessInfo(req.params[paramName ?? "sessionId"]),
//   404 if session missing; therapist -> 404 unless assigned to that user_id; sessions with null user_id -> 404 for therapists
export async function therapistScopeId(req: Request): Promise<number | null>;
//   returns session.userId when role==='therapist', else null — the value handed to scoped list queries
export async function canAdminAccessSessionLive(role: string | undefined, adminUserId: number | undefined, sessionUserId: number | null): Promise<boolean>;
//   for socket-layer checks: researcher true; therapist -> isAssigned; others false
```

### Scoped list queries  (agent C — edits existing db modules, additive optional param only)
```ts
// sessions.queries.ts
getAllSessions(scopeTherapistId?: number | null)
// adminSessions.queries.ts — every list/count export gains the same trailing optional param
// crisis.queries.ts — list/count exports (all crisis, active crisis) gain the param
// users.queries.ts
getAllUsers(scopeTherapistId?: number | null)  // when set: participants in caseload only, plus the caller's own row
```
Scoping is `EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $N AND tc.client_id = <user_id col>)`.
`undefined`/`null` scope = exactly today's SQL (byte-for-byte behavior for researchers).

### Routes  (agent D — edits admin route files + new caseload.routes.ts)
- Apply `requireClientAccess` to every `:userId` participant surface
  (participantProfile, insights risk-context, prep, userSessions).
- Apply `requireSessionClientAccess` to every `:sessionId` surface
  (sessions detail/transcript/end, crisis per-session, insights per-session,
  sideband).
- Thread `await therapistScopeId(req)` into every scoped list endpoint.
- New `src/server/routes/admin/caseload.routes.ts`:
  - `GET  /admin/api/caseload` — therapist: own caseload (listCaseload); researcher: listAllAssignments
  - `GET  /admin/api/caseload/therapists` — researcher-only: users with role=therapist
  - `POST /admin/api/caseload/:therapistId/:clientId` — researcher-only assign
  - `DELETE /admin/api/caseload/:therapistId/:clientId` — researcher-only unassign

### Invite flow  (agent E — new files only)
- `src/server/db/invites.queries.ts`: createInvite(therapistId, label, ttlHours=168) -> { rawToken, invite }; consumeInvite(rawToken) -> invite | null (single-use, unexpired, marks used); listInvites(therapistId).
- `src/server/routes/admin/invites.routes.ts`: therapist-only `POST /admin/api/caseload/invites` (returns the one-time link `/join/<rawToken>`), `GET /admin/api/caseload/invites` (own, with used/expired state).
- `src/server/routes/join.routes.ts` (public): `GET /join/:token` — minimal self-registration page (username+password) mirroring existing registration; `POST /join/:token` — validates+consumes invite, creates participant via createUser, auto-assigns to the inviting therapist via assignClient, logs them in.
- Tokens: 32 random bytes base64url, stored as sha256 hex only.

### Admin UI  (agent F — CaseloadView.tsx + AdminApp.tsx wiring)
- New "Caseload" NavItem in the People group, visible to therapist +
  researcher (not `researcherOnly`), `demoVisible: false` for MVP.
- `CaseloadView.tsx`: therapist mode = own client list + invite panel
  (create invite with label, copy link, see pending/used invites);
  researcher mode = assignment matrix (therapist picker, assign/unassign
  clients, powered by the caseload routes). react-feather icons, no emojis,
  match existing view idioms (useAdminFetch).

## Wiring done by the lead (not agents)
- `db/index.ts` barrel exports for caseload + invites queries.
- Router registration in `src/server/index.ts` (caseload + invites under the
  admin auth chain, `/join` public) and the Socket.io scoping patch using
  `canAdminAccessSessionLive`.
- Migration application (manual, per deploy convention), integration
  typecheck/test/lint, deploy.

## Out of scope (MVP)
- Multi-tenancy/orgs; therapist self-assign; billing; clinical consent copy
  (pilot gap #3); scoping aggregate analytics/evals; email delivery of
  invites (links are copy-paste).

## Test contract (agent-owned tests + integration)
- Every route agent ships tests in the existing `appAs(role)` supertest
  pattern; the load-bearing assertions: an unassigned therapist gets 404 on
  profile/session/crisis/prep/insights detail routes and filtered lists; a
  researcher sees everything; assignment CRUD is researcher-only; a consumed
  or expired invite is rejected; a fresh invite creates a participant
  assigned to the inviting therapist.
