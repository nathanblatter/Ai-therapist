// Data access for the shadow risk scorer (ai-therapist-83, migration 133):
// the one insert the scorer makes per turn, and the researcher read behind
// the "Shadow scorer" panel.
//
// The read is scoped like the risk calibration report it sits beside
// (SESSION_SCOPE from irbPacket.queries.ts: demo and sandbox sessions
// excluded, a session in scope when its owner belongs to the caller's
// organisation, unattributed sessions only for the irb-study organisation).
// It returns counts, band names, probabilities and row ids: no message text
// exists in this table to return.
import { pool } from '../config/db.js';
import { SESSION_SCOPE, irbWindowParams, type IrbWindow } from './irbPacket.queries.js';
import type { RiskSeverity } from '../../shared/riskBands.js';

export type ShadowScoreStatus = 'scored' | 'errored';

export interface ShadowRiskScoreInsert {
  sessionId: string;
  messageId: number | null;
  turnSource: 'message' | 'checkin';
  productionScore: number;
  productionSeverity: RiskSeverity;
  status: ShadowScoreStatus;
  shadowSeverity: RiskSeverity | null;
  severityProbabilities: Record<RiskSeverity, number> | null;
  predicates: Record<string, number> | null;
  refusedQuestions: string[];
  /** Fixed vocabulary (see the service's errorCodeFor); null when scored. */
  errorCode: string | null;
  model: string;
  questionSetVersion: number;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
}

/**
 * May this session's turns be shadow-scored? Not a demo session and not a
 * sandbox account's session: the report excludes both (SESSION_SCOPE), so a
 * call for them would be paid for and never read. A session with no row yet
 * (the row is written as the session starts) is not in scope for this turn.
 */
export async function shadowSessionInScope(sessionId: string): Promise<boolean> {
  const result = await pool.query<{ in_scope: boolean }>(
    `SELECT (ts.is_demo IS NOT TRUE
             AND NOT EXISTS (SELECT 1 FROM users su WHERE su.userid = ts.user_id AND su.is_sandbox IS TRUE)) AS in_scope
       FROM therapy_sessions ts
      WHERE ts.session_id = $1`,
    [sessionId],
  );
  return result.rows[0]?.in_scope === true;
}

export async function insertShadowRiskScore(row: ShadowRiskScoreInsert): Promise<void> {
  await pool.query(
    `INSERT INTO shadow_risk_scores
       (session_id, message_id, turn_source, production_score, production_severity, status, shadow_severity,
        severity_probabilities, predicates, refused_questions, error_code, model, question_set_version,
        tokens_in, tokens_out, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::text[], $11, $12, $13, $14, $15, $16)`,
    [
      row.sessionId,
      row.messageId,
      row.turnSource,
      row.productionScore,
      row.productionSeverity,
      row.status,
      row.shadowSeverity,
      row.severityProbabilities ? JSON.stringify(row.severityProbabilities) : null,
      row.predicates ? JSON.stringify(row.predicates) : null,
      row.refusedQuestions,
      row.errorCode,
      row.model,
      row.questionSetVersion,
      row.tokensIn,
      row.tokensOut,
      row.latencyMs,
    ],
  );
}

const SEVERITIES: RiskSeverity[] = ['none', 'low', 'medium', 'high'];
const isSeverity = (v: unknown): v is RiskSeverity => SEVERITIES.includes(v as RiskSeverity);
const int = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

export interface ShadowDisagreement {
  shadow_id: number;
  session_id: string;
  message_id: number | null;
  turn_source: string;
  created_at: string;
  production_score: number;
  production_severity: RiskSeverity;
  shadow_severity: RiskSeverity;
  /** P(high) from the severity question, 0..1. */
  p_high: number | null;
  /** Probability per yes/no question. */
  predicates: Record<string, number>;
}

export interface ShadowRiskReport {
  window: { from: string; to: string };
  counts: {
    total: number;
    scored: number;
    errored: number;
    /** Errored rows by error_code. */
    errors: Record<string, number>;
    /** Errored rows on turns production scored medium or high. */
    errored_on_flagged: number;
    agree: number;
    shadow_higher: number;
    shadow_lower: number;
    mean_latency_ms: number | null;
    tokens_in: number;
  };
  /** agreement[production][shadow]: scored rows only. */
  agreement: Record<RiskSeverity, Record<RiskSeverity, number>>;
  /** Scored rows where the two severities differ, newest first. */
  disagreements: ShadowDisagreement[];
  disagreements_truncated: boolean;
}

export const SHADOW_DISAGREEMENT_LIMIT = 200;

