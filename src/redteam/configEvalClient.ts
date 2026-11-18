// HTTP client the redteam-config workflow uses to talk to one environment's
// config-eval API (src/server/routes/redteamConfigEval.routes.ts).
//
//   tsx src/redteam/configEvalClient.ts status
//   tsx src/redteam/configEvalClient.ts claim  --snapshot-out <file> [--force]
//   tsx src/redteam/configEvalClient.ts finish --id <n> --fingerprint <fp> [--results <dir>] [--error <msg>]
//   tsx src/redteam/configEvalClient.ts redact [--results <dir>] [--out <file>]
//
// Node 24 runs it directly (`node src/redteam/configEvalClient.ts ...`, type
// stripping): it imports only node: builtins, so the cheap status check needs
// no npm ci.
//
// Env: REDTEAM_CONFIG_EVAL_URL (the app's base URL), REDTEAM_CONFIG_EVAL_TOKEN
// (the environment's dedicated token), REDTEAM_ENVIRONMENT (label), plus the
// usual GITHUB_* variables for provenance. Without the URL or token every
// command prints a notice and reports "not configured" without failing, so
// the workflow skips cleanly until the owner adds the secret.
//
// Outputs go to $GITHUB_OUTPUT as key=value lines. Nothing here prints the
// snapshot, the token or a staff username: workflow logs on this repository
// are public.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface RunTotals {
  scenariosTotal: number;
  scenariosPassed: number;
  scenariosFailed: number;
  knownGaps: number;
  estCostUsd: number | null;
}

interface SummaryJsonLike {
  scenarios?: Array<{ passed?: boolean; assertions?: Array<{ passed?: boolean; gating?: boolean }> }>;
  totals?: { estCostUsd?: number };
}

/** Totals for config_evaluations from a run's summary.json. Known gaps are the
 *  non-gating assertion failures (tracked, never failing a scenario). */
export function totalsFromSummary(summary: SummaryJsonLike): RunTotals {
  const scenarios = Array.isArray(summary.scenarios) ? summary.scenarios : [];
  const passed = scenarios.filter((s) => s.passed === true).length;
  const knownGaps = scenarios.reduce(
    (n, s) => n + (s.assertions ?? []).filter((a) => a.passed === false && a.gating === false).length,
    0,
  );
  const cost = summary.totals?.estCostUsd;
  return {
    scenariosTotal: scenarios.length,
    scenariosPassed: passed,
    scenariosFailed: scenarios.length - passed,
    knownGaps,
    estCostUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
  };
}

interface FullSummaryLike {
  suite?: string;
  startedAt?: string;
  finishedAt?: string;
  gitSha?: string | null;
  totals?: Record<string, unknown>;
  scenarios?: Array<{
    id?: string;
    pipeline?: string;
    passed?: boolean;
    error?: string | null;
    assertions?: Array<{ id?: string; passed?: boolean; gating?: boolean }>;
    judge?: { scores?: Record<string, unknown> } | null;
  }>;
}

/**
 * The part of summary.json that is safe on a public CI run: ids, verdicts,
 * failing assertion ids and judge scores. Drops transcripts and assertion
 * details, which can quote the model's replies (and so fragments of an
 * environment's hand-edited prompt) verbatim.
 */
export function redactSummary(summary: FullSummaryLike): Record<string, unknown> {
  return {
    suite: summary.suite ?? null,
    startedAt: summary.startedAt ?? null,
    finishedAt: summary.finishedAt ?? null,
    gitSha: summary.gitSha ?? null,
    totals: { ...totalsFromSummary(summary as SummaryJsonLike) },
    scenarios: (summary.scenarios ?? []).map((s) => ({
      id: s.id ?? null,
      pipeline: s.pipeline ?? null,
      passed: s.passed === true,
      errored: Boolean(s.error),
      failedGating: (s.assertions ?? []).filter((a) => a.passed === false && a.gating !== false).map((a) => a.id),
      knownGaps: (s.assertions ?? []).filter((a) => a.passed === false && a.gating === false).map((a) => a.id),
      judgeScores: s.judge?.scores ?? null,
    })),
  };
}

/** passed only when every scenario passed and there was at least one. */
export function verdict(t: RunTotals): 'passed' | 'failed' {
  return t.scenariosTotal > 0 && t.scenariosFailed === 0 ? 'passed' : 'failed';
}

