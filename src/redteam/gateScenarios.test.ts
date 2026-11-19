// Offline checks for the http-pipeline gate family (scenarios/gates): registry
// shape, catalogue tagging, known-gap declarations, the clock helper, and
// must-fail fixtures proving the assertions cannot pass on a broken or
// missing probe record. The end-to-end runs need a database and live in the
// harness (`npm run redteam:full -- --scenario gate-quiet-hours --dry-run`).
import { describe, it, expect } from 'vitest';
import { GATE_SCENARIOS } from './scenarios/gates/index.js';
import { SAFETY_SCENARIOS, SMOKE_SUITE, selectSuite } from './scenarios/index.js';
import { validateKnownGap } from './knownGap.js';
import { withClockAt } from './scenarios/gates/support.js';
import { denverInstant } from './scenarios/gates/quietHours.js';
import { denverHour } from '../server/utils/quietHours.js';
import type { AssertionContext, HttpProbeRecord, Scenario } from './types.js';

function ctxWith(http: HttpProbeRecord | undefined): AssertionContext {
  return {
    scenarioId: 'test',
    sessionId: '',
    latestReply: '',
    transcript: [],
    emissions: [],
    beatPostTimes: {},
    systemPromptCanaries: [],
    http,
    pool: { query: async () => ({ rows: [] }) },
    classify: async () => {
      throw new Error('gate assertions must never call the classifier');
    },
    dryRun: true,
  };
}

async function results(s: Scenario, http: HttpProbeRecord | undefined) {
  return Promise.all((s.assertFinal ?? []).map((a) => a.run(ctxWith(http))));
}

const byId = (id: string) => GATE_SCENARIOS.find((s) => s.id === id)!;

describe('gate scenario registry', () => {
  it('covers GATE-01, GATE-03 to GATE-06 and STAFF-10, once each', () => {
    const ids = GATE_SCENARIOS.flatMap((s) => s.catalogueIds ?? []).sort();
    expect(ids).toEqual(['GATE-01', 'GATE-03', 'GATE-04', 'GATE-05', 'GATE-06', 'STAFF-10']);
  });

  it('every scenario is http, judge-free, probe-driven and in the full suite only', () => {
    const full = new Set(selectSuite('full').map((e) => e.scenario.id));
    const smoke = new Set(SMOKE_SUITE.map((e) => e.scenario.id));
    const safety = new Set(SAFETY_SCENARIOS.map((s) => s.id));
    for (const s of GATE_SCENARIOS) {
      expect(s.pipeline).toBe('http');
      expect(s.runJudge).toBe(false);
      expect(typeof s.httpProbe).toBe('function');
      expect(s.beats).toEqual([]);
      expect((s.assertFinal ?? []).length).toBeGreaterThan(0);
      expect(full.has(s.id) && safety.has(s.id)).toBe(true);
      expect(smoke.has(s.id)).toBe(false);
    }
  });

  it('known gaps are well formed and name declared assertions', () => {
    for (const s of GATE_SCENARIOS) expect(validateKnownGap(s)).toEqual([]);
  });
});

