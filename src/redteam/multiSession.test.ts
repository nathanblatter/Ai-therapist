// Offline tests for the multi-session runner's parts: declaration checks, the
// history-ageing SQL and its guard, and the wait for the post-session summary.
import { describe, it, expect } from 'vitest';
import {
  MULTI_SESSION_USERID_MIN,
  MULTI_SESSION_USERNAME_PREFIX,
  SUMMARY_LOSS_GAP,
  ageParticipantHistory,
  ageTableSql,
  ageableTables,
  createParticipant,
  cutShortResult,
  declaredAssertions,
  multiSessionScenario,
  readSystemPrompt,
  summaryStoredResult,
  validateMultiSession,
  waitForSummary,
  withoutMultiSession,
} from './multiSession.js';
import { RESERVED_PARTICIPANT_USERID_MIN } from './participantIdentity.js';
import type { AssertionSpec, DbLike, Scenario, SessionRecord, SessionSpec } from './types.js';

const spec = (id: string): AssertionSpec => ({
  id,
  run: async () => ({ id, passed: true, detail: '', gating: true }),
});

const session = (id: string, extra: Partial<SessionSpec> = {}): SessionSpec => ({
  id,
  beats: [{ id: `${id}-beat`, personaGoal: 'say hi.', verbatim: 'hi' }],
  ...extra,
});

const scenarioOf = (sessions: SessionSpec[], extra: Partial<Scenario> = {}): Scenario => ({
  ...multiSessionScenario({
    id: 'ms-test',
    title: 't',
    personaSystem: 'p',
    participants: { main: { memoryEnabled: true }, other: { memoryEnabled: false } },
    sessions,
    runJudge: false,
  }),
  ...extra,
});

describe('multiSessionScenario', () => {
  it('flattens the sessions into beats on the chat pipeline', () => {
    const s = scenarioOf([session('a'), session('b', { daysSincePrevious: 3 })]);
    expect(s.pipeline).toBe('chat');
    expect(s.beats.map((b) => b.id)).toEqual(['a-beat', 'b-beat']);
    expect(validateMultiSession(s)).toEqual([]);
  });

  it('declaredAssertions sees beat, session and final assertions', () => {
    const s = scenarioOf([
      { ...session('a'), beats: [{ id: 'x', personaGoal: 'g', verbatim: 'v', assertAfter: [spec('on-beat')] }] },
      session('b', { assertAfter: [spec('after-session')] }),
    ]);
    s.assertFinal = [spec('final')];
    expect(declaredAssertions(s).map((a) => a.id)).toEqual(['on-beat', 'after-session', 'final']);
  });
});

describe('withoutMultiSession', () => {
  const entries = [
    { scenario: scenarioOf([session('a')]) },
    { scenario: { ...scenarioOf([session('a')]), id: 'single', sessions: undefined } },
  ];

  it('keeps everything on a disposable database (CLI, CI)', () => {
    expect(withoutMultiSession(entries, undefined)).toEqual({ kept: entries, skipped: [] });
  });

  it('leaves multi-session scenarios out when the in-app runner started the run', () => {
    const out = withoutMultiSession(entries, 'admin');
    expect(out.kept.map((e) => e.scenario.id)).toEqual(['single']);
    expect(out.skipped).toEqual(['ms-test']);
  });
});