export interface ClientEnv {
  url: string | null;
  token: string | null;
  environment: string | null;
  triggeredBy: string;
  gitSha: string | null;
  resultUrl: string | null;
}

export function clientEnv(env: NodeJS.ProcessEnv = process.env): ClientEnv {
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;
  const event = env.GITHUB_EVENT_NAME;
  const triggeredBy = event
    ? `github-actions:${event}${event === 'workflow_dispatch' && env.GITHUB_ACTOR ? `:${env.GITHUB_ACTOR}` : ''}`
    : `manual:${env.USER ?? 'unknown'}`;
  return {
    url: env.REDTEAM_CONFIG_EVAL_URL ? env.REDTEAM_CONFIG_EVAL_URL.replace(/\/+$/, '') : null,
    token: env.REDTEAM_CONFIG_EVAL_TOKEN || null,
    environment: env.REDTEAM_ENVIRONMENT || null,
    triggeredBy,
    // The workflow checks out the environment's branch (prod -> `prod`), so the
    // commit it evaluates is passed explicitly rather than taken from GITHUB_SHA.
    gitSha: env.REDTEAM_GIT_SHA || env.GITHUB_SHA || null,
    resultUrl: runUrl,
  };
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

async function call(
  env: ClientEnv,
  fetchImpl: FetchLike,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetchImpl(`${env.url}/api/redteam/config-eval${route}`, {
    method,
    headers: {
      authorization: `Bearer ${env.token}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { error: `non-JSON response (${text.slice(0, 80)})` };
  }
  return { status: res.status, json };
}

export interface Io {
  log: (msg: string) => void;
  output: (key: string, value: string) => void;
}

const notConfigured = (env: ClientEnv, io: Io): boolean => {
  if (env.url && env.token) return false;
  io.log(
    `::notice::redteam-config: ${env.environment ?? 'environment'} is not configured (${!env.url ? 'URL' : 'token secret'} missing); skipping. See docs/redteam.md "Config drift gate".`,
  );
  io.output('configured', 'false');
  return true;
};

export async function runStatus(env: ClientEnv, fetchImpl: FetchLike, io: Io): Promise<number> {
  if (notConfigured(env, io)) return 0;
  io.output('configured', 'true');
  const { status, json } = await call(env, fetchImpl, 'GET', '/status');
  if (status !== 200) {
    io.log(
      `::warning::redteam-config: status call to ${env.environment} returned ${status}: ${String(json.error ?? '')}`,
    );
    io.output('should_run', 'false');
    return status === 404 ? 0 : 1;
  }
  const fp = String(json.fingerprint ?? '').slice(0, 12);
  io.log(
    `${env.environment}: fingerprint ${fp} state=${String(json.state)} should_run=${String(json.should_run)} reason=${String(json.reason)} runs_last_24h=${String(json.runs_last_24h)}/${String(json.daily_cap)}`,
  );
  io.output('should_run', json.should_run === true ? 'true' : 'false');
  return 0;
}

export async function runClaim(
  env: ClientEnv,
  fetchImpl: FetchLike,
  io: Io,
  opts: { snapshotOut: string; force: boolean },
): Promise<number> {
  if (notConfigured(env, io)) return 0;
  const { status, json } = await call(env, fetchImpl, 'POST', '/claim', {
    suite: 'full',
    triggered_by: env.triggeredBy,
    git_sha: env.gitSha,
    result_url: env.resultUrl,
    environment: env.environment,
    force: opts.force,
  });
  if (status === 409 || status === 429) {
    io.log(`${env.environment}: not claimed (${String(json.reason)}); nothing to run`);
    io.output('claimed', 'false');
    return 0;
  }
  if (status !== 201) {
    io.log(`::error::redteam-config: claim on ${env.environment} returned ${status}: ${String(json.error ?? '')}`);
    io.output('claimed', 'false');
    return 1;
  }
  const evaluation = json.evaluation as { id: number } | undefined;
  const snapshot = json.snapshot as { fingerprint: string } | undefined;
  if (!evaluation || !snapshot) {
    io.log('::error::redteam-config: claim response without evaluation/snapshot');
    return 1;
  }
  fs.mkdirSync(path.dirname(path.resolve(opts.snapshotOut)), { recursive: true });
  fs.writeFileSync(opts.snapshotOut, JSON.stringify(snapshot), { mode: 0o600 });
  io.log(
    `${env.environment}: claimed evaluation #${evaluation.id} for fingerprint ${snapshot.fingerprint.slice(0, 12)}`,
  );
  io.output('claimed', 'true');
  io.output('evaluation_id', String(evaluation.id));
  io.output('fingerprint', snapshot.fingerprint);
  return 0;
}

export async function runFinish(
  env: ClientEnv,
  fetchImpl: FetchLike,
  io: Io,
  opts: { id: number; fingerprint: string; resultsDir: string; error: string | null },
): Promise<number> {
  if (notConfigured(env, io)) return 0;
  let body: Record<string, unknown>;
  const summaryPath = path.join(opts.resultsDir, 'summary.json');
  const loadedPath = path.join(opts.resultsDir, 'config-snapshot.json');
  let failure = opts.error;
  let totals: RunTotals | null = null;
  if (!failure) {
    try {
      const loaded = JSON.parse(fs.readFileSync(loadedPath, 'utf8')) as { fingerprint?: string };
      if (loaded.fingerprint !== opts.fingerprint)
        failure = 'harness loaded a different configuration than was claimed';
      totals = totalsFromSummary(JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as SummaryJsonLike);
    } catch (err) {
      failure = `no usable results: ${(err as Error).message}`;
    }
  }
  if (failure || !totals) {
    body = { status: 'error', error: failure ?? 'no results', git_sha: env.gitSha, result_url: env.resultUrl };
  } else {
    body = {
      status: verdict(totals),
      scenarios_total: totals.scenariosTotal,
      scenarios_passed: totals.scenariosPassed,
      scenarios_failed: totals.scenariosFailed,
      known_gaps: totals.knownGaps,
      est_cost_usd: totals.estCostUsd,
      git_sha: env.gitSha,
      result_url: env.resultUrl,
    };
  }
  const { status, json } = await call(env, fetchImpl, 'POST', `/evaluations/${opts.id}/finish`, body);
  if (status !== 200) {
    io.log(
      `::error::redteam-config: recording result on ${env.environment} returned ${status}: ${String(json.error ?? '')}`,
    );
    return 1;
  }
  io.log(
    `${env.environment}: evaluation #${opts.id} recorded as ${String(body.status)}` +
      (totals ? ` (${totals.scenariosPassed}/${totals.scenariosTotal} passed, ${totals.knownGaps} known gaps)` : ''),
  );
  io.output('result', String(body.status));
  return 0;
}

function arg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const env = clientEnv();
  const io: Io = {
    log: (m) => console.log(m),
    output: (k, v) => {
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
    },
  };
  const fetchImpl = fetch as unknown as FetchLike;
  let code = 2;
  if (command === 'status') code = await runStatus(env, fetchImpl, io);
  else if (command === 'claim') {
    code = await runClaim(env, fetchImpl, io, {
      snapshotOut: arg(rest, '--snapshot-out') ?? 'config-snapshot.json',
      force: rest.includes('--force'),
    });
  } else if (command === 'finish') {
    const id = Number(arg(rest, '--id'));
    const fingerprint = arg(rest, '--fingerprint') ?? '';
    if (!Number.isInteger(id) || id <= 0 || !fingerprint) {
      console.error('finish needs --id <n> --fingerprint <fp>');
    } else {
      code = await runFinish(env, fetchImpl, io, {
        id,
        fingerprint,
        resultsDir: arg(rest, '--results') ?? 'redteam-results',
        error: arg(rest, '--error'),
      });
    }
  } else if (command === 'redact') {
    const dir = arg(rest, '--results') ?? 'redteam-results';
    const out = arg(rest, '--out') ?? 'redteam-config-results/summary.json';
    try {
      const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')) as FullSummaryLike;
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(redactSummary(summary), null, 2) + '\n');
      code = 0;
    } catch (err) {
      console.log(`no summary to redact: ${(err as Error).message}`);
      code = 0;
    }
  } else {
    console.error(
      'usage: configEvalClient.ts status | claim --snapshot-out <file> [--force] | finish --id <n> --fingerprint <fp>',
    );
  }
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
