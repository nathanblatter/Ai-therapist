// Workflow client for the config-eval API: totals and verdict from
// summary.json, the public-log redaction, and the skip-cleanly paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  clientEnv,
  redactSummary,
  runClaim,
  runFinish,
  runStatus,
  totalsFromSummary,
  verdict,
  type ClientEnv,
  type Io,
} from './configEvalClient.js';

const SUMMARY = {
  suite: 'full',
  totals: { estCostUsd: 0.2412 },
  scenarios: [
    {
      id: 'crisis-ladder',
      pipeline: 'chat',
      passed: true,
      transcript: [{ role: 'assistant', text: 'VERBATIM PROMPT FRAGMENT' }],
      assertions: [
        { id: 'a1', passed: true, gating: true, detail: 'ok' },
        { id: 'gap-1', passed: false, gating: false, detail: 'reply quoted: VERBATIM' },
      ],
      judge: { scores: { safety: 5 } },
    },
    {
      id: 'prompt-injection',
      pipeline: 'chat',
      passed: false,
      assertions: [{ id: 'no-leak', passed: false, gating: true, detail: 'leaked VERBATIM' }],
    },
  ],
};

function io(): Io & { lines: string[]; outputs: Record<string, string> } {
  const lines: string[] = [];
  const outputs: Record<string, string> = {};
  return { lines, outputs, log: (m) => lines.push(m), output: (k, v) => (outputs[k] = v) };
}

const ENV: ClientEnv = {
  url: 'https://stage.example',
  token: 'secret-token',
  environment: 'stage',
  triggeredBy: 'github-actions:schedule',
  gitSha: 'abc1234',
  resultUrl: 'https://github.com/o/r/actions/runs/1',
};

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async () => ({ status, text: async () => JSON.stringify(body) }));
}

describe('totalsFromSummary / verdict', () => {
  it('counts scenarios and non-gating failures as known gaps', () => {
    const t = totalsFromSummary(SUMMARY);
    expect(t).toEqual({ scenariosTotal: 2, scenariosPassed: 1, scenariosFailed: 1, knownGaps: 1, estCostUsd: 0.2412 });
    expect(verdict(t)).toBe('failed');
    expect(verdict({ ...t, scenariosPassed: 2, scenariosFailed: 0 })).toBe('passed');
    expect(verdict(totalsFromSummary({ scenarios: [] }))).toBe('failed');
  });
});

describe('redactSummary', () => {
  it('keeps verdicts, assertion ids and scores; drops transcripts and details', () => {
    const r = redactSummary(SUMMARY);
    expect(JSON.stringify(r)).not.toContain('VERBATIM');
    expect(r.scenarios).toEqual([
      {
        id: 'crisis-ladder',
        pipeline: 'chat',
        passed: true,
        errored: false,
        failedGating: [],
        knownGaps: ['gap-1'],
        judgeScores: { safety: 5 },
      },
      {
        id: 'prompt-injection',
        pipeline: 'chat',
        passed: false,
        errored: false,
        failedGating: ['no-leak'],
        knownGaps: [],
        judgeScores: null,
      },
    ]);
  });
});

describe('clientEnv', () => {
  it('builds provenance from the GitHub variables and prefers the evaluated commit', () => {
    const e = clientEnv({
      REDTEAM_CONFIG_EVAL_URL: 'https://x.example/',
      REDTEAM_CONFIG_EVAL_TOKEN: 't',
      REDTEAM_ENVIRONMENT: 'prod',
      REDTEAM_GIT_SHA: 'def5678',
      GITHUB_SHA: 'abc1234',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_ACTOR: 'someone',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '42',
    });
    expect(e).toEqual({
      url: 'https://x.example',
      token: 't',
      environment: 'prod',
      triggeredBy: 'github-actions:workflow_dispatch:someone',
      gitSha: 'def5678',
      resultUrl: 'https://github.com/o/r/actions/runs/42',
    });
  });
});

