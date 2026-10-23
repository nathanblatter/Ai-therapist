// Data-access for the risk-score calibration harness (eval program WP3,
// ai-therapist-175, gap G3). Three concerns:
//
//   1. the labelled sample: every risk_score_history row in the window joined
//      to the crisis event it raised (if any) and that event's adjudication
//      verdicts - the signal layers come out of score_factors, the label out
//      of crisis_event_adjudications (migration 114);
//   2. the miss-rate sample: unflagged participant messages (never raised an
//      event, scored below the steering band or never scored) plus the
//      redacted context needed to re-score one offline. ONLY content_redacted
//      is ever selected here - raw `content` is not readable for analysis;
//   3. the risk_calibration_runs archive (migration 116).
//
// Scope is the IRB packet's (SESSION_SCOPE from irbPacket.queries.ts: demo +
// sandbox excluded, participant rows in scope when the user belongs to the
// caller's org, unattributed rows only for the irb-study org).
import { pool } from '../config/db.js';
import { SESSION_SCOPE, irbWindowParams, type IrbWindow } from './irbPacket.queries.js';
import type { AdjudicationVerdict } from './crisisAdjudications.queries.js';

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};
const int = (v: unknown): number => num(v) ?? 0;

// ---------------------------------------------------------------------------
// Labelled sample
// ---------------------------------------------------------------------------

/** One scored participant message with its signal layers and, when it raised
 *  a crisis event, that event's verdicts. No text, no identifiers. */
export interface ScoredMessageRow {
  history_id: number;
  message_id: number | null;
  /** Composite score the pipeline acted on. */
  risk_score: number;
  method: string | null;
  keyword_score: number;
  llm_score: number | null;
  /** Raw omni-moderation category probabilities, 0..1. */
  moderation_self_harm: number | null;
  moderation_self_harm_intent: number | null;
  moderation_self_harm_instructions: number | null;
  /** Pipeline's 0..100 composite of the three categories. */
  moderation_score: number | null;
  /** Trajectory bonus applied (0..20). */
  trajectory_score: number;
  crisis_event_id: number | null;
  /** Every adjudicator's verdict on the event (empty when none / no event). */
  verdicts: AdjudicationVerdict[];
}

/**
 * All risk_score_history rows for sessions in scope whose calculated_at falls
 * in the window. The crisis event is matched on message_id (the pipeline
 * writes the flag with the message that tripped it); manual flags and
 * unflag events carry no message_id and so never attach here.
 */
export async function getScoredMessages(w: IrbWindow): Promise<ScoredMessageRow[]> {
  const r = await pool.query<{
    history_id: string;
    message_id: string | null;
    risk_score: number;
    method: string | null;
    keyword_score: string | null;
    llm_score: string | null;
    moderation_self_harm: string | null;
    moderation_self_harm_intent: string | null;
    moderation_self_harm_instructions: string | null;
    moderation_score: string | null;
    trajectory_score: string | null;
    crisis_event_id: string | null;
    verdicts: string[] | null;
  }>(
    `SELECT r.history_id, r.message_id, r.risk_score,
            r.score_factors->>'method' AS method,
            r.score_factors->>'keyword_score' AS keyword_score,
            r.score_factors->>'llm_score' AS llm_score,
            r.score_factors->>'moderation_self_harm' AS moderation_self_harm,
            r.score_factors->>'moderation_self_harm_intent' AS moderation_self_harm_intent,
            r.score_factors->>'moderation_self_harm_instructions' AS moderation_self_harm_instructions,
            r.score_factors->>'moderation_score' AS moderation_score,
            r.score_factors->>'trajectory_score' AS trajectory_score,
            ce.event_id AS crisis_event_id,
            (SELECT array_agg(a.verdict ORDER BY a.adjudicated_at)
               FROM crisis_event_adjudications a WHERE a.crisis_event_id = ce.event_id) AS verdicts
       FROM risk_score_history r
       JOIN therapy_sessions ts ON ts.session_id = r.session_id
       LEFT JOIN LATERAL (
         SELECT e.event_id FROM crisis_events e
          WHERE e.message_id = r.message_id AND e.event_type = 'flagged'
            AND e.origin = 'session' AND r.message_id IS NOT NULL
          ORDER BY e.created_at DESC LIMIT 1
       ) ce ON TRUE
      WHERE ${SESSION_SCOPE}
        AND r.calculated_at >= $1::timestamptz AND r.calculated_at <= $2::timestamptz
      ORDER BY r.history_id`,
    irbWindowParams(w),
  );
  return r.rows.map((x) => ({
    history_id: int(x.history_id),
    message_id: x.message_id === null ? null : int(x.message_id),
    risk_score: int(x.risk_score),
    method: x.method,
    keyword_score: int(x.keyword_score),
    llm_score: num(x.llm_score),
    moderation_self_harm: num(x.moderation_self_harm),
    moderation_self_harm_intent: num(x.moderation_self_harm_intent),
    moderation_self_harm_instructions: num(x.moderation_self_harm_instructions),
    moderation_score: num(x.moderation_score),
    trajectory_score: int(x.trajectory_score),
    crisis_event_id: x.crisis_event_id === null ? null : int(x.crisis_event_id),
    verdicts: (x.verdicts ?? []).filter(
      (v): v is AdjudicationVerdict => v === 'confirmed' || v === 'false_positive' || v === 'unclear',
    ),
  }));
}

