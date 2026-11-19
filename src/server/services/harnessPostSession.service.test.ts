// The harness post-session gate (ai-therapist-383). It must NEVER match a real
// participant: it needs the harness-process signal AND a reserved-range user,
// and anything else (either missing, a failed lookup, no row) runs the jobs
// exactly as before. Exercised through the real entry points: redactSession,
// generateSessionNameAsync, generateSessionInsightsAsync.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryMock, redactBatchMock, getSessionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  redactBatchMock: vi.fn(async () => new Map<number, string>()),
  getSessionMock: vi.fn(async () => null),
}));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn(), on: vi.fn() } }));
vi.mock('./redaction.service.js', () => ({ redactPHIBatch: redactBatchMock }));
vi.mock('../db/index.js', () => ({
  getSession: getSessionMock,
  getSessionMessages: vi.fn(async () => []),
  updateSessionName: vi.fn(),
  recordLlmUsage: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import {
  HARNESS_PROCESS_ENV,
  REDTEAM_TRIGGER_ENV,
  RESERVED_PARTICIPANT_USERID_MIN,
  harnessProcessSignalOn,
  setHarnessProcessSignal,
  _resetHarnessPostSessionForTests,
  optInPostSessionWork,
  shouldSkipPostSessionWork,
  skippedPostSessionSessions,
} from './harnessPostSession.service.js';
import { RESERVED_PARTICIPANT_USERID_MIN as REDTEAM_MIN } from '../../redteam/participantIdentity.js';
import { redactSession } from './sessionRedaction.service.js';
import { generateSessionNameAsync } from './sessionName.service.js';
import { generateSessionInsightsAsync } from './sessionInsights.service.js';

const HARNESS_USER = RESERVED_PARTICIPANT_USERID_MIN + 7;
const REAL_USER = 42;
const savedNodeEnv = process.env.NODE_ENV;
const savedTrigger = process.env[REDTEAM_TRIGGER_ENV];

/** therapy_sessions lookup answers with `userId`; the redaction job's message
 *  read answers one unredacted row so a run is visible as a redactPHIBatch call. */
function db(userId: number | null) {
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM therapy_sessions WHERE session_id/.test(sql)) return { rows: [{ user_id: userId }] };
    if (/SELECT message_id, content/.test(sql)) return { rows: [{ message_id: 1, content: 'hello' }] };
    return { rows: [] };
  });
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetHarnessPostSessionForTests();
  queryMock.mockReset();
  redactBatchMock.mockClear();
  getSessionMock.mockClear();
  delete process.env[HARNESS_PROCESS_ENV];
  delete process.env[REDTEAM_TRIGGER_ENV];
  process.env.NODE_ENV = 'test';
});
afterEach(() => {
  delete process.env[HARNESS_PROCESS_ENV];
  if (savedTrigger === undefined) delete process.env[REDTEAM_TRIGGER_ENV];
  else process.env[REDTEAM_TRIGGER_ENV] = savedTrigger;
  process.env.NODE_ENV = savedNodeEnv;
});

