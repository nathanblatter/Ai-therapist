// Data-access for IRB adverse-event reports (ai-therapist-95). Rows are
// self-contained snapshots (timeline + redacted excerpt copied in at draft
// time) so they survive content wipes / session deletion. Lifecycle is
// draft -> submitted -> closed, enforced with WHERE-clause transition guards.
import { pool } from '../config/db.js';

export interface AdverseEventTimelineEntry {
  at: string | null;
  kind: string;
  detail: string;
}
export interface AdverseEventActionEntry {
  at: string | null;
  action: string;
  by: string | null;
}

export interface AdverseEventRow {
  report_id: number;
  session_id: string | null;
  crisis_event_id: number | null;
  user_id: number | null;
  /** Owning organization (migration 108). NULL = unattributed, in irb-study custody. */
  organization_id: number | null;
  session_ref: string;
  participant_ref: string | null;
  occurred_at: Date;
  severity: 'low' | 'medium' | 'high';
  trigger_source: 'auto_crisis_flag' | 'manual' | 'auto_eligibility' | 'auto_survey';
  category: 'crisis' | 'eligibility_violation' | 'survey_report';
  summary: string;
  timeline: AdverseEventTimelineEntry[];
  transcript_excerpt: string | null;
  actions_taken: AdverseEventActionEntry[];
  status: 'draft' | 'submitted' | 'closed';
  due_at: Date;
  submitted_by: string | null;
  submitted_at: Date | null;
  closed_by: string | null;
  closed_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface AdverseEventRowWithFlags extends AdverseEventRow {
  overdue: boolean;
}

export interface InsertAdverseEventDraftInput {
  sessionId: string | null;
  crisisEventId: number | null;
  userId: number | null;
  /** Owning org. When omitted/null it is resolved from the participant's
   *  users.organization_id at insert time; stays NULL for anonymous rows. */
  organizationId?: number | null;
  sessionRef: string;
  participantRef: string | null;
  occurredAt: Date;
  severity: 'low' | 'medium' | 'high';
  triggerSource: 'auto_crisis_flag' | 'manual' | 'auto_eligibility' | 'auto_survey';
  /** Defaults to 'crisis' when omitted (back-compat with the crisis assembler). */
  category?: 'crisis' | 'eligibility_violation' | 'survey_report';
  summary: string;
  timeline: AdverseEventTimelineEntry[];
  transcriptExcerpt: string | null;
  actionsTaken: AdverseEventActionEntry[];
  dueAt: Date;
  createdBy: string;
}

/**
 * Insert an AE draft. Idempotent DO NOTHING on the relevant partial unique
 * index: per crisis_event_id for the crisis path, per session_id for the
 * auto_eligibility path (migration 054). Returns the new report_id, or null
 * when a matching draft already exists.
 *
 * organization_id (migration 108) is stamped in SQL: the explicit
 * organizationId when given, else the participant's users.organization_id,
 * else NULL (anonymous session) — so every producer scopes correctly without
 * resolving the org itself.
 */
export async function insertAdverseEventDraft(input: InsertAdverseEventDraftInput): Promise<number | null> {
  const category = input.category ?? 'crisis';
  // The two auto paths key on different partial unique indexes, so the
  // ON CONFLICT target must match the row being inserted.
  const conflictClause = input.triggerSource === 'auto_eligibility'
    ? `ON CONFLICT (session_id) WHERE trigger_source = 'auto_eligibility' DO NOTHING`
    : input.triggerSource === 'auto_survey'
      ? `ON CONFLICT (session_ref) WHERE trigger_source = 'auto_survey' DO NOTHING`
      : `ON CONFLICT (crisis_event_id) WHERE crisis_event_id IS NOT NULL DO NOTHING`;
  const result = await pool.query<{ report_id: number }>(
    `INSERT INTO adverse_event_reports
       (session_id, crisis_event_id, user_id, session_ref, participant_ref, occurred_at,
        severity, trigger_source, category, summary, timeline, transcript_excerpt, actions_taken,
        due_at, created_by, organization_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14, $15,
             COALESCE($16::int, (SELECT organization_id FROM users WHERE userid = $3)))
     ${conflictClause}
     RETURNING report_id`,
    [
      input.sessionId, input.crisisEventId, input.userId, input.sessionRef, input.participantRef,
      input.occurredAt, input.severity, input.triggerSource, category, input.summary,
      JSON.stringify(input.timeline), input.transcriptExcerpt, JSON.stringify(input.actionsTaken),
      input.dueAt, input.createdBy, input.organizationId ?? null,
    ],
  );
  return result.rows[0]?.report_id ?? null;
}

/**
 * Read scope for the register (ai-therapist-228). Every read path takes one;
 * there is no unscoped read.
 *   - orgId: the caller's organization. Rows with organization_id = orgId are
 *     visible; rows with organization_id IS NULL (unattributed) are visible
 *     only when orgId is the irb-study org.
 *   - careTeam: null for researchers (org-wide). A therapist additionally
 *     sees only rows whose participant is on their caseload, or that they
 *     filed themselves. A caseworker sees only rows they filed (spec s10
 *     item 6), still within their org.
 */
export interface AdverseEventScope {
  orgId: number;
  careTeam: { role: 'therapist' | 'caseworker'; memberId: number; username: string } | null;
}

/** Build the WHERE fragment (without a leading AND) + params for a scope.
 *  `offset` is the number of params already bound before these. */
export function adverseEventScopeClause(scope: AdverseEventScope, offset = 0): { sql: string; params: unknown[] } {
  const params: unknown[] = [scope.orgId];
  const orgParam = `$${offset + 1}`;
  const parts = [
    `(organization_id = ${orgParam}
      OR (organization_id IS NULL AND ${orgParam} = (SELECT org_id FROM organizations WHERE slug = 'irb-study')))`,
  ];
  if (scope.careTeam) {
    params.push(scope.careTeam.username);
    const userParam = `$${offset + params.length}`;
    if (scope.careTeam.role === 'caseworker') {
      parts.push(`created_by = ${userParam}`);
    } else {
      params.push(scope.careTeam.memberId);
      const memberParam = `$${offset + params.length}`;
      parts.push(`(created_by = ${userParam}
        OR (user_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM therapist_clients tc
          WHERE tc.therapist_id = ${memberParam} AND tc.client_id = adverse_event_reports.user_id)))`);
    }
  }
  return { sql: parts.join(' AND '), params };
}

const OVERDUE_EXPR = `(status = 'draft' AND due_at < CURRENT_TIMESTAMP)`;

/** List reports visible to `scope` (optionally filtered by status),
 *  newest-occurred first, with a computed `overdue` flag. */
export async function listAdverseEvents(
  filter: { status?: string | null },
  scope: AdverseEventScope,
): Promise<AdverseEventRowWithFlags[]> {
  const status = filter.status && filter.status !== 'all' ? filter.status : null;
  const scoped = adverseEventScopeClause(scope, 1);
  const result = await pool.query<AdverseEventRowWithFlags>(
    `SELECT *, ${OVERDUE_EXPR} AS overdue
     FROM adverse_event_reports
     WHERE ($1::text IS NULL OR status = $1)
       AND ${scoped.sql}
     ORDER BY occurred_at DESC`,
    [status, ...scoped.params],
  );
  return result.rows;
}

export interface AdverseEventCounts {
  draft: number;
  submitted: number;
  overdue: number;
  due_soon: number;
}

/** Dashboard counts over the rows visible to `scope`. due_soon = draft due
 *  within 48h (and not already overdue). */
export async function getAdverseEventCounts(scope: AdverseEventScope): Promise<AdverseEventCounts> {
  const scoped = adverseEventScopeClause(scope);
  const result = await pool.query<AdverseEventCounts>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'draft')::int AS draft,
       COUNT(*) FILTER (WHERE status = 'submitted')::int AS submitted,
       COUNT(*) FILTER (WHERE status = 'draft' AND due_at < CURRENT_TIMESTAMP)::int AS overdue,
       COUNT(*) FILTER (WHERE status = 'draft' AND due_at >= CURRENT_TIMESTAMP
                          AND due_at < CURRENT_TIMESTAMP + INTERVAL '48 hours')::int AS due_soon
     FROM adverse_event_reports
     WHERE ${scoped.sql}`,
    scoped.params,
  );
  return result.rows[0];
}

/** One report by id, or null when it does not exist OR is outside `scope`
 *  (callers map both to 404 so cross-org existence is never confirmable). */
export async function getAdverseEventById(id: number, scope: AdverseEventScope): Promise<AdverseEventRowWithFlags | null> {
  const scoped = adverseEventScopeClause(scope, 1);
  const result = await pool.query<AdverseEventRowWithFlags>(
    `SELECT *, ${OVERDUE_EXPR} AS overdue
     FROM adverse_event_reports
     WHERE report_id = $1 AND ${scoped.sql}`,
    [id, ...scoped.params],
  );
  return result.rows[0] ?? null;
}

export interface UpdateAdverseEventFields {
  summary?: string;
  transcript_excerpt?: string | null;
  actions_taken?: AdverseEventActionEntry[];
  timeline?: AdverseEventTimelineEntry[];
  due_at?: Date;
  severity?: 'low' | 'medium' | 'high';
}

/** Edit an AE draft. Only mutates rows still in 'draft'. Returns false if the row
 *  doesn't exist, isn't a draft, or no editable fields were supplied. */
export async function updateAdverseEventDraft(id: number, fields: UpdateAdverseEventFields): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown, cast = '') => {
    params.push(val);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (fields.summary !== undefined) add('summary', fields.summary);
  if (fields.transcript_excerpt !== undefined) add('transcript_excerpt', fields.transcript_excerpt);
  if (fields.actions_taken !== undefined) add('actions_taken', JSON.stringify(fields.actions_taken), '::jsonb');
  if (fields.timeline !== undefined) add('timeline', JSON.stringify(fields.timeline), '::jsonb');
  if (fields.due_at !== undefined) add('due_at', fields.due_at);
  if (fields.severity !== undefined) add('severity', fields.severity);
  if (sets.length === 0) return false;

  params.push(id);
  const result = await pool.query(
    `UPDATE adverse_event_reports
     SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE report_id = $${params.length} AND status = 'draft'`,
    params,
  );
  return (result.rowCount ?? 0) > 0;
}

/** draft -> submitted (sign-off). Only from 'draft'. */
export async function submitAdverseEvent(id: number, submittedBy: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE adverse_event_reports
     SET status = 'submitted', submitted_by = $2, submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE report_id = $1 AND status = 'draft'`,
    [id, submittedBy],
  );
  return (result.rowCount ?? 0) > 0;
}

/** submitted -> closed. Only from 'submitted'. */
export async function closeAdverseEvent(id: number, closedBy: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE adverse_event_reports
     SET status = 'closed', closed_by = $2, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE report_id = $1 AND status = 'submitted'`,
    [id, closedBy],
  );
  return (result.rowCount ?? 0) > 0;
}

/** submitted -> draft (pre-close corrections). Clears the sign-off stamp. */
export async function reopenAdverseEvent(id: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE adverse_event_reports
     SET status = 'draft', submitted_by = NULL, submitted_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE report_id = $1 AND status = 'submitted'`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}
