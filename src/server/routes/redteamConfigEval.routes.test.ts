// Token-gated machine API for the redteam-config workflow: absent token =
// no surface, wrong token = 401, inputs validated, no usernames leaked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const svc = vi.hoisted(() => ({
  getConfigEvalStatus: vi.fn(),
  claimConfigEvaluation: vi.fn(),
  finishConfigEvaluation: vi.fn(),
}));
vi.mock('../services/configEvaluation.service.js', () => svc);

import redteamConfigEvalRoutes from './redteamConfigEval.routes.js';

const TOKEN = 't'.repeat(40);
const RUN_URL = 'https://github.com/nathanblatter/Ai-therapist/actions/runs/123';

function app() {
  const a = express();
  a.use(express.json());
  a.use(redteamConfigEvalRoutes());
  return a;
}
const auth = { Authorization: `Bearer ${TOKEN}` };

beforeEach(() => {
  process.env.REDTEAM_CONFIG_EVAL_TOKEN = TOKEN;
  for (const fn of Object.values(svc)) fn.mockReset();
  svc.getConfigEvalStatus.mockResolvedValue({
    fingerprint: 'f'.repeat(64),
    state: 'unevaluated',
    last_change: { at: '2026-11-18T10:00:00Z', by: 'researcher_a', key: 'system_prompts' },
    should_run: true,
  });
});
afterEach(() => {
  delete process.env.REDTEAM_CONFIG_EVAL_TOKEN;
});

describe('token gate', () => {
  it('404s every route while the token is unset or too short', async () => {
    delete process.env.REDTEAM_CONFIG_EVAL_TOKEN;
    expect((await request(app()).get('/api/redteam/config-eval/status').set(auth)).status).toBe(404);
    process.env.REDTEAM_CONFIG_EVAL_TOKEN = 'short';
    expect((await request(app()).post('/api/redteam/config-eval/claim').set(auth).send({})).status).toBe(404);
    expect(svc.claimConfigEvaluation).not.toHaveBeenCalled();
  });

  it('401s a missing or wrong bearer token', async () => {
    expect((await request(app()).get('/api/redteam/config-eval/status')).status).toBe(401);
    const wrong = await request(app())
      .get('/api/redteam/config-eval/status')
      .set({ Authorization: `Bearer ${'x'.repeat(40)}` });
    expect(wrong.status).toBe(401);
    expect(svc.getConfigEvalStatus).not.toHaveBeenCalled();
  });
});

describe('GET status', () => {
  it('returns the drift state without the staff username', async () => {
    const res = await request(app()).get('/api/redteam/config-eval/status').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.should_run).toBe(true);
    expect(res.body.last_change).toEqual({ at: '2026-11-18T10:00:00Z', by: null, key: 'system_prompts' });
    expect(JSON.stringify(res.body)).not.toContain('researcher_a');
  });
});

describe('POST claim', () => {
  const body = { suite: 'full', triggered_by: 'github-actions:schedule', git_sha: 'abc1234', result_url: RUN_URL };

  it('passes a valid claim through and answers 201 with the snapshot', async () => {
    svc.claimConfigEvaluation.mockResolvedValue({
      claimed: true,
      evaluation: { id: 3 },
      snapshot: { fingerprint: 'f' },
    });
    const res = await request(app())
      .post('/api/redteam/config-eval/claim')
      .set(auth)
      .send({ ...body, environment: 'prod', force: true });
    expect(res.status).toBe(201);
    expect(svc.claimConfigEvaluation).toHaveBeenCalledWith({
      suite: 'full',
      triggeredBy: 'github-actions:schedule',
      gitSha: 'abc1234',
      resultUrl: RUN_URL,
      environment: 'prod',
      force: true,
    });
  });

  it('maps refusals to 409, the daily cap to 429', async () => {
    svc.claimConfigEvaluation.mockResolvedValueOnce({
      claimed: false,
      reason: 'in_progress',
      status: { fingerprint: 'f', state: 'running' },
    });
    expect((await request(app()).post('/api/redteam/config-eval/claim').set(auth).send(body)).status).toBe(409);
    svc.claimConfigEvaluation.mockResolvedValueOnce({
      claimed: false,
      reason: 'daily_cap',
      status: { fingerprint: 'f', state: 'unevaluated' },
    });
    const capped = await request(app()).post('/api/redteam/config-eval/claim').set(auth).send(body);
    expect(capped.status).toBe(429);
    expect(capped.body.reason).toBe('daily_cap');
  });

  it.each([
    [{ ...body, suite: 'everything' }],
    [{ ...body, triggered_by: '' }],
    [{ ...body, git_sha: 'not a sha' }],
    [{ ...body, result_url: 'https://evil.example/x' }],
  ])('rejects bad input %#', async (bad) => {
    expect((await request(app()).post('/api/redteam/config-eval/claim').set(auth).send(bad)).status).toBe(400);
    expect(svc.claimConfigEvaluation).not.toHaveBeenCalled();
  });
});

describe('POST finish', () => {
  const ok = { status: 'passed', scenarios_total: 20, scenarios_passed: 20, scenarios_failed: 0, known_gaps: 2 };

  it('records a pass', async () => {
    svc.finishConfigEvaluation.mockResolvedValue({ id: 3, status: 'passed' });
    const res = await request(app())
      .post('/api/redteam/config-eval/evaluations/3/finish')
      .set(auth)
      .send({ ...ok, est_cost_usd: 0.25, result_url: RUN_URL });
    expect(res.status).toBe(200);
    expect(svc.finishConfigEvaluation).toHaveBeenCalledWith(3, {
      status: 'passed',
      scenariosTotal: 20,
      scenariosPassed: 20,
      scenariosFailed: 0,
      knownGaps: 2,
      estCostUsd: 0.25,
      gitSha: null,
      resultUrl: RUN_URL,
      error: null,
    });
  });

  it('will not record a pass that has failures or no totals', async () => {
    const r1 = await request(app())
      .post('/api/redteam/config-eval/evaluations/3/finish')
      .set(auth)
      .send({ ...ok, scenarios_failed: 1 });
    const r2 = await request(app())
      .post('/api/redteam/config-eval/evaluations/3/finish')
      .set(auth)
      .send({ status: 'passed' });
    expect([r1.status, r2.status]).toEqual([400, 400]);
    expect(svc.finishConfigEvaluation).not.toHaveBeenCalled();
  });

  it('404s an unknown or already finished evaluation', async () => {
    svc.finishConfigEvaluation.mockResolvedValue(null);
    const res = await request(app())
      .post('/api/redteam/config-eval/evaluations/77/finish')
      .set(auth)
      .send({ status: 'error', error: 'harness crashed' });
    expect(res.status).toBe(404);
  });
});
