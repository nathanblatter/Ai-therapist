// Config-drift gate for the red-team suite: is the configuration this
// environment runs right now covered by a passing red-team evaluation?
//
//   fingerprint   utils/evaluatedConfig.ts (pure; shared with the harness)
//   record        config_evaluations (migration 126) via db/configEvaluations.queries.ts
//   status        getConfigEvalStatus(): drives the admin drift notice and the
//                 redteam-config workflow's "should I run?" check
//   claim/finish  the workflow's write path (routes/redteamConfigEval.routes.ts)
//
// Nothing here blocks a config save or a session. A researcher fixing a bad
// prompt in a hurry must never be locked out by the eval pipeline; the notice
// stays up until the new configuration has passed instead.
//
// Cost and noise policy (one run per distinct fingerprint):
//   - a fingerprint with a 'running' claim younger than STALE_RUNNING_MS is
//     never claimed twice; a crashed run's claim expires after that
//   - a fingerprint that already passed is never re-run unless forced
//   - a fingerprint that FAILED is not re-run automatically (a failure needs a
//     human: fix the prompt, which is a new fingerprint, or force a re-run)
//   - a configuration edited within the settle window is not claimed yet, so an
//     edit storm is evaluated once, after it stops
//   - at most DAILY_CAP claims per rolling 24 h per environment, forced or not
import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import {
  countConfigEvaluationsSince,
  getEvaluatedConfigRows,
  getLatestFinishedConfigEvaluation,
  insertConfigEvaluationClaim,
  finishConfigEvaluation as finishConfigEvaluationRow,
  listConfigEvaluationsForFingerprint,
  type ConfigEvaluationResult,
  type ConfigEvaluationRow,
  type EvaluatedConfigRow,
} from '../db/configEvaluations.queries.js';
import {
  EVALUATED_CONFIG_VERSION,
  buildConfigSnapshot,
  fingerprintConfigRows,
  shortFingerprint,
  type ConfigSnapshot,
} from '../utils/evaluatedConfig.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('configEvaluation');

/** A 'running' claim older than this is treated as a crashed run. */
export const STALE_RUNNING_MS = 3 * 60 * 60 * 1000;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Quiet period after the last edit to an evaluated key before a run is claimed. */
export function settleMs(): number {
  return envInt('REDTEAM_CONFIG_EVAL_SETTLE_MINUTES', 10, 0, 24 * 60) * 60 * 1000;
}

/** Claims allowed per rolling 24 h on this environment. */
export function dailyCap(): number {
  return envInt('REDTEAM_CONFIG_EVAL_DAILY_CAP', 4, 0, 48);
}

export type ConfigEvalState = 'passed' | 'failed' | 'running' | 'unevaluated';

export interface LastConfigChange {
  at: string | null;
  by: string | null;
  key: string | null;
}

export interface ConfigEvaluationSummary {
  id: number;
  fingerprint: string;
  status: ConfigEvaluationRow['status'];
  suite: string;
  started_at: string;
  finished_at: string | null;
  scenarios_total: number | null;
  scenarios_passed: number | null;
  scenarios_failed: number | null;
  known_gaps: number | null;
  result_url: string | null;
  triggered_by: string;
  git_sha: string | null;
}

export type ClaimRefusal =
  | 'already_passed'
  | 'in_progress'
  | 'failed_needs_manual_rerun'
  | 'settling'
  | 'daily_cap'
  | 'not_migrated';

