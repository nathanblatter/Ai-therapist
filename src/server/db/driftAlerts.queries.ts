// Eval drift alert rows: open/acknowledged regression alerts raised when a
// rubric dimension's rolling mean drops beyond the configured threshold.
// Written by services/evalDrift.service.ts; surfaced in the Analytics
// EvalDriftPanel and acknowledged from evals.routes.ts. See migration 051.
import { pool } from '../config/db.js';

export interface DriftAlertRow {
  alert_id: number;
  dimension: string;
  ai_model: string | null;
  prompt_version: string;
  rolling_mean: number;
  baseline_mean: number;
  drop_amount: number;
  window_n: number;
  baseline_n: number;
  paged: boolean;
  acknowledged_at: Date | null;
  acknowledged_by: number | null;
  created_at: Date;
}

// NUMERIC columns arrive from pg as strings; normalize to numbers.
function normalize(row: Record<string, unknown>): DriftAlertRow {
  return {
    ...(row as unknown as DriftAlertRow),
    rolling_mean: Number(row.rolling_mean),
    baseline_mean: Number(row.baseline_mean),
    drop_amount: Number(row.drop_amount),
    window_n: Number(row.window_n),
    baseline_n: Number(row.baseline_n),
  };
}

/** Insert an open alert; returns null on unique-violation (an open alert for the
 *  bucket already exists) — catch pg error code '23505'. */
export async function insertDriftAlert(
  a: Omit<DriftAlertRow, 'alert_id' | 'created_at' | 'acknowledged_at' | 'acknowledged_by' | 'paged'> & { paged?: boolean }
): Promise<DriftAlertRow | null> {
  try {
    const result = await pool.query(
      `INSERT INTO eval_drift_alerts
         (dimension, ai_model, prompt_version, rolling_mean, baseline_mean, drop_amount, window_n, baseline_n, paged)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        a.dimension, a.ai_model, a.prompt_version, a.rolling_mean, a.baseline_mean,
        a.drop_amount, a.window_n, a.baseline_n, a.paged ?? false,
      ]
    );
    return normalize(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return null; // open alert already exists
    throw err;
  }
}

export async function getOpenDriftAlerts(): Promise<DriftAlertRow[]> {
  const result = await pool.query(
    `SELECT * FROM eval_drift_alerts
     WHERE acknowledged_at IS NULL
     ORDER BY created_at DESC`
  );
  return result.rows.map(normalize);
}

export async function acknowledgeDriftAlert(alertId: number, userId: number): Promise<DriftAlertRow | null> {
  const result = await pool.query(
    `UPDATE eval_drift_alerts
       SET acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by = $2
     WHERE alert_id = $1 AND acknowledged_at IS NULL
     RETURNING *`,
    [alertId, userId]
  );
  return result.rows[0] ? normalize(result.rows[0]) : null;
}

export async function markDriftAlertPaged(alertId: number): Promise<void> {
  await pool.query('UPDATE eval_drift_alerts SET paged = TRUE WHERE alert_id = $1', [alertId]);
}
