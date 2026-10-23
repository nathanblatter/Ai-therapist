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
  /** Per-dimension max-min score across the judge runs behind this consensus
   *  row (migration 107); null for single-judge rows. */
  judge_spread?: Record<string, number> | null;
}

/** Latest eval for a session (any prompt version), or null. */
export async function getSessionEval(sessionId: string): Promise<SessionEvalRow | null> {
  const result = await pool.query<SessionEvalRow>(
    `SELECT * FROM session_evals
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

/** Whether a session already has an eval for the given prompt version. */
export async function hasSessionEval(sessionId: string, promptVersion: string): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM session_evals WHERE session_id = $1 AND prompt_version = $2', [
    sessionId,
    promptVersion,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/** Insert (or replace, for re-runs with --force) an eval row. */
export async function upsertSessionEval(
  sessionId: string,
  rubric: EvalRubric,
  overallComments: string | null,
  judgeModel: string,
  promptVersion: string,
  judgeSpread: Record<string, number> | null = null,
): Promise<SessionEvalRow> {
  const result = await pool.query<SessionEvalRow>(
    `INSERT INTO session_evals (session_id, rubric, overall_comments, judge_model, prompt_version, judge_spread)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (session_id, prompt_version) DO UPDATE
       SET rubric = EXCLUDED.rubric,
           overall_comments = EXCLUDED.overall_comments,
           judge_model = EXCLUDED.judge_model,
           judge_spread = EXCLUDED.judge_spread,
           created_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      sessionId,
      JSON.stringify(rubric),
      overallComments,
      judgeModel,
      promptVersion,
      judgeSpread ? JSON.stringify(judgeSpread) : null,
    ],
  );
  return result.rows[0];
}

// ---- Judge ensemble (migration 107) ----

/** One raw judge run behind a consensus session_evals row. */
export interface SessionEvalJudgeRow {
  eval_judge_id: number;
  session_id: string;
  prompt_version: string;
  judge_model: string;
  run_index: number;
  seed: number | null;
  rubric: EvalRubric;
  overall_comments: string | null;
  created_at: Date;
}

export interface NewJudgeRun {
  judgeModel: string;
  runIndex: number;
  seed: number | null;
  rubric: EvalRubric;
  overallComments: string | null;
}

/** Replace the per-judge runs for (session, prompt_version) wholesale, in one
 *  transaction, so a forced re-run never leaves stale runs behind. */