export interface ConfigEvalStatus {
  fingerprint: string;
  short_fingerprint: string;
  config_version: number;
  state: ConfigEvalState;
  /** True only when the current fingerprint has a passing evaluation. */
  evaluated: boolean;
  last_change: LastConfigChange;
  /** The evaluation the state rests on (the passing, running or failed one). */
  current_evaluation: ConfigEvaluationSummary | null;
  /** The most recent finished evaluation of ANY fingerprint. */
  last_evaluated: ConfigEvaluationSummary | null;
  should_run: boolean;
  reason: ClaimRefusal | null;
  runs_last_24h: number;
  daily_cap: number;
  /** Quiet period before an edited configuration is claimed. */
  settle_minutes: number;
  /** config_evaluations does not exist yet (migration 126 not applied). */
  table_missing: boolean;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

export function summarizeEvaluation(row: ConfigEvaluationRow): ConfigEvaluationSummary {
  return {
    id: Number(row.id),
    fingerprint: row.fingerprint,
    status: row.status,
    suite: row.suite,
    started_at: iso(row.started_at) as string,
    finished_at: iso(row.finished_at),
    scenarios_total: row.scenarios_total,
    scenarios_passed: row.scenarios_passed,
    scenarios_failed: row.scenarios_failed,
    known_gaps: row.known_gaps,
    result_url: row.result_url,
    triggered_by: row.triggered_by,
    git_sha: row.git_sha,
  };
}

/** The latest edit to any evaluated key, from system_config's audit columns. */
export function lastConfigChange(rows: readonly EvaluatedConfigRow[]): LastConfigChange {
  let latest: EvaluatedConfigRow | null = null;
  for (const r of rows) {
    if (r.updated_at === null) continue;
    if (!latest || new Date(r.updated_at).getTime() > new Date(latest.updated_at as Date | string).getTime())
      latest = r;
  }
  return latest
    ? { at: iso(latest.updated_at), by: latest.updated_by ?? null, key: latest.config_key }
    : { at: null, by: null, key: null };
}

/**
 * Drift state of one fingerprint from its evaluations (newest first): passed
 * wins, then a live claim, then the newest finished result; an 'error' run or
 * a claim older than STALE_RUNNING_MS counts as never evaluated.
 */
export function deriveConfigEvalState(
  evaluations: readonly ConfigEvaluationRow[],
  now: Date,
): { state: ConfigEvalState; row: ConfigEvaluationRow | null } {
  const passed = evaluations.find((e) => e.status === 'passed');
  if (passed) return { state: 'passed', row: passed };
  const live = evaluations.find(
    (e) => e.status === 'running' && now.getTime() - new Date(e.started_at).getTime() < STALE_RUNNING_MS,
  );
  if (live) return { state: 'running', row: live };
  const failed = evaluations.find((e) => e.status === 'failed');
  if (failed) return { state: 'failed', row: failed };
  return { state: 'unevaluated', row: null };
}

/** Whether the workflow may claim this fingerprint now (see the header). */
export function decideClaim(input: {
  state: ConfigEvalState;
  lastChangeAt: string | null;
  now: Date;
  runsLast24h: number;
  cap: number;
  settleMs: number;
  force: boolean;
}): { ok: true } | { ok: false; reason: ClaimRefusal } {
  if (input.state === 'running') return { ok: false, reason: 'in_progress' };
  if (!input.force) {
    if (input.state === 'passed') return { ok: false, reason: 'already_passed' };
    if (input.state === 'failed') return { ok: false, reason: 'failed_needs_manual_rerun' };
    if (input.lastChangeAt && input.now.getTime() - new Date(input.lastChangeAt).getTime() < input.settleMs) {
      return { ok: false, reason: 'settling' };
    }
  }
  if (input.runsLast24h >= input.cap) return { ok: false, reason: 'daily_cap' };
  return { ok: true };
}

const isMissingTable = (err: unknown): boolean => (err as { code?: string } | null)?.code === '42P01';

type Queryable = Pick<PoolClient, 'query'>;

async function computeStatus(db: Queryable, now: Date): Promise<ConfigEvalStatus & { rows: EvaluatedConfigRow[] }> {
  const rows = await getEvaluatedConfigRows(db);
  const fingerprint = fingerprintConfigRows(rows);
  const lastChange = lastConfigChange(rows);
  let evaluations: ConfigEvaluationRow[] = [];
  let latestFinished: ConfigEvaluationRow | null = null;
  let runsLast24h = 0;
  let tableMissing = false;
  try {
    evaluations = await listConfigEvaluationsForFingerprint(fingerprint, db);
    latestFinished = await getLatestFinishedConfigEvaluation(db);
    runsLast24h = await countConfigEvaluationsSince(new Date(now.getTime() - 24 * 60 * 60 * 1000), db);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    tableMissing = true;
  }
  const { state, row } = deriveConfigEvalState(evaluations, now);
  const cap = dailyCap();
  const decision = tableMissing
    ? ({ ok: false, reason: 'not_migrated' } as const)
    : decideClaim({ state, lastChangeAt: lastChange.at, now, runsLast24h, cap, settleMs: settleMs(), force: false });
  return {
    rows,
    fingerprint,
    short_fingerprint: shortFingerprint(fingerprint),
    config_version: EVALUATED_CONFIG_VERSION,
    state,
    evaluated: state === 'passed',
    last_change: lastChange,
    current_evaluation: row ? summarizeEvaluation(row) : null,
    last_evaluated: latestFinished ? summarizeEvaluation(latestFinished) : null,
    should_run: decision.ok,
    reason: decision.ok ? null : decision.reason,
    runs_last_24h: runsLast24h,
    daily_cap: cap,
    settle_minutes: settleMs() / 60_000,
    table_missing: tableMissing,
  };
}

export async function getConfigEvalStatus(now: Date = new Date()): Promise<ConfigEvalStatus> {
  const { rows: _rows, ...status } = await computeStatus(pool, now);
  return status;
}

/** Configuration-only snapshot of this environment (see evaluatedConfig.ts). */
export async function exportConfigSnapshot(environment: string | null): Promise<ConfigSnapshot> {
  const rows = await getEvaluatedConfigRows();
  return buildConfigSnapshot(rows, { environment });
}

export type ClaimOutcome =
  | { claimed: true; evaluation: ConfigEvaluationSummary; snapshot: ConfigSnapshot }
  | { claimed: false; reason: ClaimRefusal; status: ConfigEvalStatus };

/**
 * Atomically decide and record a claim on the CURRENT fingerprint, returning
 * the snapshot of exactly that configuration. One advisory lock serialises
 * concurrent claims so a fingerprint is never claimed twice.
 */
export async function claimConfigEvaluation(input: {
  suite: string;
  triggeredBy: string;
  gitSha: string | null;
  resultUrl: string | null;
  environment: string | null;
  force: boolean;
  now?: Date;
}): Promise<ClaimOutcome> {
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('config_evaluations_claim'))`);
    const { rows, ...status } = await computeStatus(client, now);
    if (status.table_missing) throw new Error('config_evaluations table missing: apply migration 126');
    const decision = decideClaim({
      state: status.state,
      lastChangeAt: status.last_change.at,
      now,
      runsLast24h: status.runs_last_24h,
      cap: status.daily_cap,
      settleMs: settleMs(),
      force: input.force,
    });
    if (!decision.ok) {
      await client.query('ROLLBACK');
      return { claimed: false, reason: decision.reason, status };
    }
    const snapshot = buildConfigSnapshot(rows, { environment: input.environment, now });
    const row = await insertConfigEvaluationClaim(
      {
        fingerprint: snapshot.fingerprint,
        configVersion: EVALUATED_CONFIG_VERSION,
        suite: input.suite,
        gitSha: input.gitSha,
        resultUrl: input.resultUrl,
        triggeredBy: input.triggeredBy,
        configChangedAt: status.last_change.at,
        configChangedBy: status.last_change.by,
      },
      client,
    );
    await client.query('COMMIT');
    log.info(
      { evaluationId: row.id, fingerprint: shortFingerprint(snapshot.fingerprint), triggeredBy: input.triggeredBy },
      'config evaluation claimed',
    );
    return { claimed: true, evaluation: summarizeEvaluation(row), snapshot };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function finishConfigEvaluation(
  id: number,
  result: ConfigEvaluationResult,
): Promise<ConfigEvaluationSummary | null> {
  const row = await finishConfigEvaluationRow(id, result);
  if (row) log.info({ evaluationId: id, status: row.status }, 'config evaluation finished');
  return row ? summarizeEvaluation(row) : null;
}
