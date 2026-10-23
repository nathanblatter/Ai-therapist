// Per-client reads behind the clinician chart bundle (ai-therapist-199 item 3,
// GET /admin/api/clients/:userId/chart.zip). Every query is keyed by the
// client's user id and nothing else: the route has already passed
// requireClientAccess (caseload / organization), so these never widen scope.
// Shaping into CSV rows lives in services/clientChart.service.ts.
import { pool } from '../config/db.js';
import type { CareNoteRow } from './careNotes.queries.js';
import type { SessionSummary } from './insights.queries.js';

/** Signed and amended notes only — drafts are not part of the record. */
export async function getClientSignedNotes(clientId: number, limit = 1000): Promise<CareNoteRow[]> {
  const result = await pool.query<CareNoteRow>(
    `SELECT note_id, org_id, client_id, author_id, author_name, author_role,
            note_type, case_note_kind, session_id, seed_source, seed_model, content,
            status, shared_with_care_team, signed_at::text AS signed_at, sign_hash,
            amends_note_id, created_at::text AS created_at, updated_at::text AS updated_at
     FROM care_notes
     WHERE client_id = $1 AND status IN ('signed', 'amended')
     ORDER BY signed_at ASC NULLS LAST, note_id ASC
     LIMIT $2`,
    [clientId, limit],
  );
  return result.rows;
}

export interface ClientScreenerRow {
  session_id: string;
  scale: string;
  score: number;
  answers: unknown;
  created_at: Date;
}

/** Every scale response across the client's sessions, oldest first. */
export async function getClientScreeners(clientId: number, limit = 1000): Promise<ClientScreenerRow[]> {
  const result = await pool.query<ClientScreenerRow>(
    `SELECT sr.session_id, sr.scale, sr.score, sr.answers, sr.created_at
     FROM scale_responses sr
     JOIN therapy_sessions ts ON ts.session_id = sr.session_id
     WHERE ts.user_id = $1
     ORDER BY sr.created_at ASC, sr.scale ASC
     LIMIT $2`,
    [clientId, limit],
  );
  return result.rows;
}

export interface ClientSessionSummaryRow {
  session_id: string;
  session_name: string | null;
  session_type: string;
  modality: string | null;
  started_at: Date;
  ended_at: Date | null;
  duration_minutes: number | null;
  crisis_flagged: boolean;
  crisis_severity: string | null;
  summary: SessionSummary | null;
}

/**
 * One row per ended (non-demo) session, oldest first, with the structured
 * end-of-session summary when one exists. Deliberately never selects
 * soap_note: the SOAP draft is the therapist's working document and leaves
 * the system through the signed note, not the summary sheet.
 */
export async function getClientSessionSummaries(clientId: number, limit = 1000): Promise<ClientSessionSummaryRow[]> {
  const result = await pool.query<ClientSessionSummaryRow>(
    `SELECT ts.session_id, ts.session_name, ts.session_type, sc.modality,
            ts.created_at AS started_at, ts.ended_at,
            CASE WHEN ts.ended_at IS NULL THEN NULL
                 ELSE ROUND(EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) / 60.0, 1)::float END AS duration_minutes,
            COALESCE(ts.crisis_flagged, false) AS crisis_flagged,
            ts.crisis_severity,
            si.summary
     FROM therapy_sessions ts
     LEFT JOIN session_configurations sc ON sc.session_id = ts.session_id
     LEFT JOIN session_insights si ON si.session_id = ts.session_id
     WHERE ts.user_id = $1 AND ts.status = 'ended' AND ts.is_demo IS NOT TRUE
     ORDER BY ts.created_at ASC
     LIMIT $2`,
    [clientId, limit],
  );
  return result.rows;
}

export interface ClientCrisisEventRow {
  event_id: number;
  session_id: string | null;
  origin: string;
  event_type: string;
  severity: string | null;
  previous_severity: string | null;
  risk_score: number | null;
  previous_risk_score: number | null;
  triggered_by: string;
  trigger_method: string;
  risk_factors: unknown;
  /** Free text; may quote the participant. Dropped for non-therapists. */
  notes: string | null;
  created_at: Date;
}

/** Session-origin and thread-origin crisis events for one client, oldest first. */
export async function getClientCrisisEvents(clientId: number, limit = 1000): Promise<ClientCrisisEventRow[]> {
  const result = await pool.query<ClientCrisisEventRow>(
    `SELECT ce.event_id, ce.session_id, ce.origin, ce.event_type, ce.severity, ce.previous_severity,
            ce.risk_score, ce.previous_risk_score, ce.triggered_by, ce.trigger_method,
            ce.risk_factors, ce.notes, ce.created_at
     FROM crisis_events ce
     LEFT JOIN therapy_sessions ts ON ts.session_id = ce.session_id
     WHERE COALESCE(ts.user_id, ce.client_user_id) = $1
     ORDER BY ce.created_at ASC, ce.event_id ASC
     LIMIT $2`,
    [clientId, limit],
  );
  return result.rows;
}

export interface ClientInterventionRow {
  action_id: number;
  session_id: string;
  action_type: string;
  risk_score: number | null;
  performed_by: string | null;
  performed_at: Date;
  outcome: string | null;
  /** Free text; may quote the participant. Dropped for non-therapists. */
  notes: string | null;
}

/** Intervention actions across the client's sessions, oldest first.
 *  action_details is never selected (it carries message excerpts). */
export async function getClientInterventionActions(clientId: number, limit = 1000): Promise<ClientInterventionRow[]> {
  const result = await pool.query<ClientInterventionRow>(
    `SELECT ia.action_id, ia.session_id, ia.action_type, ia.risk_score,
            ia.performed_by, ia.performed_at, ia.outcome, ia.notes
     FROM intervention_actions ia
     JOIN therapy_sessions ts ON ts.session_id = ia.session_id
     WHERE ts.user_id = $1
     ORDER BY ia.performed_at ASC, ia.action_id ASC
     LIMIT $2`,
    [clientId, limit],
  );
  return result.rows;
}