export async function replaceSessionEvalJudges(
  sessionId: string,
  promptVersion: string,
  runs: NewJudgeRun[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM session_eval_judges WHERE session_id = $1 AND prompt_version = $2', [
      sessionId,
      promptVersion,
    ]);
    for (const run of runs) {
      await client.query(
        `INSERT INTO session_eval_judges
           (session_id, prompt_version, judge_model, run_index, seed, rubric, overall_comments)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sessionId,
          promptVersion,
          run.judgeModel,
          run.runIndex,
          run.seed,
          JSON.stringify(run.rubric),
          run.overallComments,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** All judge runs for a prompt version (newest sessions first), for the
 *  inter-judge agreement report. Sandbox/demo filtering is not applied: the
 *  rows only exist for sessions the judge was explicitly run on. */
export async function getSessionEvalJudgeRuns(promptVersion: string, limit = 5000): Promise<SessionEvalJudgeRow[]> {
  const result = await pool.query<SessionEvalJudgeRow>(
    `SELECT * FROM session_eval_judges
     WHERE prompt_version = $1
     ORDER BY created_at DESC, session_id, judge_model, run_index
     LIMIT $2`,
    [promptVersion, limit],
  );
  return result.rows;
}

/** Judge runs behind one session's consensus row (any prompt version given). */
export async function getSessionEvalJudgesForSession(
  sessionId: string,
  promptVersion: string,
): Promise<SessionEvalJudgeRow[]> {
  const result = await pool.query<SessionEvalJudgeRow>(
    `SELECT * FROM session_eval_judges
     WHERE session_id = $1 AND prompt_version = $2
     ORDER BY judge_model, run_index`,
    [sessionId, promptVersion],
  );
  return result.rows;
}

/** Consensus rows with the largest judge disagreement for a prompt version
 *  (max spread over dimensions, desc). Only rows with a spread recorded. */
export async function getHighDisagreementEvals(
  promptVersion: string,
  limit = 10,
): Promise<Array<{ session_id: string; judge_spread: Record<string, number>; created_at: Date }>> {
  const result = await pool.query<{ session_id: string; judge_spread: Record<string, number>; created_at: Date }>(
    `SELECT session_id, judge_spread, created_at
     FROM session_evals
     WHERE prompt_version = $1 AND judge_spread IS NOT NULL
     ORDER BY (SELECT MAX((v)::int) FROM jsonb_each_text(judge_spread) AS e(k, v)) DESC, created_at DESC
     LIMIT $2`,
    [promptVersion, limit],
  );
  return result.rows;
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
    [promptVersion, limit],
  );
  return result.rows.map((r) => r.session_id);
}

// ---- Drift / trend monitoring (ai-therapist-84) ----

/** Weekly mean per dimension for the drift/trend chart, grouped by
 *  (ai_model, prompt_version). */
export interface EvalTrendRow {
  week: string; // ISO date of week start (date_trunc('week', se.created_at))
  ai_model: string | null;
  prompt_version: string;
  dimension: string;
  mean_score: number;
  n: number;
}

export async function getEvalScoreTrend(weeks: number): Promise<EvalTrendRow[]> {
  const result = await pool.query<{
    week: string;
    ai_model: string | null;
    prompt_version: string;
    dimension: string;
    mean_score: number;
    n: number;
  }>(
    `SELECT date_trunc('week', se.created_at)::date::text AS week,
            sc.ai_model, se.prompt_version,
            d.key AS dimension,
            AVG((d.value->>'score')::int)::float AS mean_score,
            COUNT(*)::int AS n
     FROM session_evals se
     LEFT JOIN session_configurations sc ON sc.session_id = se.session_id
     CROSS JOIN LATERAL jsonb_each(se.rubric) AS d(key, value)
     WHERE se.created_at >= NOW() - ($1 || ' weeks')::interval
       AND (d.value->>'score') ~ '^[0-9]+$'
     GROUP BY 1, 2, 3, 4
     ORDER BY 1, 2, 3, 4`,
    [String(weeks)],
  );
  return result.rows.map((r) => ({
    week: r.week,
    ai_model: r.ai_model,
    prompt_version: r.prompt_version,
    dimension: r.dimension,
    mean_score: Number(r.mean_score),
    n: Number(r.n),
  }));
}

/** The last `limit` (= windowN + baselineN) scores (newest first) for one
 *  (dimension, ai_model, prompt_version) bucket — used by the drift check. */
export async function getRecentDimensionScores(
  dimension: string,
  aiModel: string | null,
  promptVersion: string,
  limit: number,
): Promise<number[]> {
  const result = await pool.query<{ score: number }>(
    `SELECT (se.rubric->$1->>'score')::int AS score
     FROM session_evals se
     LEFT JOIN session_configurations sc USING (session_id)
     WHERE se.prompt_version = $3
       AND sc.ai_model IS NOT DISTINCT FROM $2
       AND se.rubric ? $1
     ORDER BY se.created_at DESC
     LIMIT $4`,
    [dimension, aiModel, promptVersion, limit],
  );
  return result.rows.map((r) => Number(r.score));
}

/** Distinct (ai_model, prompt_version) buckets with >= minN evals. */
export async function getEvalBuckets(
  minN: number,
): Promise<Array<{ ai_model: string | null; prompt_version: string; n: number }>> {
  const result = await pool.query<{ ai_model: string | null; prompt_version: string; n: number }>(
    `SELECT sc.ai_model, se.prompt_version, COUNT(*)::int AS n
     FROM session_evals se
     LEFT JOIN session_configurations sc ON sc.session_id = se.session_id
     GROUP BY sc.ai_model, se.prompt_version
     HAVING COUNT(*) >= $1
     ORDER BY se.prompt_version, sc.ai_model`,
    [minN],
  );
  return result.rows.map((r) => ({ ai_model: r.ai_model, prompt_version: r.prompt_version, n: Number(r.n) }));
}
