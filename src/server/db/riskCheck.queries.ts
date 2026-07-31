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
