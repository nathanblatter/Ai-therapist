// Crisis-event adjudications (eval program WP2, migration 114): one human
// verdict per (crisis event, adjudicator). Written by routes/admin/crisis.routes.ts;
// surfaced on the crisis dashboards, counted in the rating-queue view, and
// exported (verdict only) by the dataset export.
import { pool } from '../config/db.js';
import { ownerOrgScopeSql } from './organizations.queries.js';

export type AdjudicationVerdict = 'confirmed' | 'false_positive' | 'unclear';
export const ADJUDICATION_VERDICTS: readonly AdjudicationVerdict[] = ['confirmed', 'false_positive', 'unclear'] as const;

export interface CrisisEventAdjudicationRow {
  adjudication_id: number;
  crisis_event_id: number;
  adjudicator_id: number;
  adjudicator_username?: string;
  adjudicator_role?: string;
  verdict: AdjudicationVerdict;
  note: string | null;
  adjudicated_at: Date;
}

/** Every adjudication on one event, newest first (JOIN users for who). */
export async function getCrisisEventAdjudications(eventId: number): Promise<CrisisEventAdjudicationRow[]> {
  const result = await pool.query<CrisisEventAdjudicationRow>(
    `SELECT a.*, u.username AS adjudicator_username, u.role AS adjudicator_role
     FROM crisis_event_adjudications a
     LEFT JOIN users u ON u.userid = a.adjudicator_id
     WHERE a.crisis_event_id = $1
     ORDER BY a.adjudicated_at DESC`,
    [eventId]
  );
  return result.rows;
}

/** Upsert the caller's verdict on an event (re-adjudicating overwrites). */
export async function upsertCrisisEventAdjudication(
  eventId: number,
  adjudicatorId: number,
  verdict: AdjudicationVerdict,
  note: string | null
): Promise<CrisisEventAdjudicationRow> {
  const result = await pool.query<CrisisEventAdjudicationRow>(
    `INSERT INTO crisis_event_adjudications (crisis_event_id, adjudicator_id, verdict, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (crisis_event_id, adjudicator_id) DO UPDATE
       SET verdict = EXCLUDED.verdict,
           note = EXCLUDED.note,
           adjudicated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [eventId, adjudicatorId, verdict, note]
  );
  return result.rows[0];
}

/**
 * Crisis events with no adjudication yet, under the same scoping as the
 * crisis dashboards (care-team caseload and/or researcher org; thread-origin
 * events resolve their owner via client_user_id; demo excluded).
 */
export async function countUnadjudicatedCrisisEvents(
  scopeTherapistId?: number | null,
  orgId?: number | null
): Promise<number> {
  const params: unknown[] = [];
  let clause = '';
  if (scopeTherapistId !== null && scopeTherapistId !== undefined) {
    params.push(scopeTherapistId);
    clause += `
       AND EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $${params.length} AND tc.client_id = COALESCE(ts.user_id, ce.client_user_id))`;
  }
  if (orgId !== null && orgId !== undefined) {
    params.push(orgId);
    clause += `
       AND ${ownerOrgScopeSql(`$${params.length}`, 'COALESCE(ts.user_id, ce.client_user_id)')}`;
  }
  const result = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM crisis_events ce
     LEFT JOIN therapy_sessions ts ON ts.session_id = ce.session_id
     WHERE ts.is_demo IS NOT TRUE
       AND NOT EXISTS (SELECT 1 FROM crisis_event_adjudications a WHERE a.crisis_event_id = ce.event_id)${clause}`,
    params
  );
  return result.rows[0]?.n ?? 0;
}

/**
 * SQL fragment that attaches an `adjudications` JSON array (verdict metadata,
 * never the note) to a crisis_events row aliased `ce`. Shared by the crisis
 * dashboard queries so every event card can render the widget state.
 */
export const CRISIS_EVENT_ADJUDICATIONS_SQL =
  `(SELECT COALESCE(jsonb_agg(jsonb_build_object(
       'adjudicator_id', a.adjudicator_id, 'verdict', a.verdict, 'adjudicated_at', a.adjudicated_at
     ) ORDER BY a.adjudicated_at DESC), '[]'::jsonb)
    FROM crisis_event_adjudications a WHERE a.crisis_event_id = ce.event_id) AS adjudications`;
