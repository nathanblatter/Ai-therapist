// Pairwise A/B eval rows: one row per position-debiased judged pair of matched
// ended sessions. Written by services/pairwiseEval.service.ts; aggregated for
// the Analytics PairwiseEvalPanel. See migration 051.
import { pool } from '../config/db.js';

export type ComparisonAxis = 'ai_model' | 'proactive_offering';
export type DurationBand = 'short' | 'medium' | 'long';

export interface EvalPairRow {
  pair_id: number;
  session_a: string;
  session_b: string;
  comparison_axis: ComparisonAxis;
  arm_a: string;
  arm_b: string;
  modality: string | null;
  duration_band: DurationBand;
  judge_model: string;
  prompt_version: string;
  verdict_ab: 'a' | 'b' | 'tie';
  verdict_ba: 'a' | 'b' | 'tie';
  rationale_ab: string | null;
  rationale_ba: string | null;
  final_verdict: 'a' | 'b' | 'tie' | 'inconsistent';
  created_at: Date;
}

export interface PairCandidateRow {
  session_id: string;
  modality: string | null;
  duration_band: DurationBand;
  arm: string; // ai_model value, or 'proactive'/'reactive'
  created_at: Date;
}

/** Ended sessions eligible for pairing on an axis (arm value NOT NULL, has at
 *  least one user AND one assistant message). Excludes is_demo sessions. */
export async function getPairCandidates(axis: ComparisonAxis, limit = 1000): Promise<PairCandidateRow[]> {
  const result = await pool.query<PairCandidateRow>(
    `SELECT ts.session_id,
            sc.modality,
            CASE
              WHEN EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) < 300 THEN 'short'
              WHEN EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) < 1800 THEN 'medium'
              ELSE 'long'
            END AS duration_band,
            CASE WHEN $1 = 'ai_model' THEN sc.ai_model
                 WHEN sc.proactive_offering THEN 'proactive' ELSE 'reactive' END AS arm,
            ts.created_at
     FROM therapy_sessions ts
     JOIN session_configurations sc ON sc.session_id = ts.session_id
     WHERE ts.status = 'ended'
       AND ts.ended_at IS NOT NULL
       AND COALESCE(ts.is_demo, FALSE) = FALSE
       AND (($1 = 'ai_model' AND sc.ai_model IS NOT NULL)
         OR ($1 = 'proactive_offering' AND sc.proactive_offering IS NOT NULL))
       AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = ts.session_id AND m.role = 'user')
       AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = ts.session_id AND m.role = 'assistant')
     ORDER BY ts.created_at DESC
     LIMIT $2`,
    [axis, limit]
  );
  return result.rows;
}

/** Session ids already used in a stored pair for (axis, promptVersion). */
export async function getPairedSessionIds(axis: string, promptVersion: string): Promise<Set<string>> {
  const result = await pool.query<{ session_id: string }>(
    `SELECT session_a AS session_id FROM session_eval_pairs
       WHERE comparison_axis = $1 AND prompt_version = $2
     UNION
     SELECT session_b AS session_id FROM session_eval_pairs
       WHERE comparison_axis = $1 AND prompt_version = $2`,
    [axis, promptVersion]
  );
  return new Set(result.rows.map(r => r.session_id));
}

export async function insertEvalPair(row: Omit<EvalPairRow, 'pair_id' | 'created_at'>): Promise<EvalPairRow> {
  const result = await pool.query<EvalPairRow>(
    `INSERT INTO session_eval_pairs
       (session_a, session_b, comparison_axis, arm_a, arm_b, modality, duration_band,
        judge_model, prompt_version, verdict_ab, verdict_ba, rationale_ab, rationale_ba, final_verdict)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      row.session_a, row.session_b, row.comparison_axis, row.arm_a, row.arm_b,
      row.modality, row.duration_band, row.judge_model, row.prompt_version,
      row.verdict_ab, row.verdict_ba, row.rationale_ab, row.rationale_ba, row.final_verdict,
    ]
  );
  return result.rows[0];
}

/** Aggregate for Analytics: per (axis, arm_x, arm_y) with wins/losses/ties. */
export interface PairwiseAggregateRow {
  comparison_axis: string;
  arm_x: string; // LEAST(arm_a, arm_b) — stable orientation
  arm_y: string;
  wins_x: number; // final_verdict favored arm_x's session
  wins_y: number;
  ties: number; // 'tie' + 'inconsistent'
  inconsistent: number;
  total: number;
}

export async function getPairwiseAggregates(promptVersion: string): Promise<PairwiseAggregateRow[]> {
  const result = await pool.query<{
    comparison_axis: string;
    arm_x: string;
    arm_y: string;
    wins_x: string;
    wins_y: string;
    ties: string;
    inconsistent: string;
    total: string;
  }>(
    `SELECT comparison_axis,
            LEAST(arm_a, arm_b)    AS arm_x,
            GREATEST(arm_a, arm_b) AS arm_y,
            COUNT(*) FILTER (WHERE (final_verdict = 'a' AND arm_a = LEAST(arm_a, arm_b))
                                 OR (final_verdict = 'b' AND arm_b = LEAST(arm_a, arm_b))) AS wins_x,
            COUNT(*) FILTER (WHERE (final_verdict = 'a' AND arm_a = GREATEST(arm_a, arm_b))
                                 OR (final_verdict = 'b' AND arm_b = GREATEST(arm_a, arm_b))) AS wins_y,
            COUNT(*) FILTER (WHERE final_verdict IN ('tie', 'inconsistent')) AS ties,
            COUNT(*) FILTER (WHERE final_verdict = 'inconsistent') AS inconsistent,
            COUNT(*) AS total
     FROM session_eval_pairs
     WHERE prompt_version = $1
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3`,
    [promptVersion]
  );
  return result.rows.map(r => ({
    comparison_axis: r.comparison_axis,
    arm_x: r.arm_x,
    arm_y: r.arm_y,
    wins_x: Number(r.wins_x),
    wins_y: Number(r.wins_y),
    ties: Number(r.ties),
    inconsistent: Number(r.inconsistent),
    total: Number(r.total),
  }));
}