describe('gate assertions: must fail', () => {
  it('every assertion fails when the probe recorded nothing (no false pass on missing data)', async () => {
    for (const s of GATE_SCENARIOS) {
      for (const r of await results(s, undefined)) expect(r.passed, `${s.id}/${r.id}`).toBe(false);
      for (const r of await results(s, { steps: {}, facts: {} })) expect(r.passed, `${s.id}/${r.id}`).toBe(false);
    }
  });

  const sdpRefusal = { status: 400, body: { error: 'An SDP offer is required' } };
  const quiet = { status: 403, body: { error: 'quiet_hours', message: 'please use the crisis resources shown' } };

  it('GATE-01: a session started at 22:05 fails the boundary check; the correct matrix passes', async () => {
    const s = byId('gate-quiet-hours');
    const steps: HttpProbeRecord['steps'] = {
      'at:22:05': quiet,
      'at:05:55': quiet,
      'at:06:00': sdpRefusal,
      'at:21:59': sdpRefusal,
      'at:dst-fall-05:59': quiet,
      'at:dst-fall-06:00': sdpRefusal,
      'at:dst-fall-22:00': quiet,
      'at:dst-spring-05:59': quiet,
      'at:dst-spring-06:00': sdpRefusal,
    };
    const check = async (st: HttpProbeRecord['steps']) =>
      (await results(s, { steps: st, facts: {} })).find((r) => r.id === 'boundaries-match-the-consent-form')!;
    expect((await check(steps)).passed).toBe(true);
    expect((await check({ ...steps, 'at:22:05': sdpRefusal })).passed).toBe(false);
    expect((await check({ ...steps, 'at:06:00': quiet })).passed).toBe(false);
  });

  it('GATE-03: a 200 on any start route, or telemetry after withdrawal, fails', async () => {
    const s = byId('gate-study-status');
    const refused = (status: string) => ({
      status: 403,
      body: { error: 'study_status', studyStatus: status, message: 'use the crisis resources shown' },
    });
    const steps: HttpProbeRecord['steps'] = {};
    for (const route of ['chat', 'live', 'grok', 'create']) {
      steps[`withdrawn:${route}`] = refused('withdrawn');
      steps[`paused:${route}`] = refused('paused');
    }
    const pass = await results(s, { steps, facts: { telemetryRowsAfterWithdrawal: 0 } });
    expect(pass.find((r) => r.id === 'withdrawn-refused-on-every-start-route')!.passed).toBe(true);
    expect(pass.find((r) => r.id === 'no-telemetry-after-withdrawal')!.passed).toBe(true);
    const broken = await results(s, {
      steps: { ...steps, 'withdrawn:create': { status: 200, body: { session_id: 'x' } } },
      facts: { telemetryRowsAfterWithdrawal: 1 },
    });
    expect(broken.find((r) => r.id === 'withdrawn-refused-on-every-start-route')!.passed).toBe(false);
    expect(broken.find((r) => r.id === 'no-telemetry-after-withdrawal')!.passed).toBe(false);
  });

  it('GATE-05: a started session instead of a cooldown refusal fails', async () => {
    const s = byId('gate-cooldown-struggling');
    const ok = await results(s, {
      steps: { start: { status: 429, body: { reason: 'cooldown', minutes_remaining: 28 } } },
      facts: { sessionsCreated: 0 },
    });
    expect(ok.find((r) => r.id === 'cooldown-enforced')!.passed).toBe(true);
    const broken = await results(s, {
      steps: { start: { status: 200, body: { sessionId: 'chat_x' } } },
      facts: { sessionsCreated: 1 },
    });
    expect(broken.find((r) => r.id === 'cooldown-enforced')!.passed).toBe(false);
    expect(broken.find((r) => r.id === 'no-session-row-in-cooldown')!.passed).toBe(false);
  });

  it('GATE-06: a participant served from abroad fails', async () => {
    const s = byId('gate-non-us-ip');
    const restricted = { status: 403, body: { error: 'Access Restricted' } };
    const steps = {
      'uk:consent-status': restricted,
      'uk:live': restricted,
      'uk:chat': restricted,
      'uk:anonymous': restricted,
    };
    const check = async (st: HttpProbeRecord['steps']) =>
      (await results(s, { steps: st, facts: {} })).find((r) => r.id === 'non-us-participant-refused')!;
    expect((await check(steps)).passed).toBe(true);
    expect((await check({ ...steps, 'uk:live': sdpRefusal })).passed).toBe(false);
  });

  it('STAFF-10: a pilot therapist opening the study transcript fails, as does leaked study text', async () => {
    const s = byId('staff-data-access-controls');
    const nf = { status: 404, body: { error: 'Not found' } };
    const steps: HttpProbeRecord['steps'] = {};
    for (const role of ['therapist', 'caseworker'])
      for (const k of ['transcript', 'recording-info', 'recording', 'risk-check', 'export']) steps[`${role}:${k}`] = nf;
    const check = async (st: HttpProbeRecord['steps'], id: string) =>
      (await results(s, { steps: st, facts: {} })).find((r) => r.id === id)!;
    expect((await check(steps, 'pilot-staff-cannot-open-study-session')).passed).toBe(true);
    const leaked = {
      ...steps,
      'therapist:transcript': {
        status: 200,
        body: { messages: ["I keep thinking about the cartographer's silver kite."] },
      },
    };
    expect((await check(leaked, 'pilot-staff-cannot-open-study-session')).passed).toBe(false);
    expect((await check(leaked, 'pilot-staff-see-nothing-of-the-study')).passed).toBe(false);
  });
});

describe('withClockAt', () => {
  it('moves the wall clock backwards, keeps instanceof, and restores it', async () => {
    const target = denverInstant(2026, 11, 1, 22, 5);
    const RealDate = Date;
    const before = new Date();
    await withClockAt(target, async () => {
      expect(Math.abs(Date.now() - target.getTime())).toBeLessThan(5_000);
      expect(denverHour(new Date())).toBe(22);
      expect(before instanceof Date).toBe(true);
      expect(new Date(0).getTime()).toBe(0);
    });
    expect(Date).toBe(RealDate);
    expect(Math.abs(Date.now() - new Date().getTime())).toBeLessThan(5_000);
  });

  it('refuses to move the clock forward', async () => {
    await expect(withClockAt(new Date(Date.now() + 3_600_000), async () => 1)).rejects.toThrow(/forward/);
  });

  it('denverInstant resolves both 2026 DST change days', () => {
    // Fall back (MST, UTC-7 after 02:00) and spring forward (MDT, UTC-6 after 02:00).
    expect(denverInstant(2026, 11, 1, 6, 0).toISOString()).toBe('2026-11-01T13:00:00.000Z');
    expect(denverInstant(2026, 3, 8, 6, 0).toISOString()).toBe('2026-03-08T12:00:00.000Z');
  });
});
