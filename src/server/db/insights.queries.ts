// Session insights: structured post-session memory summaries + AI-drafted
// SOAP notes (one row per ended session), plus the pre-session check-in stored
// on therapy_sessions. Written by services/sessionInsights.service.ts.
import { pool } from '../config/db.js';

export interface SessionSummary {
  headline?: string;
  topics?: string[];
  mood_trajectory?: string;
  techniques_discussed?: string[];
  techniques_helped?: string[];
  follow_up?: string;
  /** Safety line (ai-therapist-256): one sentence naming any crisis flag,
   *  escalation, crisis resource shown or adverse-event draft from this
   *  session. Empty string / absent means nothing safety-relevant fired.
   *  Never injected into participant-facing memory (see promptContext.ts) —
   *  it is for the researcher/caseworker catch-up read. */
  safety?: string;
  /** True only on the last-resort fallback row (ai-therapist-346): the model
   *  failed twice, so the headline is a placeholder and there is no thematic
   *  content. The safety line and the crisis fields below are still stored. */
  incomplete?: boolean;
  /** Why generation failed, for staff and monitoring. Fallback rows only. */
  incomplete_reason?: string;
  /** Deterministic crisis snapshot from the session row and crisis_events,
   *  stored on the fallback row so a failed summary is never blank about a
   *  crisis. Fallback rows only. */
  crisis_flagged?: boolean;
  peak_severity?: CrisisSeverity | null;
  peak_risk_score?: number | null;
}

export type CrisisSeverity = 'low' | 'medium' | 'high';

/** The worst the session got, whatever the summarizer says (ai-therapist-346). */
export interface SessionRiskPeak {
  /** Flagged now, or flagged at any point during the session. */
  crisis_flagged: boolean;
  peak_severity: CrisisSeverity | null;
  peak_risk_score: number | null;
}

const SEVERITIES: CrisisSeverity[] = ['low', 'medium', 'high'];

/** Peak crisis severity and risk score for one session: the session row's
 *  current flag plus every crisis_events row, so a flag that was later
 *  lowered or cleared still counts. Read-only. */
