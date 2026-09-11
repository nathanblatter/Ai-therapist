// Storage for counterfactual backend-model comparisons (migration 101).

import { pool } from '../config/db.js';

export type CounterfactualMode = 'replay' | 'fork';

export interface CounterfactualRunRow {
  id: number;
  session_id: string;
  mode: CounterfactualMode;
  decision_point: number | null;
  probe_text: string | null;
  probe_reason: string | null;
  baseline_model: string | null;
  status: 'running' | 'completed' | 'failed';
  error: string | null;
  created_by: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface CounterfactualResponseRow {
  id: number;
  run_id: number;
  model: string;
  response_text: string | null;
  spoken_text: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  estimated_cost_usd: number | null;
  latency_ms: number | null;
  judge_scores: Record<string, number> | null;
  judge_rationale: string | null;
  error: string | null;
}

export async function createCounterfactualRun(input: {
  sessionId: string;
  mode: CounterfactualMode;
  decisionPoint: number | null;
  probeText: string | null;
  probeReason: string | null;
  baselineModel: string | null;
  createdBy: string | null;
}): Promise<CounterfactualRunRow> {
  const result = await pool.query<CounterfactualRunRow>(
    `INSERT INTO counterfactual_runs
       (session_id, mode, decision_point, probe_text, probe_reason, baseline_model, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.sessionId, input.mode, input.decisionPoint, input.probeText,
      input.probeReason, input.baselineModel, input.createdBy,
    ],
  );
  return result.rows[0];
}

export async function recordCounterfactualResponse(input: {
  runId: number;
  model: string;
  responseText?: string | null;
  spokenText?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  estimatedCostUsd?: number | null;
  latencyMs?: number | null;
  error?: string | null;
}): Promise<void> {
  // ON CONFLICT so a re-run of a single candidate overwrites rather than
  // failing the whole sweep on the (run_id, model) unique constraint.
  await pool.query(
    `INSERT INTO counterfactual_responses
       (run_id, model, response_text, spoken_text, tokens_in, tokens_out,
        estimated_cost_usd, latency_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (run_id, model) DO UPDATE SET
       response_text = EXCLUDED.response_text,
       spoken_text = EXCLUDED.spoken_text,
       tokens_in = EXCLUDED.tokens_in,
       tokens_out = EXCLUDED.tokens_out,
       estimated_cost_usd = EXCLUDED.estimated_cost_usd,
       latency_ms = EXCLUDED.latency_ms,
       error = EXCLUDED.error`,
    [
      input.runId, input.model, input.responseText ?? null, input.spokenText ?? null,
      input.tokensIn ?? null, input.tokensOut ?? null, input.estimatedCostUsd ?? null,
      input.latencyMs ?? null, input.error ?? null,
    ],
  );
}

export async function recordCounterfactualJudgement(
  runId: number,
  model: string,
  scores: Record<string, number>,
  rationale: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE counterfactual_responses
        SET judge_scores = $3::jsonb, judge_rationale = $4
      WHERE run_id = $1 AND model = $2`,
    [runId, model, JSON.stringify(scores), rationale],
  );
}

export async function finishCounterfactualRun(
  runId: number,
  status: 'completed' | 'failed',
  error?: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE counterfactual_runs
        SET status = $2, error = $3, completed_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [runId, status, error ?? null],
  );
}

export async function getCounterfactualRun(
  runId: number,
): Promise<{ run: CounterfactualRunRow; responses: CounterfactualResponseRow[] } | null> {
  const runResult = await pool.query<CounterfactualRunRow>(
    'SELECT * FROM counterfactual_runs WHERE id = $1', [runId],
  );
  const run = runResult.rows[0];
  if (!run) return null;

  const responses = await pool.query<CounterfactualResponseRow>(
    `SELECT id, run_id, model, response_text, spoken_text, tokens_in, tokens_out,
            estimated_cost_usd::float8 AS estimated_cost_usd, latency_ms,
            judge_scores, judge_rationale, error
       FROM counterfactual_responses
      WHERE run_id = $1
      ORDER BY model`,
    [runId],
  );
  return { run, responses: responses.rows };
}

export async function listCounterfactualRuns(limit = 50): Promise<CounterfactualRunRow[]> {
  const result = await pool.query<CounterfactualRunRow>(
    'SELECT * FROM counterfactual_runs ORDER BY created_at DESC LIMIT $1', [limit],
  );
  return result.rows;
}
