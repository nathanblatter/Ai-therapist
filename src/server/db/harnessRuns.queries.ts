// Simulation-eval run persistence (ai-therapist-124 phase 3). Written by the
// redteam CLI after each run (best-effort — a DB hiccup never fails a run);
// read by the admin "Simulation Runs" panel via routes/admin/evals.routes.ts.
import { pool } from '../config/db.js';

export interface HarnessRunRow {
  id: number;
  started_at: Date;
  finished_at: Date;
  suite: string;
  seed: number;
  variations: number;
  judge_model: string | null;
  git_sha: string | null;
  trigger: string;
  dry_run: boolean;
  scenario_count: number;
  pass_count: number;
  est_cost_usd: string;
}

export interface HarnessScenarioResultRow {
  id: number;
  run_id: number;
  scenario_id: string;
  variation: number;
  pipeline: string;
  passed: boolean;
  assertion_failures: Array<{ id: string; detail: string }>;
  judge_scores: Record<string, number> | null;
  session_id: string | null;
  error: string | null;
  duration_ms: number;
  cost_usd: string;
}

export interface NewHarnessRun {
  startedAt: string;
  finishedAt: string;
  suite: string;
  seed: number;
  variations: number;
  judgeModel?: string | null;
  gitSha?: string | null;
  trigger?: string;
  dryRun?: boolean;
  scenarios: Array<{
    scenarioId: string;
    variation: number;
    pipeline: string;
    passed: boolean;
    assertionFailures: Array<{ id: string; detail: string }>;
    judgeScores: Record<string, number> | null;
    sessionId?: string | null;
    error?: string | null;
    durationMs: number;
    costUsd: number;
  }>;
}

/** Insert one run + all its scenario rows in a single transaction; returns the
 *  run id. */
export async function insertHarnessRun(run: NewHarnessRun): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const passCount = run.scenarios.filter(s => s.passed).length;
    const estCost = run.scenarios.reduce((n, s) => n + s.costUsd, 0);
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO harness_runs
         (started_at, finished_at, suite, seed, variations, judge_model, git_sha, trigger, dry_run, scenario_count, pass_count, est_cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        run.startedAt, run.finishedAt, run.suite, run.seed, run.variations,
        run.judgeModel ?? null, run.gitSha ?? null, run.trigger ?? 'manual',
        run.dryRun ?? false, run.scenarios.length, passCount, estCost.toFixed(4),
      ],
    );
    const runId = rows[0].id;
    for (const s of run.scenarios) {
      await client.query(
        `INSERT INTO harness_scenario_results
           (run_id, scenario_id, variation, pipeline, passed, assertion_failures, judge_scores, session_id, error, duration_ms, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          runId, s.scenarioId, s.variation, s.pipeline, s.passed,
          JSON.stringify(s.assertionFailures), s.judgeScores ? JSON.stringify(s.judgeScores) : null,
          s.sessionId ?? null, s.error ?? null, s.durationMs, s.costUsd.toFixed(4),
        ],
      );
    }
    await client.query('COMMIT');
    return runId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Newest-first run list for the admin panel. */
export async function listHarnessRuns(limit = 50): Promise<HarnessRunRow[]> {
  const { rows } = await pool.query<HarnessRunRow>(
    `SELECT * FROM harness_runs ORDER BY started_at DESC LIMIT $1`,
    [Math.min(Math.max(1, limit), 200)],
  );
  return rows;
}

/** One run + its scenario rows, or null when the id doesn't exist. */
export async function getHarnessRun(
  id: number,
): Promise<{ run: HarnessRunRow; results: HarnessScenarioResultRow[] } | null> {
  const { rows } = await pool.query<HarnessRunRow>(`SELECT * FROM harness_runs WHERE id = $1`, [id]);
  if (rows.length === 0) return null;
  const results = await pool.query<HarnessScenarioResultRow>(
    `SELECT * FROM harness_scenario_results WHERE run_id = $1 ORDER BY scenario_id, variation`,
    [id],
  );
  return { run: rows[0], results: results.rows };
}