describe('skip cleanly while not configured', () => {
  it('status/claim/finish exit 0 with a notice and never call out', async () => {
    const f = fetchReturning(200, {});
    for (const run of [
      (o: Io) => runStatus({ ...ENV, token: null }, f, o),
      (o: Io) => runClaim({ ...ENV, token: null }, f, o, { snapshotOut: 'x', force: false }),
      (o: Io) => runFinish({ ...ENV, url: null }, f, o, { id: 1, fingerprint: 'f', resultsDir: '.', error: null }),
    ]) {
      const o = io();
      expect(await run(o)).toBe(0);
      expect(o.lines[0]).toMatch(/::notice::.*not configured/);
      expect(o.outputs.configured).toBe('false');
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('status treats a 404 (server without the token yet) as "do not run", not a failure', async () => {
    const o = io();
    expect(await runStatus(ENV, fetchReturning(404, { error: 'Not found' }), o)).toBe(0);
    expect(o.outputs.should_run).toBe('false');
  });
});

describe('runStatus / runClaim / runFinish', () => {
  it('status sends the bearer token and reports should_run', async () => {
    const f = fetchReturning(200, { fingerprint: 'f'.repeat(64), state: 'unevaluated', should_run: true });
    const o = io();
    expect(await runStatus(ENV, f, o)).toBe(0);
    expect(o.outputs.should_run).toBe('true');
    expect(f).toHaveBeenCalledWith('https://stage.example/api/redteam/config-eval/status', {
      method: 'GET',
      headers: { authorization: 'Bearer secret-token', accept: 'application/json' },
    });
    expect(o.lines.join('\n')).not.toContain('secret-token');
  });

  it('claim writes the snapshot file and outputs the id; a refusal is a clean no-op', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgclient-'));
    const out = path.join(dir, 'snap.json');
    const o = io();
    const snapshot = { fingerprint: 'f'.repeat(64), config: { system_prompts: { chat: { prompt: 'SECRET PROMPT' } } } };
    expect(
      await runClaim(ENV, fetchReturning(201, { evaluation: { id: 7 }, snapshot }), o, {
        snapshotOut: out,
        force: true,
      }),
    ).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(snapshot);
    expect(o.outputs).toMatchObject({ claimed: 'true', evaluation_id: '7', fingerprint: 'f'.repeat(64) });
    expect(o.lines.join('\n')).not.toContain('SECRET PROMPT');

    const o2 = io();
    expect(
      await runClaim(ENV, fetchReturning(409, { reason: 'already_passed' }), o2, { snapshotOut: out, force: false }),
    ).toBe(0);
    expect(o2.outputs.claimed).toBe('false');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finish posts totals from the run, or an error when the harness did not load the claimed config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgclient-'));
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(SUMMARY));
    fs.writeFileSync(path.join(dir, 'config-snapshot.json'), JSON.stringify({ fingerprint: 'f'.repeat(64) }));

    const f = fetchReturning(200, { evaluation: { id: 7 } });
    expect(await runFinish(ENV, f, io(), { id: 7, fingerprint: 'f'.repeat(64), resultsDir: dir, error: null })).toBe(0);
    const [url, init] = f.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://stage.example/api/redteam/config-eval/evaluations/7/finish');
    expect(JSON.parse(init.body)).toEqual({
      status: 'failed',
      scenarios_total: 2,
      scenarios_passed: 1,
      scenarios_failed: 1,
      known_gaps: 1,
      est_cost_usd: 0.2412,
      git_sha: 'abc1234',
      result_url: 'https://github.com/o/r/actions/runs/1',
    });

    const f2 = fetchReturning(200, {});
    await runFinish(ENV, f2, io(), { id: 7, fingerprint: 'e'.repeat(64), resultsDir: dir, error: null });
    expect(JSON.parse((f2.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toMatchObject({
      status: 'error',
      error: 'harness loaded a different configuration than was claimed',
    });

    const f3 = fetchReturning(200, {});
    await runFinish(ENV, f3, io(), { id: 7, fingerprint: 'f', resultsDir: path.join(dir, 'none'), error: null });
    expect(JSON.parse((f3.mock.calls[0] as unknown as [string, { body: string }])[1].body).status).toBe('error');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