describe('validateMultiSession', () => {
  it('has nothing to say about a single-session scenario', () => {
    expect(validateMultiSession({ ...scenarioOf([session('a')]), sessions: undefined })).toEqual([]);
  });

  it('rejects duplicate session ids and duplicate beat ids', () => {
    expect(validateMultiSession(scenarioOf([session('a'), session('a')])).join(' ')).toMatch(/duplicate session id/);
    const same = { id: 'same', personaGoal: 'g', verbatim: 'v' };
    const dup = scenarioOf([
      { id: 'a', beats: [same] },
      { id: 'b', beats: [same] },
    ]);
    expect(validateMultiSession(dup).join(' ')).toMatch(/beat ids must be unique/);
  });

  it('rejects an unknown participant, a judge, another pipeline and an empty session', () => {
    expect(validateMultiSession(scenarioOf([session('a', { participant: 'nobody' })])).join(' ')).toMatch(
      /unknown participant 'nobody'/,
    );
    expect(validateMultiSession(scenarioOf([session('a')], { runJudge: true })).join(' ')).toMatch(/judge/);
    expect(validateMultiSession(scenarioOf([session('a')], { pipeline: 'voice' })).join(' ')).toMatch(/chat pipeline/);
    expect(validateMultiSession(scenarioOf([{ id: 'a', beats: [] }])).join(' ')).toMatch(/at least one beat/);
  });

  it('rejects a gap that ages nothing or is not a whole positive number of days', () => {
    expect(validateMultiSession(scenarioOf([session('a', { daysSincePrevious: 7 })])).join(' ')).toMatch(
      /ages nothing/,
    );
    // The first session of a SECOND participant has nothing to age either.
    const second = scenarioOf([session('a'), session('b', { participant: 'other', daysSincePrevious: 7 })]);
    expect(validateMultiSession(second).join(' ')).toMatch(/ages nothing/);
    for (const bad of [0, -1, 1.5]) {
      const s = scenarioOf([session('a'), session('b', { daysSincePrevious: bad })]);
      expect(validateMultiSession(s).join(' '), String(bad)).toMatch(/positive whole number/);
    }
  });

  it('rejects beats that are not the sessions flattened', () => {
    const s = scenarioOf([session('a'), session('b')]);
    expect(validateMultiSession({ ...s, beats: s.beats.slice(0, 1) }).join(' ')).toMatch(/flattened/);
  });
});

/** A pool that records every query and answers by regex. */
function recordingPool(handlers: Array<[RegExp, Array<Record<string, unknown>>]> = []) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const pool: DbLike = {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: handlers.find(([re]) => re.test(text))?.[1] ?? [] };
    },
  };
  return { pool, calls };
}

const SCHEMA = [
  { table: 'therapy_sessions', has_session_id: true, has_user_id: true, ts: ['created_at', 'ended_at'] },
  { table: 'messages', has_session_id: true, has_user_id: false, ts: ['created_at'] },
  { table: 'user_memories', has_session_id: true, has_user_id: true, ts: ['created_at'] },
  { table: 'user_case_profiles', has_session_id: false, has_user_id: true, ts: ['updated_at'] },
  // Never aged: spend rows, the express session store, the accounts table.
  { table: 'session_llm_usage', has_session_id: true, has_user_id: false, ts: ['created_at'] },
  { table: 'user_sessions', has_session_id: false, has_user_id: true, ts: ['expire'] },
  { table: 'users', has_session_id: false, has_user_id: true, ts: ['created_at'] },
  // Not per-participant, or nothing to move.
  { table: 'system_config', has_session_id: false, has_user_id: false, ts: ['updated_at'] },
  { table: 'tags', has_session_id: true, has_user_id: false, ts: null },
];

