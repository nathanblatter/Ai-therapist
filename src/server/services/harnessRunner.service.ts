// Admin-triggered + scheduled simulation-eval runs (ai-therapist-124).
//
// The harness (src/redteam/cli.ts) is a standalone process that boots its own
// copy of the app in-process, so the runner spawns it as a CHILD sharing this
// deployment's env/DB rather than running scenarios inside the live server.
// The child self-neuters the dangerous surfaces (IMESSAGE/CRISIS paging env,
// SOCKET_PG_ADAPTER=off so its emissions never reach real admin dashboards),
// its sessions are is_demo-marked via the harness participant (analytics/AE
// walls), and it persists results itself (harness_runs → Simulation Runs
// panel).
//
// One run at a time; state is in-memory (a restart orphans nothing — the
// child finishes and persists on its own, it just stops being tracked).
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../config/db.js';
import { getSystemConfig } from '../utils/sessionHelpers.js';
import { HARNESS_USERNAME } from '../utils/harness.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('harnessRunner');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LOG_TAIL_LINES = 80;
const RUN_TIMEOUT_MS = 30 * 60 * 1000; // hard kill: no suite legitimately runs >30min

export type HarnessSuite = 'smoke' | 'full' | 'quality' | 'voice' | 'replay';
const SUITES: HarnessSuite[] = ['smoke', 'full', 'quality', 'voice', 'replay'];

export interface HarnessRunRequest {
  suite: HarnessSuite;
  scenarioId?: string;
  variations?: number;
  trigger?: string; // 'admin' | 'nightly'
}

export interface RunnerStatus {
  running: boolean;
  suite?: HarnessSuite;
  trigger?: string;
  startedAt?: string;
  pid?: number;
  /** Rolling tail of child stdout/stderr (secrets never printed by the CLI). */
  logTail: string[];
  lastExit?: { code: number | null; at: string; suite: HarnessSuite };
}

interface ActiveRun {
  child: ChildProcess;
  suite: HarnessSuite;
  trigger: string;
  startedAt: string;
  logTail: string[];
  killTimer: NodeJS.Timeout;
}

let active: ActiveRun | null = null;
let lastExit: RunnerStatus['lastExit'];

function appendLog(run: ActiveRun, chunk: Buffer | string): void {
  for (const line of chunk.toString().split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    run.logTail.push(trimmed);
  }
  if (run.logTail.length > LOG_TAIL_LINES) run.logTail.splice(0, run.logTail.length - LOG_TAIL_LINES);
}

/** The dedicated harness participant must exist before a run (idempotent;
 *  mirrors scripts/redteam-seed-user.mjs). */
export async function ensureHarnessUser(): Promise<void> {
  const bcrypt = (await import('bcrypt')).default;
  const password = process.env.REDTEAM_PARTICIPANT_PASS || 'redteam-Passw0rd!';
  const hash = await bcrypt.hash(password, 10);
  // organization_id is NOT NULL since migration 069; the harness account
  // lives in the irb-study org (its sessions are excluded via is_demo).
  await pool.query(
    `INSERT INTO users (username, password, role, organization_id)
     VALUES ($1, $2, 'participant', (SELECT org_id FROM organizations WHERE slug = 'irb-study'))
     ON CONFLICT (username) DO NOTHING`,
    [HARNESS_USERNAME, hash],
  );
}

export function getRunnerStatus(): RunnerStatus {
  if (!active) return { running: false, logTail: lastExit ? [] : [], lastExit };
  return {
    running: true,
    suite: active.suite,
    trigger: active.trigger,
    startedAt: active.startedAt,
    pid: active.child.pid ?? undefined,
    logTail: [...active.logTail],
    lastExit,
  };
}

/** Start a harness run as a child process. Throws if one is already running
 *  or the request is invalid. */
export async function startHarnessRun(req: HarnessRunRequest): Promise<{ pid: number; suite: HarnessSuite }> {
  if (active) throw new Error(`a ${active.suite} run is already in progress (pid ${active.child.pid})`);
  if (!SUITES.includes(req.suite)) throw new Error(`unknown suite '${req.suite}'`);

  await ensureHarnessUser();

  const tsxCli = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
  const args: string[] = [tsxCli];
  if (req.suite === 'replay') {
    args.push(path.join(REPO_ROOT, 'src/redteam/replay.ts'), '--allow-fail');
  } else {
    args.push(path.join(REPO_ROOT, 'src/redteam/cli.ts'), '--suite', req.suite, '--allow-fail');
    if (req.scenarioId) args.push('--scenario', req.scenarioId);
    if (req.variations && req.variations > 1) args.push('--variations', String(Math.min(req.variations, 5)));
  }

  const trigger = req.trigger ?? 'admin';
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, REDTEAM_TRIGGER: trigger },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const run: ActiveRun = {
    child,
    suite: req.suite,
    trigger,
    startedAt: new Date().toISOString(),
    logTail: [],
    killTimer: setTimeout(() => {
      log.warn(`harness ${req.suite} run exceeded ${RUN_TIMEOUT_MS / 60000}min; killing pid ${child.pid}`);
      child.kill('SIGKILL');
    }, RUN_TIMEOUT_MS),
  };
  child.stdout?.on('data', d => appendLog(run, d));
  child.stderr?.on('data', d => appendLog(run, d));
  child.on('exit', code => {
    clearTimeout(run.killTimer);
    lastExit = { code, at: new Date().toISOString(), suite: run.suite };
    if (active?.child === child) active = null;
    log.info(`harness ${run.suite} run (pid ${child.pid}) exited with code ${code}`);
  });
  child.on('error', err => {
    clearTimeout(run.killTimer);
    lastExit = { code: null, at: new Date().toISOString(), suite: run.suite };
    if (active?.child === child) active = null;
    log.error({ err }, 'harness child failed to spawn');
  });

  active = run;
  log.info(`started harness ${req.suite} run (trigger=${trigger}, pid ${child.pid})`);
  return { pid: child.pid ?? -1, suite: req.suite };
}