export async function getSessionRiskPeak(sessionId: string): Promise<SessionRiskPeak> {
  const result = await pool.query<{
    crisis_flagged: boolean | null;
    crisis_severity: string | null;
    crisis_risk_score: number | null;
    ever_flagged: boolean | null;
    max_event_rank: number | null;
    max_event_score: number | null;
  }>(
    `SELECT ts.crisis_flagged, ts.crisis_severity, ts.crisis_risk_score,
            EXISTS (SELECT 1 FROM crisis_events ce WHERE ce.session_id = ts.session_id AND ce.event_type = 'flagged')
              AS ever_flagged,
            (SELECT MAX(CASE ce.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 END)
               FROM crisis_events ce WHERE ce.session_id = ts.session_id) AS max_event_rank,
            (SELECT MAX(ce.risk_score) FROM crisis_events ce WHERE ce.session_id = ts.session_id) AS max_event_score
     FROM therapy_sessions ts
     WHERE ts.session_id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) return { crisis_flagged: false, peak_severity: null, peak_risk_score: null };
  const rowRank = SEVERITIES.indexOf(row.crisis_severity as CrisisSeverity) + 1;
  const rank = Math.max(rowRank, row.max_event_rank ?? 0);
  const scores = [row.crisis_risk_score, row.max_event_score].filter((s): s is number => typeof s === 'number');
  return {
    crisis_flagged: Boolean(row.crisis_flagged) || Boolean(row.ever_flagged),
    peak_severity: rank > 0 ? SEVERITIES[rank - 1] : null,
    peak_risk_score: scores.length > 0 ? Math.max(...scores) : null,
  };
}

export interface SoapNote {
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
}

/** One point of the per-session affect trajectory (ai-therapist-86): the
 *  participant's Nth turn, valence -1..1 (negative..positive), arousal 0..1
 *  (calm..activated), and a single-word non-verbatim label. */
export interface AffectPoint {
  turn: number;
  valence: number;
  arousal: number;
  label?: string;
}

export interface SessionInsightsRow {
  session_id: string;
  user_id: number | null;
  summary: SessionSummary | null;
  soap_note: SoapNote | null;
  affect_curve: AffectPoint[] | null;
  soap_status: 'draft' | 'reviewed';
  soap_reviewed_by: string | null;
  soap_reviewed_at: Date | null;
  model: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function getSessionInsights(sessionId: string): Promise<SessionInsightsRow | null> {
  const result = await pool.query<SessionInsightsRow>('SELECT * FROM session_insights WHERE session_id = $1', [
    sessionId,
  ]);
  return result.rows[0] ?? null;
}

export async function upsertSessionInsights(
  sessionId: string,
  userId: number | null,
  summary: SessionSummary,
  soapNote: SoapNote,
  model: string,
  affectCurve: AffectPoint[] | null = null,
): Promise<void> {
  await pool.query(
    `INSERT INTO session_insights (session_id, user_id, summary, soap_note, model, affect_curve)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (session_id) DO UPDATE
       SET summary = EXCLUDED.summary,
           soap_note = EXCLUDED.soap_note,
           model = EXCLUDED.model,
           affect_curve = EXCLUDED.affect_curve,
           updated_at = CURRENT_TIMESTAMP`,
    [
      sessionId,
      userId,
      JSON.stringify(summary),
      JSON.stringify(soapNote),
      model,
      affectCurve === null ? null : JSON.stringify(affectCurve),
    ],
  );
}

export async function markSoapReviewed(sessionId: string, reviewedBy: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE session_insights
     SET soap_status = 'reviewed', soap_reviewed_by = $2, soap_reviewed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE session_id = $1`,
    [sessionId, reviewedBy],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface UserSummaryRow {
  session_id: string;
  summary: SessionSummary;
  session_name: string | null;
  ended_at: Date | null;
  created_at: Date;
}

/** Most recent memory summaries for a user's ended sessions, newest first. */
export async function getRecentUserSummaries(userId: number, limit = 3): Promise<UserSummaryRow[]> {
  const result = await pool.query<UserSummaryRow>(
    `SELECT si.session_id, si.summary, ts.session_name, ts.ended_at, si.created_at
     FROM session_insights si
     JOIN therapy_sessions ts ON ts.session_id = si.session_id
     WHERE si.user_id = $1 AND si.summary IS NOT NULL AND ts.status = 'ended'
     ORDER BY si.created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}

/** How many sessions this user has completed (for "this is conversation #N"). */
export async function countUserEndedSessions(userId: number): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM therapy_sessions WHERE user_id = $1 AND status = 'ended'`,
    [userId],
  );
  return parseInt(result.rows[0]?.n ?? '0', 10);
}

export interface SessionCheckin {
  mood?: number;
  topic?: string;
  goal?: string;
  submitted_at?: string;
}

export async function setSessionCheckin(sessionId: string, checkin: SessionCheckin): Promise<void> {
  await pool.query('UPDATE therapy_sessions SET checkin = $2 WHERE session_id = $1', [
    sessionId,
    JSON.stringify(checkin),
  ]);
}

/** Participant's memory-consent flag. */
export async function getUserMemoryEnabled(userId: number): Promise<boolean> {
  const result = await pool.query<{ memory_enabled: boolean }>('SELECT memory_enabled FROM users WHERE userid = $1', [
    userId,
  ]);
  return result.rows[0]?.memory_enabled ?? false;
}

export async function setUserMemoryEnabled(userId: number, enabled: boolean): Promise<void> {
  await pool.query('UPDATE users SET memory_enabled = $2, updated_at = CURRENT_TIMESTAMP WHERE userid = $1', [
    userId,
    enabled,
  ]);
}

// ---------- Therapist-in-the-loop notes (ai-therapist-50) ----------

/** Free-text guidance a therapist leaves, from the SOAP review workflow, for the participant's NEXT session. */
export async function setSessionNotesForNextSession(
  sessionId: string,
  notes: string,
  author: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE session_insights
     SET notes_for_next_session = $2, notes_author = $3, notes_created_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE session_id = $1`,
    [sessionId, notes, author],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface ClinicianNote {
  notes: string;
  author: string | null;
  created_at: Date;
  session_id: string;
}

/** The most recent clinician note left on any of this user's sessions (for injection into their next one). */
export async function getLatestClinicianNote(userId: number): Promise<ClinicianNote | null> {
  const result = await pool.query<{
    session_id: string;
    notes_for_next_session: string;
    notes_author: string | null;
    notes_created_at: Date;
  }>(
    `SELECT session_id, notes_for_next_session, notes_author, notes_created_at
     FROM session_insights
     WHERE user_id = $1 AND notes_for_next_session IS NOT NULL AND notes_for_next_session != ''
     ORDER BY notes_created_at DESC
     LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  return row
    ? {
        notes: row.notes_for_next_session,
        author: row.notes_author,
        created_at: row.notes_created_at,
        session_id: row.session_id,
      }
    : null;
}