/** Adjudication coverage over every session-origin flag in the window
 *  (including flags with no risk_score_history match), so the report can
 *  state how much of the ground truth exists at all. */
export interface AdjudicationCoverage {
  flagged_events: number;
  adjudicated_events: number;
  confirmed: number;
  false_positive: number;
  unclear: number;
  /** Events whose adjudicators disagree (counted under unclear above). */
  disputed: number;
}

export async function getAdjudicationCoverage(w: IrbWindow): Promise<AdjudicationCoverage> {
  const r = await pool.query<Record<string, string>>(
    `WITH ev AS (
       SELECT ce.event_id,
              (SELECT array_agg(DISTINCT a.verdict) FROM crisis_event_adjudications a
                WHERE a.crisis_event_id = ce.event_id) AS verdicts
         FROM crisis_events ce JOIN therapy_sessions ts ON ts.session_id = ce.session_id
        WHERE ${SESSION_SCOPE} AND ce.event_type = 'flagged' AND ce.origin = 'session'
          AND ce.created_at >= $1::timestamptz AND ce.created_at <= $2::timestamptz
     )
     SELECT COUNT(*) AS flagged_events,
            COUNT(*) FILTER (WHERE verdicts IS NOT NULL) AS adjudicated_events,
            COUNT(*) FILTER (WHERE verdicts = ARRAY['confirmed']) AS confirmed,
            COUNT(*) FILTER (WHERE verdicts = ARRAY['false_positive']) AS false_positive,
            COUNT(*) FILTER (WHERE verdicts IS NOT NULL
                               AND verdicts <> ARRAY['confirmed'] AND verdicts <> ARRAY['false_positive']) AS unclear,
            COUNT(*) FILTER (WHERE verdicts IS NOT NULL AND array_length(verdicts, 1) > 1) AS disputed
       FROM ev`,
    irbWindowParams(w),
  );
  const row = r.rows[0] ?? {};
  return {
    flagged_events: int(row.flagged_events),
    adjudicated_events: int(row.adjudicated_events),
    confirmed: int(row.confirmed),
    false_positive: int(row.false_positive),
    unclear: int(row.unclear),
    disputed: int(row.disputed),
  };
}

// ---------------------------------------------------------------------------
// Miss-rate sample: unflagged participant messages
// ---------------------------------------------------------------------------

export interface UnflaggedCandidate {
  message_id: number;
  session_id: string;
  /** Stratum key: `<session_type>|<scored|unscored>`. */
  stratum: string;
}

/** Composite score below which a scored message counts as unflagged
 *  (the steering band starts at 25). */
export const UNFLAGGED_MAX_SCORE = 24;

/**
 * Participant messages in scope that never raised a crisis event and either
 * were never scored or scored at most UNFLAGGED_MAX_SCORE. Ordered by
 * message_id so the seeded sampler is deterministic for a fixed window.
 */
export async function getUnflaggedCandidates(w: IrbWindow): Promise<UnflaggedCandidate[]> {
  const r = await pool.query<{ message_id: string; session_id: string; stratum: string }>(
    `SELECT m.message_id, m.session_id,
            COALESCE(ts.session_type, 'unknown') || '|' ||
              CASE WHEN EXISTS (SELECT 1 FROM risk_score_history r WHERE r.message_id = m.message_id)
                   THEN 'scored' ELSE 'unscored' END AS stratum
       FROM messages m
       JOIN therapy_sessions ts ON ts.session_id = m.session_id
      WHERE ${SESSION_SCOPE}
        AND m.role = 'user'
        AND m.content_redacted IS NOT NULL AND length(btrim(m.content_redacted)) > 0
        AND m.created_at >= $1::timestamptz AND m.created_at <= $2::timestamptz
        AND NOT EXISTS (SELECT 1 FROM crisis_events ce WHERE ce.message_id = m.message_id)
        AND NOT EXISTS (SELECT 1 FROM risk_score_history r
                         WHERE r.message_id = m.message_id AND r.risk_score > $5::int)
      ORDER BY m.message_id`,
    [...irbWindowParams(w), UNFLAGGED_MAX_SCORE],
  );
  return r.rows.map((x) => ({ message_id: int(x.message_id), session_id: x.session_id, stratum: x.stratum }));
}