describe('the in-app runner (REDTEAM_TRIGGER present) never has the signal on', () => {
  // Its child runs against a deployment's live database and inherits the
  // container's environment: a leaked REDTEAM_HARNESS_PROCESS must not reach
  // the gate there, at either layer.
  const TRIGGERS = ['nightly', 'admin', 'ci-voice', ''];

  it('setHarnessProcessSignal deletes a leaked signal when REDTEAM_TRIGGER is present', () => {
    for (const trigger of TRIGGERS) {
      const env: NodeJS.ProcessEnv = { [REDTEAM_TRIGGER_ENV]: trigger, [HARNESS_PROCESS_ENV]: '1', NODE_ENV: 'test' };
      setHarnessProcessSignal(env);
      expect(HARNESS_PROCESS_ENV in env).toBe(false);
      expect(harnessProcessSignalOn(env)).toBe(false);
    }
  });

  it('setHarnessProcessSignal turns it on for a standalone CLI run', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    setHarnessProcessSignal(env);
    expect(env[HARNESS_PROCESS_ENV]).toBe('1');
    expect(harnessProcessSignalOn(env)).toBe(true);
  });

  it('the gate treats the signal as off while REDTEAM_TRIGGER is present, even if it is set', async () => {
    for (const trigger of TRIGGERS) {
      _resetHarnessPostSessionForTests();
      process.env[HARNESS_PROCESS_ENV] = '1';
      process.env[REDTEAM_TRIGGER_ENV] = trigger;
      db(HARNESS_USER);
      expect(await shouldSkipPostSessionWork(`t-${trigger}`, 'redaction')).toBe(false);
      expect(queryMock).not.toHaveBeenCalled();
    }
  });

  it('cli.ts sets the signal only through setHarnessProcessSignal(process.env)', () => {
    const src = readFileSync(new URL('../../redteam/cli.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/^setHarnessProcessSignal\(process\.env\);$/m);
    // No other write to the variable anywhere in the CLI.
    expect(src).not.toMatch(/REDTEAM_HARNESS_PROCESS\s*=|\[\s*['"]REDTEAM_HARNESS_PROCESS['"]\s*\]\s*=/);
  });
});

describe('shouldSkipPostSessionWork', () => {
  it('the redteam constant is the same value (one source of truth)', () => {
    expect(REDTEAM_MIN).toBe(RESERVED_PARTICIPANT_USERID_MIN);
  });

  it('normal process: never skips, and does not even look the session up', async () => {
    db(HARNESS_USER);
    expect(await shouldSkipPostSessionWork('s1', 'redaction')).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('harness process + reserved-range user: skips, logs one line, and reports the session', async () => {
    process.env[HARNESS_PROCESS_ENV] = '1';
    db(HARNESS_USER);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await shouldSkipPostSessionWork('s1', 'redaction')).toBe(true);
    expect(await shouldSkipPostSessionWork('s1', 'naming')).toBe(true);
    expect(await shouldSkipPostSessionWork('s1', 'insights')).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1); // decided once per session
    expect(log.mock.calls.filter((c) => String(c[0]).startsWith('[post-session] skipped'))).toHaveLength(1);
    expect(skippedPostSessionSessions()).toEqual(['s1']);
    log.mockRestore();
  });

  it('harness process + REAL user: runs', async () => {
    process.env[HARNESS_PROCESS_ENV] = '1';
    db(REAL_USER);
    expect(await shouldSkipPostSessionWork('s1', 'redaction')).toBe(false);
    expect(skippedPostSessionSessions()).toEqual([]);
  });

  it('harness process + the first reserved id: skips (the range is inclusive)', async () => {
    process.env[HARNESS_PROCESS_ENV] = '1';
    db(RESERVED_PARTICIPANT_USERID_MIN);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await shouldSkipPostSessionWork('s1', 'redaction')).toBe(true);
    vi.mocked(console.log).mockRestore();
  });

  it('harness process + user just below the range: runs', async () => {
    process.env[HARNESS_PROCESS_ENV] = '1';
    db(RESERVED_PARTICIPANT_USERID_MIN - 1);
    expect(await shouldSkipPostSessionWork('s1', 'redaction')).toBe(false);
  });

  it('the signal must be exactly "1"', async () => {
    process.env[HARNESS_PROCESS_ENV] = 'true';
    db(HARNESS_USER);
    expect(await shouldSkipPostSessionWork('s1', 'redaction')).toBe(false);
  });

  it('ignored under NODE_ENV=production even if the variable leaked into a deployment', async () => {
    process.env[HARNESS_PROCESS_ENV] = '1';
    process.env.NODE_ENV = 'production';
    db(HARNESS_USER);
    expect(await shouldSkipPostSessionWork('s1', 'redaction')).toBe(false);
  });

  it('a session the scenario opted in runs', async () => {
    process.env[HARNESS_PROCESS_ENV] = '1';
    db(HARNESS_USER);
    optInPostSessionWork('s1');
    expect(await shouldSkipPostSessionWork('s1', 'redaction')).toBe(false);
    expect(queryMock).not.toHaveBeenCalled(); // no lookup needed
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await shouldSkipPostSessionWork('s2', 'redaction')).toBe(true);
    vi.mocked(console.log).mockRestore();
    // An opt-in always wins, even after a skip decision was cached.
    optInPostSessionWork('s2');
    expect(await shouldSkipPostSessionWork('s2', 'insights')).toBe(false);
  });

  it('any doubt runs the job: lookup error, no row, NULL user', async () => {
    process.env[HARNESS_PROCESS_ENV] = '1';
    queryMock.mockRejectedValueOnce(new Error('db down'));
    expect(await shouldSkipPostSessionWork('a', 'redaction')).toBe(false);
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await shouldSkipPostSessionWork('b', 'redaction')).toBe(false);
    queryMock.mockResolvedValueOnce({ rows: [{ user_id: null }] });
    expect(await shouldSkipPostSessionWork('c', 'redaction')).toBe(false);
  });
});

describe('every post-session entry point honours the gate', () => {
  it('a REAL-user session in a harness process is still redacted, named and summarised', async () => {
    process.env[HARNESS_PROCESS_ENV] = '1';
    db(REAL_USER);
    await redactSession('real-1');
    expect(redactBatchMock).toHaveBeenCalledTimes(1);
    generateSessionNameAsync('real-1');
    generateSessionInsightsAsync('real-1');
    await flush();
    await flush();
    expect(getSessionMock).toHaveBeenCalledTimes(2); // naming and insights both started
  });

  it('a HARNESS-user session in a normal process is still redacted, named and summarised', async () => {
    db(HARNESS_USER);
    await redactSession('h-1');
    expect(redactBatchMock).toHaveBeenCalledTimes(1);
    generateSessionNameAsync('h-1');
    generateSessionInsightsAsync('h-1');
    await flush();
    await flush();
    expect(getSessionMock).toHaveBeenCalledTimes(2);
  });

  it('a harness-user session in a harness process skips redaction (and so the leak check), naming and insights', async () => {
    process.env[HARNESS_PROCESS_ENV] = '1';
    db(HARNESS_USER);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await redactSession('h-2');
    expect(redactBatchMock).not.toHaveBeenCalled();
    generateSessionNameAsync('h-2');
    generateSessionInsightsAsync('h-2');
    await flush();
    await flush();
    expect(getSessionMock).not.toHaveBeenCalled();
    vi.mocked(console.log).mockRestore();
  });

  it('an opted-in harness session keeps all of it', async () => {
    process.env[HARNESS_PROCESS_ENV] = '1';
    db(HARNESS_USER);
    optInPostSessionWork('h-3');
    await redactSession('h-3');
    expect(redactBatchMock).toHaveBeenCalledTimes(1);
    generateSessionNameAsync('h-3');
    generateSessionInsightsAsync('h-3');
    await flush();
    await flush();
    expect(getSessionMock).toHaveBeenCalledTimes(2);
  });
});
