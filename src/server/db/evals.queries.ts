// Session eval rows: LLM-judge therapist-quality scores, one row per
// (session, prompt_version). Written by services/sessionEval.service.ts.
import { pool } from '../config/db.js';

/** One rubric dimension's result. */
export interface EvalDimension {
  score: number; // 1-5
  rationale: string;
}

/** Keyed by dimension id — see EVAL_DIMENSIONS in sessionEval.service.ts. */
export type EvalRubric = Record<string, EvalDimension>;

export interface SessionEvalRow {
  eval_id: number;
  session_id: string;
  rubric: EvalRubric;
  overall_comments: string | null;
  judge_model: string;
  prompt_version: string;
  created_at: Date;
}

/** Latest eval for a session (any prompt version), or null. */
export async function getSessionEval(sessionId: string): Promise<SessionEvalRow | null> {
  const result = await pool.query<SessionEvalRow>(
    `SELECT * FROM session_evals
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] ?? null;
}

/** Whether a session already has an eval for the given prompt version. */
export async function hasSessionEval(sessionId: string, promptVersion: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM session_evals WHERE session_id = $1 AND prompt_version = $2',
    [sessionId, promptVersion]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Insert (or replace, for re-runs with --force) an eval row. */
export async function upsertSessionEval(
  sessionId: string,
  rubric: EvalRubric,
  overallComments: string | null,
  judgeModel: string,
  promptVersion: string
): Promise<SessionEvalRow> {
  const result = await pool.query<SessionEvalRow>(
    `INSERT INTO session_evals (session_id, rubric, overall_comments, judge_model, prompt_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id, prompt_version) DO UPDATE
       SET rubric = EXCLUDED.rubric,
           overall_comments = EXCLUDED.overall_comments,
           judge_model = EXCLUDED.judge_model,
           created_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [sessionId, JSON.stringify(rubric), overallComments, judgeModel, promptVersion]
  );
  return result.rows[0];
}

/** Ended sessions that have no eval for the given prompt version yet. */
export async function getUnevaluatedEndedSessions(promptVersion: string, limit = 500): Promise<string[]> {
  const result = await pool.query<{ session_id: string }>(
    `SELECT ts.session_id
     FROM therapy_sessions ts
     LEFT JOIN session_evals se
       ON se.session_id = ts.session_id AND se.prompt_version = $1
     WHERE ts.status = 'ended' AND se.eval_id IS NULL
     ORDER BY ts.created_at DESC
     LIMIT $2`,
    [promptVersion, limit]
  );
  return result.rows.map(r => r.session_id);
}