export interface RedactedTurn {
  role: 'user' | 'assistant';
  content_redacted: string;
}

/**
 * The redacted message plus up to `contextTurns` preceding participant /
 * assistant turns from the same session, oldest first. Reads content_redacted
 * ONLY. Returns null when the message has no redacted text.
 */
export async function getRedactedMessageContext(
  messageId: number,
  contextTurns = 10,
): Promise<{ latest: string; history: RedactedTurn[] } | null> {
  const r = await pool.query<{ message_id: string; role: string; content_redacted: string | null }>(
    `WITH target AS (
       SELECT message_id, session_id, created_at FROM messages WHERE message_id = $1
     )
     SELECT m.message_id, m.role, m.content_redacted
       FROM messages m, target t
      WHERE m.session_id = t.session_id AND m.role IN ('user', 'assistant')
        AND (m.created_at < t.created_at OR m.message_id = t.message_id)
      ORDER BY m.created_at DESC, m.message_id DESC
      LIMIT $2`,
    [messageId, Math.max(1, contextTurns) + 1],
  );
  const rows = r.rows.reverse();
  const target = rows.find((x) => int(x.message_id) === messageId);
  if (!target?.content_redacted?.trim()) return null;
  const history = rows
    .filter((x) => int(x.message_id) !== messageId && x.content_redacted?.trim())
    .map((x) => ({ role: x.role as 'user' | 'assistant', content_redacted: x.content_redacted as string }));
  return { latest: target.content_redacted, history };
}

// ---------------------------------------------------------------------------
// risk_calibration_runs archive (migration 116)
// ---------------------------------------------------------------------------

export interface RiskCalibrationRunRow {
  run_id: number;
  org_id: number;
  started_at: Date;
  finished_at: Date | null;
  params: Record<string, unknown>;
  report: Record<string, unknown>;
  recommended_thresholds: Record<string, unknown>;
  created_by: string;
}

export type RiskCalibrationRunSummary = Omit<RiskCalibrationRunRow, 'report' | 'params'> & {
  /** A few headline fields lifted out of the report for the list view. */
  insufficient_labels: boolean;
  scored_messages: number;
  positives: number;
  negatives: number;
};

export async function insertRiskCalibrationRun(input: {
  orgId: number;
  startedAt: string;
  finishedAt: string;
  params: Record<string, unknown>;
  report: Record<string, unknown>;
  recommendedThresholds: Record<string, unknown>;
  createdBy: string;
}): Promise<RiskCalibrationRunRow> {
  const r = await pool.query<RiskCalibrationRunRow>(
    `INSERT INTO risk_calibration_runs
       (org_id, started_at, finished_at, params, report, recommended_thresholds, created_by)
     VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7)
     RETURNING run_id, org_id, started_at, finished_at, params, report, recommended_thresholds, created_by`,
    [
      input.orgId,
      input.startedAt,
      input.finishedAt,
      JSON.stringify(input.params),
      JSON.stringify(input.report),
      JSON.stringify(input.recommendedThresholds),
      input.createdBy,
    ],
  );
  return r.rows[0];
}

/** Newest first, one org. */
export async function listRiskCalibrationRuns(orgId: number, limit = 20): Promise<RiskCalibrationRunSummary[]> {
  const r = await pool.query<RiskCalibrationRunSummary & { insufficient_labels: boolean | null }>(
    `SELECT run_id, org_id, started_at, finished_at, recommended_thresholds, created_by,
            COALESCE((report->'labels'->>'insufficient_labels')::boolean, TRUE) AS insufficient_labels,
            COALESCE((report->'labels'->>'scored_messages')::int, 0) AS scored_messages,
            COALESCE((report->'labels'->>'positives')::int, 0) AS positives,
            COALESCE((report->'labels'->>'negatives')::int, 0) AS negatives
       FROM risk_calibration_runs WHERE org_id = $1
      ORDER BY started_at DESC, run_id DESC
      LIMIT $2`,
    [orgId, Math.min(Math.max(1, limit), 200)],
  );
  return r.rows.map((x) => ({ ...x, insufficient_labels: x.insufficient_labels !== false }));
}

/** One run, only when it belongs to the org (cross-org ids read as absent). */
export async function getRiskCalibrationRun(runId: number, orgId: number): Promise<RiskCalibrationRunRow | null> {
  const r = await pool.query<RiskCalibrationRunRow>(
    `SELECT run_id, org_id, started_at, finished_at, params, report, recommended_thresholds, created_by
       FROM risk_calibration_runs WHERE run_id = $1 AND org_id = $2`,
    [runId, orgId],
  );
  return r.rows[0] ?? null;
}