describe('ageing a participant’s history', () => {
  it('ageableTables keeps per-session and per-user tables with timestamps, minus the skip list', async () => {
    const { pool } = recordingPool([[/information_schema/, SCHEMA]]);
    expect((await ageableTables(pool)).map((t) => t.table)).toEqual([
      'messages',
      'therapy_sessions',
      'user_case_profiles',
      'user_memories',
    ]);
  });

  it('ageTableSql moves every timestamp column back and scopes the rows to one participant', () => {
    expect(
      ageTableSql({
        table: 'therapy_sessions',
        hasSessionId: true,
        hasUserId: true,
        timestampColumns: ['created_at', 'ended_at'],
      }),
    ).toBe(
      'UPDATE therapy_sessions SET created_at = created_at - make_interval(days => $1::int), ' +
        'ended_at = ended_at - make_interval(days => $1::int) ' +
        'WHERE session_id IN (SELECT session_id FROM therapy_sessions WHERE user_id = $2::int) OR user_id = $2::int',
    );
    expect(
      ageTableSql({ table: 'messages', hasSessionId: true, hasUserId: false, timestampColumns: ['created_at'] }),
    ).toBe(
      'UPDATE messages SET created_at = created_at - make_interval(days => $1::int) ' +
        'WHERE session_id IN (SELECT session_id FROM therapy_sessions WHERE user_id = $2::int)',
    );
  });

  it('ageTableSql refuses an identifier it would have to quote', () => {
    expect(() =>
      ageTableSql({
        table: 'x; DROP TABLE users',
        hasSessionId: true,
        hasUserId: false,
        timestampColumns: ['created_at'],
      }),
    ).toThrow(/unexpected identifier/);
  });

  it('runs one scoped UPDATE per table with the days and the userid', async () => {
    const { pool, calls } = recordingPool([[/information_schema/, SCHEMA]]);
    const userId = MULTI_SESSION_USERID_MIN + 3;
    await ageParticipantHistory(pool, userId, 8);
    const updates = calls.filter((c) => c.text.startsWith('UPDATE'));
    expect(updates).toHaveLength(4);
    for (const u of updates) {
      expect(u.params).toEqual([8, userId]);
      expect(u.text).toMatch(/\$2::int/);
    }
  });

  it('REFUSES any account it did not create: a real participant, the shared harness account, a low id', async () => {
    const { pool, calls } = recordingPool([[/information_schema/, SCHEMA]]);
    for (const userId of [1, 2, 4711, RESERVED_PARTICIPANT_USERID_MIN + 42, MULTI_SESSION_USERID_MIN - 1, 1.5]) {
      await expect(ageParticipantHistory(pool, userId, 7), String(userId)).rejects.toThrow(/refusing to age/);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a gap that is not a positive whole number of days', async () => {
    const { pool, calls } = recordingPool();
    for (const days of [0, -3, 2.5]) {
      await expect(ageParticipantHistory(pool, MULTI_SESSION_USERID_MIN, days)).rejects.toThrow(/cannot age/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('createParticipant', () => {
  it('inserts a fresh account in the reserved range with the declared settings', async () => {
    const { pool, calls } = recordingPool([[/INSERT INTO users/, [{ userid: MULTI_SESSION_USERID_MIN + 5 }]]]);
    const p = await createParticipant(pool, 'mem-x', 'alex', { memoryEnabled: true, riskContextShare: true });
    expect(p.userId).toBe(MULTI_SESSION_USERID_MIN + 5);
    expect(p.username.startsWith(`${MULTI_SESSION_USERNAME_PREFIX}mem-x_alex_`)).toBe(true);
    const params = calls[0].params as unknown[];
    expect(params[0]).toBe(MULTI_SESSION_USERID_MIN);
    expect(params[1]).toBe(p.username);
    expect(String(params[2])).toMatch(/^\$2[aby]\$/); // a bcrypt hash, never the password
    expect(params.slice(3)).toEqual([true, true]);
  });

  it('two accounts for one scenario never share a username', async () => {
    const { pool } = recordingPool([[/INSERT INTO users/, [{ userid: MULTI_SESSION_USERID_MIN }]]]);
    const a = await createParticipant(pool, 's', 'main', { memoryEnabled: false });
    const b = await createParticipant(pool, 's', 'main', { memoryEnabled: false });
    expect(a.username).not.toBe(b.username);
  });

  it('fails loudly if the database hands back an id outside the reserved range', async () => {
    const { pool } = recordingPool([[/INSERT INTO users/, [{ userid: 17 }]]]);
    await expect(createParticipant(pool, 's', 'main', { memoryEnabled: false })).rejects.toThrow(/reserved userid/);
  });

  it('its range sits inside the range participantIdentity reserves', () => {
    expect(MULTI_SESSION_USERID_MIN).toBeGreaterThan(RESERVED_PARTICIPANT_USERID_MIN + 42);
    expect(MULTI_SESSION_USERID_MIN).toBeLessThan(2_147_483_647);
  });
});

describe('the runner’s own summary assertion', () => {
  const record = (summary: Record<string, unknown> | null): SessionRecord => ({
    id: 'first',
    sessionId: 'chat_1',
    participant: 'main',
    userId: MULTI_SESSION_USERID_MIN,
    username: 'u',
    opening: null,
    systemPrompt: '',
    transcript: [],
    summary,
    observations: {},
  });

  it('passes and gates when the post-session job stored a summary', () => {
    const r = summaryStoredResult(record({ headline: 'Work stress' }));
    expect(r).toMatchObject({ id: 'post-session-summary-stored@first', passed: true, gating: true });
    expect(r.detail).toContain('Work stress');
    // Not labelled: a passing session is not a known gap that "passed this run".
    expect(r.knownGap).toBeUndefined();
  });

  it('FAILS when nothing was stored, reported under the known gap and not gating', () => {
    const r = summaryStoredResult(record(null));
    expect(r.passed).toBe(false);
    expect(r.gating).toBe(false);
    expect(r.knownGap).toBe('ai-therapist-346');
    expect(r.detail).toMatch(/KNOWN GAP ai-therapist-346: no summary in session_insights for chat_1/);
  });

  it('gates again as soon as the marker is taken away', () => {
    const r = summaryStoredResult(record(null), null);
    expect(r).toMatchObject({ passed: false, gating: true });
    expect(r.knownGap).toBeUndefined();
  });

  it('the marker says what the product does and carries its Flightdeck ref', () => {
    expect(SUMMARY_LOSS_GAP.reason).toMatch(/max_tokens/);
    expect(SUMMARY_LOSS_GAP.ref).toBe('ai-therapist-346');
    expect(SUMMARY_LOSS_GAP.assertionIds).toBeUndefined();
  });

  it('a scenario cut short says which sessions did not run, and never gates by itself', () => {
    const r = cutShortResult('first', ['second', 'third']);
    expect(r).toMatchObject({ id: 'scenario-cut-short', passed: false, gating: false });
    expect(r.detail).toContain("stopped after 'first'");
    expect(r.detail).toContain('second, third');
    expect(cutShortResult('last', []).detail).toContain('final assertions only');
  });
});

describe('waitForSummary / readSystemPrompt', () => {
  it('returns the summary once the post-session job has written it', async () => {
    let n = 0;
    const pool: DbLike = {
      query: async () => ({ rows: ++n < 3 ? [] : [{ summary: { headline: 'h' }, created_at: new Date() }] }),
    };
    expect(await waitForSummary(pool, 's1', { pollMs: 1 })).toEqual({ headline: 'h' });
    expect(n).toBe(3);
  });

  it('returns null when no summary appears, so the scenario can go on and report it', async () => {
    const { pool } = recordingPool();
    expect(await waitForSummary(pool, 's1', { timeoutMs: 20, pollMs: 5 })).toBeNull();
  });

  it('waits for the case profile of a memory-on participant, then gives up on it without failing', async () => {
    const withProfile = recordingPool([
      [/FROM session_insights/, [{ summary: { headline: 'h' }, created_at: new Date() }]],
      [/FROM user_case_profiles/, [{ '?column?': 1 }]],
    ]);
    await waitForSummary(withProfile.pool, 's1', { pollMs: 1, expectCaseProfileFor: 9 });
    expect(withProfile.calls.some((c) => /user_case_profiles/.test(c.text))).toBe(true);

    const noProfile = recordingPool([
      [/FROM session_insights/, [{ summary: { headline: 'h' }, created_at: new Date() }]],
    ]);
    const summary = await waitForSummary(noProfile.pool, 's1', {
      pollMs: 2,
      expectCaseProfileFor: 9,
      profileGraceMs: 10,
    });
    expect(summary).toEqual({ headline: 'h' });
    expect(noProfile.calls.filter((c) => /user_case_profiles/.test(c.text)).length).toBeGreaterThan(1);
  });

  it('readSystemPrompt returns the stored instructions, or empty when there is no row', async () => {
    expect(await readSystemPrompt(recordingPool([[/session_configurations/, [{ instructions: 'P' }]]]).pool, 's')).toBe(
      'P',
    );
    expect(await readSystemPrompt(recordingPool().pool, 's')).toBe('');
  });
});