// ---------------------------------------------------------------------------
// Nightly schedule (system_config: evals.harness_schedule)
// ---------------------------------------------------------------------------

export interface HarnessSchedule {
  enabled: boolean;
  suite: HarnessSuite;
  /** UTC hour 0-23 at which the nightly run fires. */
  hour_utc: number;
  variations: number;
}

export const DEFAULT_SCHEDULE: HarnessSchedule = { enabled: false, suite: 'voice', hour_utc: 9, variations: 1 };

export function normalizeSchedule(raw: unknown): HarnessSchedule {
  const r = (raw ?? {}) as Partial<HarnessSchedule>;
  return {
    enabled: r.enabled === true,
    suite: SUITES.includes(r.suite as HarnessSuite) ? (r.suite as HarnessSuite) : DEFAULT_SCHEDULE.suite,
    hour_utc: Number.isInteger(r.hour_utc) && (r.hour_utc as number) >= 0 && (r.hour_utc as number) <= 23
      ? (r.hour_utc as number) : DEFAULT_SCHEDULE.hour_utc,
    variations: Number.isInteger(r.variations) && (r.variations as number) >= 1 && (r.variations as number) <= 5
      ? (r.variations as number) : 1,
  };
}

export async function getHarnessSchedule(): Promise<HarnessSchedule> {
  const config = await getSystemConfig();
  const evals = (config.evals ?? {}) as { harness_schedule?: unknown };
  return normalizeSchedule(evals.harness_schedule);
}

/** Persist the schedule under system_config.evals.harness_schedule, merging
 *  with the rest of the evals config (drift settings live there too). The
 *  evals row may not exist yet — update-then-insert (config_key has no unique
 *  constraint, so no ON CONFLICT). */
export async function setHarnessSchedule(raw: unknown, updatedBy: string): Promise<HarnessSchedule> {
  const schedule = normalizeSchedule(raw);
  const { rows } = await pool.query<{ config_value: Record<string, unknown> }>(
    `SELECT config_value FROM system_config WHERE config_key = 'evals' LIMIT 1`,
  );
  const merged = { ...(rows[0]?.config_value ?? {}), harness_schedule: schedule };
  if (rows.length > 0) {
    await pool.query(
      `UPDATE system_config SET config_value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
       WHERE config_key = 'evals'`,
      [JSON.stringify(merged), updatedBy],
    );
  } else {
    await pool.query(
      `INSERT INTO system_config (config_key, config_value, description, updated_by)
       VALUES ('evals', $1, 'Eval-system settings (drift monitoring, harness schedule)', $2)`,
      [JSON.stringify(merged), updatedBy],
    );
  }
  const { invalidateConfigCache } = await import('../utils/sessionHelpers.js');
  invalidateConfigCache();
  return schedule;
}

/** Pure decision: fire when enabled, the UTC hour matches, no run is active,
 *  and no scheduled run started in the last 20h (restart-safe via DB). */
export function nightlyDue(
  schedule: HarnessSchedule,
  now: Date,
  lastNightlyStartedAt: Date | null,
  runInProgress: boolean,
): boolean {
  if (!schedule.enabled || runInProgress) return false;
  if (now.getUTCHours() !== schedule.hour_utc) return false;
  if (lastNightlyStartedAt && now.getTime() - lastNightlyStartedAt.getTime() < 20 * 60 * 60 * 1000) return false;
  return true;
}

const SCHEDULER_TICK_MS = 5 * 60 * 1000;
let schedulerTimer: NodeJS.Timeout | null = null;

async function schedulerTick(): Promise<void> {
  try {
    const schedule = await getHarnessSchedule();
    const { rows } = await pool.query<{ started_at: Date }>(
      `SELECT started_at FROM harness_runs WHERE trigger = 'nightly' ORDER BY started_at DESC LIMIT 1`,
    );
    if (!nightlyDue(schedule, new Date(), rows[0]?.started_at ?? null, active !== null)) return;
    log.info(`nightly harness run due (suite=${schedule.suite})`);
    await startHarnessRun({ suite: schedule.suite, variations: schedule.variations, trigger: 'nightly' });
  } catch (err) {
    log.error({ err }, 'nightly harness scheduler tick failed');
  }
}

/** Start the in-process nightly scheduler (no-op when already started). */
export function startHarnessScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => { void schedulerTick(); }, SCHEDULER_TICK_MS);
  schedulerTimer.unref?.();
  log.info('harness nightly scheduler started (5min tick)');
}