const FROM_SCOPED = `FROM shadow_risk_scores s
       JOIN therapy_sessions ts ON ts.session_id = s.session_id
      WHERE ${SESSION_SCOPE}
        AND s.created_at >= $1::timestamptz AND s.created_at <= $2::timestamptz`;

const RANK = `array_position(ARRAY['none','low','medium','high']::varchar[], `;

export async function getShadowRiskReport(w: IrbWindow): Promise<ShadowRiskReport> {
  const params = irbWindowParams(w);
  const [cells, errors, totals, list] = await Promise.all([
    pool.query<{ production_severity: string; shadow_severity: string; n: string }>(
      `SELECT s.production_severity, s.shadow_severity, COUNT(*) AS n
         ${FROM_SCOPED} AND s.status = 'scored'
        GROUP BY 1, 2`,
      params,
    ),
    pool.query<{ error_code: string | null; n: string; on_flagged: string }>(
      `SELECT s.error_code, COUNT(*) AS n,
              COUNT(*) FILTER (WHERE s.production_severity IN ('medium', 'high')) AS on_flagged
         ${FROM_SCOPED} AND s.status = 'errored'
        GROUP BY 1`,
      params,
    ),
    pool.query<{ total: string; mean_latency_ms: string | null; tokens_in: string | null }>(
      `SELECT COUNT(*) AS total, ROUND(AVG(s.latency_ms)) AS mean_latency_ms, SUM(s.tokens_in) AS tokens_in
         ${FROM_SCOPED}`,
      params,
    ),
    pool.query<{
      shadow_id: string;
      session_id: string;
      message_id: string | null;
      turn_source: string;
      created_at: Date;
      production_score: number;
      production_severity: string;
      shadow_severity: string;
      p_high: string | null;
      predicates: Record<string, number> | null;
    }>(
      `SELECT s.shadow_id, s.session_id, s.message_id, s.turn_source, s.created_at, s.production_score,
              s.production_severity, s.shadow_severity, s.severity_probabilities->>'high' AS p_high, s.predicates
         ${FROM_SCOPED} AND s.status = 'scored' AND s.shadow_severity <> s.production_severity
        ORDER BY ABS(${RANK}s.shadow_severity) - ${RANK}s.production_severity)) DESC, s.created_at DESC
        LIMIT ${SHADOW_DISAGREEMENT_LIMIT + 1}`,
      params,
    ),
  ]);

  const agreement = Object.fromEntries(
    SEVERITIES.map((p) => [p, Object.fromEntries(SEVERITIES.map((s) => [s, 0]))]),
  ) as ShadowRiskReport['agreement'];
  let scored = 0;
  let agree = 0;
  let higher = 0;
  let lower = 0;
  for (const c of cells.rows) {
    if (!isSeverity(c.production_severity) || !isSeverity(c.shadow_severity)) continue;
    const n = int(c.n);
    agreement[c.production_severity][c.shadow_severity] += n;
    scored += n;
    const d = SEVERITIES.indexOf(c.shadow_severity) - SEVERITIES.indexOf(c.production_severity);
    if (d === 0) agree += n;
    else if (d > 0) higher += n;
    else lower += n;
  }
  const errorCounts: Record<string, number> = {};
  let errored = 0;
  let erroredOnFlagged = 0;
  for (const e of errors.rows) {
    errorCounts[e.error_code ?? 'error'] = int(e.n);
    errored += int(e.n);
    erroredOnFlagged += int(e.on_flagged);
  }
  const t = totals.rows[0];
  const rows = list.rows.slice(0, SHADOW_DISAGREEMENT_LIMIT);
  return {
    window: { from: w.from, to: w.to },
    counts: {
      total: int(t?.total),
      scored,
      errored,
      errors: errorCounts,
      errored_on_flagged: erroredOnFlagged,
      agree,
      shadow_higher: higher,
      shadow_lower: lower,
      mean_latency_ms: t?.mean_latency_ms == null ? null : int(t.mean_latency_ms),
      tokens_in: int(t?.tokens_in),
    },
    agreement,
    disagreements: rows
      .filter((r) => isSeverity(r.production_severity) && isSeverity(r.shadow_severity))
      .map((r) => ({
        shadow_id: int(r.shadow_id),
        session_id: r.session_id,
        message_id: r.message_id === null ? null : int(r.message_id),
        turn_source: r.turn_source,
        created_at: new Date(r.created_at).toISOString(),
        production_score: int(r.production_score),
        production_severity: r.production_severity as RiskSeverity,
        shadow_severity: r.shadow_severity as RiskSeverity,
        p_high: r.p_high === null ? null : Number(r.p_high),
        predicates: r.predicates ?? {},
      })),
    disagreements_truncated: list.rows.length > SHADOW_DISAGREEMENT_LIMIT,
  };
}
