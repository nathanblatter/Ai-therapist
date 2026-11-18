// Data access for config_evaluations (migration 126) and the system_config
// rows that make up the evaluated configuration. Logic (fingerprint, drift
// state, claim policy) lives in services/configEvaluation.service.ts.
import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { EVALUATED_CONFIG_KEYS } from '../utils/evaluatedConfig.js';

/** Anything with pg's query signature (the pool or a checked-out client). */
type Queryable = Pick<PoolClient, 'query'>;

export interface EvaluatedConfigRow {
  config_key: string;
  config_value: unknown;
  updated_at: Date | string | null;
  updated_by: string | null;
}

export type ConfigEvaluationStatus = 'running' | 'passed' | 'failed' | 'error';

export interface ConfigEvaluationRow {
  id: number;
  fingerprint: string;
  config_version: number;
  suite: string;
  status: ConfigEvaluationStatus;
  git_sha: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  scenarios_total: number | null;
  scenarios_passed: number | null;
  scenarios_failed: number | null;
  known_gaps: number | null;
  est_cost_usd: string | null;
  result_url: string | null;
  triggered_by: string;
  config_changed_at: Date | string | null;
  config_changed_by: string | null;
  error: string | null;
}

/** The system_config rows that feed the fingerprint, with their audit columns. */
export async function getEvaluatedConfigRows(db: Queryable = pool): Promise<EvaluatedConfigRow[]> {
  const { rows } = await db.query<EvaluatedConfigRow>(
    `SELECT config_key, config_value, updated_at, updated_by
       FROM system_config
      WHERE config_key = ANY($1::text[])`,
    [[...EVALUATED_CONFIG_KEYS]],
  );
  return rows;
}

/** Every recorded evaluation of one fingerprint, newest first. */
export async function listConfigEvaluationsForFingerprint(
  fingerprint: string,
  db: Queryable = pool,
): Promise<ConfigEvaluationRow[]> {
  const { rows } = await db.query<ConfigEvaluationRow>(
    `SELECT * FROM config_evaluations WHERE fingerprint = $1 ORDER BY started_at DESC, id DESC LIMIT 50`,
    [fingerprint],
  );
  return rows;
}

/** The most recent finished (passed or failed) evaluation of any fingerprint. */
export async function getLatestFinishedConfigEvaluation(db: Queryable = pool): Promise<ConfigEvaluationRow | null> {
  const { rows } = await db.query<ConfigEvaluationRow>(
    `SELECT * FROM config_evaluations
      WHERE status IN ('passed', 'failed')
      ORDER BY finished_at DESC NULLS LAST, id DESC
      LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Evaluations started since `since` (every claim counts toward the daily cap). */
export async function countConfigEvaluationsSince(since: Date, db: Queryable = pool): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM config_evaluations WHERE started_at >= $1`,
    [since.toISOString()],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface NewConfigEvaluationClaim {
  fingerprint: string;
  configVersion: number;
  suite: string;
  gitSha: string | null;
  resultUrl: string | null;
  triggeredBy: string;
  configChangedAt: Date | string | null;
  configChangedBy: string | null;
}

export async function insertConfigEvaluationClaim(
  claim: NewConfigEvaluationClaim,
  db: Queryable = pool,
): Promise<ConfigEvaluationRow> {
  const { rows } = await db.query<ConfigEvaluationRow>(
    `INSERT INTO config_evaluations
       (fingerprint, config_version, suite, status, git_sha, result_url, triggered_by, config_changed_at, config_changed_by)
     VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      claim.fingerprint,
      claim.configVersion,
      claim.suite,
      claim.gitSha,
      claim.resultUrl,
      claim.triggeredBy,
      claim.configChangedAt,
      claim.configChangedBy,
    ],
  );
  return rows[0];
}

export interface ConfigEvaluationResult {
  status: Exclude<ConfigEvaluationStatus, 'running'>;
  scenariosTotal: number | null;
  scenariosPassed: number | null;
  scenariosFailed: number | null;
  knownGaps: number | null;
  estCostUsd: number | null;
  gitSha: string | null;
  resultUrl: string | null;
  error: string | null;
}

/** Close a running evaluation; null when the id is unknown or already finished. */
export async function finishConfigEvaluation(
  id: number,
  result: ConfigEvaluationResult,
  db: Queryable = pool,
): Promise<ConfigEvaluationRow | null> {
  const { rows } = await db.query<ConfigEvaluationRow>(
    `UPDATE config_evaluations
        SET status = $2,
            finished_at = CURRENT_TIMESTAMP,
            scenarios_total = $3,
            scenarios_passed = $4,
            scenarios_failed = $5,
            known_gaps = $6,
            est_cost_usd = $7,
            git_sha = COALESCE($8, git_sha),
            result_url = COALESCE($9, result_url),
            error = $10
      WHERE id = $1 AND status = 'running'
      RETURNING *`,
    [
      id,
      result.status,
      result.scenariosTotal,
      result.scenariosPassed,
      result.scenariosFailed,
      result.knownGaps,
      result.estCostUsd === null ? null : result.estCostUsd.toFixed(4),
      result.gitSha,
      result.resultUrl,
      result.error,
    ],
  );
  return rows[0] ?? null;
}
