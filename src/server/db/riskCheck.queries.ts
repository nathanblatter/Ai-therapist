// Structured C-SSRS-style laddered risk-assessment logging (ai-therapist-71).
// Backs the run_risk_check tool: complements (does not replace) the automatic
// crisis_events pipeline in crisisDetection.service.ts.
import { pool } from '../config/db.js';

export type RiskCheckStep = 'ideation' | 'plan' | 'means' | 'timeframe' | 'intent' | 'protective_factors';
export type RiskBand = 'none' | 'low' | 'moderate' | 'high' | 'imminent';

export interface RiskCheckStepInput {
  sessionId: string;
  crisisEventId: number | null;
  step: RiskCheckStep;
  answer: string;
  riskBand: RiskBand;
  sequence: number;
}

export interface RiskCheckStepRow {
  check_step_id: number;
  session_id: string;
  crisis_event_id: number | null;
  step: RiskCheckStep;
  answer: string;
  risk_band: RiskBand;
  sequence: number;
  created_at: Date;
}

export async function insertRiskCheckStep(input: RiskCheckStepInput): Promise<number> {
  const result = await pool.query<{ check_step_id: number }>(
    `INSERT INTO risk_check_steps (session_id, crisis_event_id, step, answer, risk_band, sequence)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING check_step_id`,
    [input.sessionId, input.crisisEventId, input.step, input.answer, input.riskBand, input.sequence],
  );
  return result.rows[0].check_step_id;
}

/** All steps logged for a session, in ladder order — used to compute the next expected step/sequence. */
export async function getRiskCheckSteps(sessionId: string): Promise<RiskCheckStepRow[]> {
  const result = await pool.query<RiskCheckStepRow>(
    `SELECT check_step_id, session_id, crisis_event_id, step, answer, risk_band, sequence, created_at
     FROM risk_check_steps WHERE session_id = $1 ORDER BY created_at ASC`,
    [sessionId],
  );
  return result.rows;
}

/** Most recent open crisis event for a session, to link a risk-check pass to it. */
export async function getLatestCrisisEventId(sessionId: string): Promise<number | null> {
  const result = await pool.query<{ event_id: number }>(
    `SELECT event_id FROM crisis_events WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );
  return result.rows[0]?.event_id ?? null;
}

// ============================================================================
// READ SURFACE (ai-therapist-198)
// ============================================================================
// Until now the ladder was effectively write-only: rows went in from the tool
// and only ever came back out buried inside an adverse-event draft's timeline.
// These reads back the admin risk-check panels (session + participant) and the
// deterministic "no ladder ran yet" trigger in the crisis pipeline.

/** Cheap existence probe — does this session already have ANY ladder step?
 *  Runs per risky turn from the pipeline trigger, so it stays index-only. */
export async function sessionHasRiskCheck(sessionId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM risk_check_steps WHERE session_id = $1 LIMIT 1',
    [sessionId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Core ladder order. protective_factors is a counterweight step and is
 *  deliberately excluded — it is not a rung, so it never counts as depth. */
export const RISK_CHECK_LADDER_ORDER: readonly RiskCheckStep[] = [
  'ideation', 'plan', 'means', 'timeframe', 'intent',
] as const;

const BAND_RANK: Record<RiskBand, number> = { none: 0, low: 1, moderate: 2, high: 3, imminent: 4 };

export interface RiskCheckLadder {
  session_id: string;
  steps: RiskCheckStepRow[];
  /** Highest band reached across the pass — the clinically meaningful read. */
  resolved_band: RiskBand | null;
  /** Deepest core rung actually asked. */
  furthest_step: RiskCheckStep | null;
  /** Complete once `intent`, the terminal rung, has been logged. */
  completed: boolean;
  started_at: string | null;
  last_step_at: string | null;
}

const toIso = (value: Date | string | undefined): string | null => {
  if (value === undefined || value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};

/** Fold raw step rows (ascending by created_at) into the admin panel shape. */
export function summarizeRiskCheckSteps(sessionId: string, steps: RiskCheckStepRow[]): RiskCheckLadder {
  let resolved: RiskBand | null = null;
  let furthest: RiskCheckStep | null = null;
  for (const step of steps) {
    if (resolved === null || BAND_RANK[step.risk_band] > BAND_RANK[resolved]) resolved = step.risk_band;
    const idx = RISK_CHECK_LADDER_ORDER.indexOf(step.step);
    if (idx >= 0 && (furthest === null || idx > RISK_CHECK_LADDER_ORDER.indexOf(furthest))) furthest = step.step;
  }
  return {
    session_id: sessionId,
    steps,
    resolved_band: resolved,
    furthest_step: furthest,
    completed: steps.some(s => s.step === 'intent'),
    started_at: toIso(steps[0]?.created_at),
    last_step_at: toIso(steps[steps.length - 1]?.created_at),
  };
}

/** One session's ladder, already summarized (admin session panel). */
export async function getSessionRiskCheckLadder(sessionId: string): Promise<RiskCheckLadder> {
  return summarizeRiskCheckSteps(sessionId, await getRiskCheckSteps(sessionId));
}

/** Every ladder this participant has, newest last-step first (profile panel).
 *  Joined through therapy_sessions so ownership is enforced in SQL rather than
 *  by the caller passing session ids it happens to know. */
export async function getParticipantRiskCheckLadders(
  userId: number,
  limit = 20,
): Promise<RiskCheckLadder[]> {
  const result = await pool.query<RiskCheckStepRow>(
    `SELECT rcs.check_step_id, rcs.session_id, rcs.crisis_event_id, rcs.step, rcs.answer,
            rcs.risk_band, rcs.sequence, rcs.created_at
     FROM risk_check_steps rcs
     JOIN therapy_sessions ts ON ts.session_id = rcs.session_id
     WHERE ts.user_id = $1
     ORDER BY rcs.created_at ASC`,
    [userId],
  );

  const bySession = new Map<string, RiskCheckStepRow[]>();
  for (const row of result.rows) {
    const bucket = bySession.get(row.session_id);
    if (bucket) bucket.push(row);
    else bySession.set(row.session_id, [row]);
  }

  return [...bySession.entries()]
    .map(([sessionId, steps]) => summarizeRiskCheckSteps(sessionId, steps))
    .sort((a, b) => (b.last_step_at ?? '').localeCompare(a.last_step_at ?? ''))
    .slice(0, limit);
}
