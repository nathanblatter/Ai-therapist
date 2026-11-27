import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AllianceTurn } from './allianceMarkers.js';

const db = vi.hoisted(() => ({
  eligible: true,
  existing: null as { status: string } | null,
  turns: [] as AllianceTurn[],
  config: { config_value: { enabled: false } } as { config_value: unknown } | null,
  configThrows: false,
  upserts: [] as Array<Record<string, unknown>>,
  waiting: [] as string[],
}));

vi.mock('../db/index.js', () => ({
  isSessionAllianceEligible: vi.fn(async () => db.eligible),
  getAllianceRating: vi.fn(async () => db.existing),
  getRedactedTurnsForAlliance: vi.fn(async () => db.turns),
  getSessionsNeedingAllianceRating: vi.fn(async () => db.waiting),
  getSystemConfigByKey: vi.fn(async () => {
    if (db.configThrows) throw new Error('db down');
    return db.config;
  }),
  upsertAllianceRating: vi.fn(async (r: Record<string, unknown>) => {
    db.upserts.push(r);
    return { ...r, status: r.status };
  }),
}));
vi.mock('../config/secrets.js', () => ({
  getOpenAIKey: vi.fn(async () => {
    throw new Error('no key in tests: a real client must never be built');
  }),
}));
const harness = vi.hoisted(() => ({ skip: false }));
vi.mock('./harnessPostSession.service.js', () => ({
  shouldSkipPostSessionWork: vi.fn(async () => harness.skip),
}));

const {
  DEFAULT_ALLIANCE_MARKERS_CONFIG,
  backfillAllianceRatings,
  getAllianceMarkersConfig,
  maybeRateAllianceForSession,
  rateSessionAlliance,
} = await import('./allianceRating.service.js');
const { ALLIANCE_JUDGE_VERSION, LEVEL_LABELS } = await import('./allianceMarkers.js');

const LONG_TURNS: AllianceTurn[] = Array.from({ length: 6 }, (_, i) => ({
  role: i % 2 ? ('participant' as const) : ('assistant' as const),
  text: 'I want to work on sleeping better and the plan we made last time has been helping me a lot honestly',
}));

function goodResponse() {
  const answers: unknown[] = [];
  for (const s of ['task', 'bond', 'goal']) {
    answers.push({ type: 'predicate', name: `${s}_rateable`, probability: 0.95 });
    answers.push({
      type: 'score',
      name: `${s}_score`,
      probabilities: LEVEL_LABELS.map((label, i) => ({ label, value: i, probability: i === 3 ? 1 : 0 })),
    });
  }
  return { model: 'gpt-6-luna', answers, usage: { input_tokens: 900, output_tokens: 0 } };
}

function fakeClient(impl: () => Promise<unknown> = async () => goodResponse()) {
  const create = vi.fn(impl);
  return { client: { decisions: { create } }, create };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  db.eligible = true;
  db.existing = null;
  db.turns = LONG_TURNS;
  db.config = { config_value: { enabled: false } };
  db.configThrows = false;
  db.upserts = [];
  db.waiting = [];
  harness.skip = false;
});

describe('the on/off switch', () => {
  it('is off in code', () => {
    expect(DEFAULT_ALLIANCE_MARKERS_CONFIG.enabled).toBe(false);
  });

  it.each([
    ['no row', null],
    ['an empty object', { config_value: {} }],
    ['enabled: false', { config_value: { enabled: false } }],
    ['a truthy non-boolean', { config_value: { enabled: 'true' } }],
    ['a bare true', { config_value: true }],
  ])('reads %s as off', async (_label, row) => {
    db.config = row as typeof db.config;
    expect((await getAllianceMarkersConfig()).enabled).toBe(false);
  });

  it('reads a failed config read as off', async () => {
    db.configThrows = true;
    expect((await getAllianceMarkersConfig()).enabled).toBe(false);
  });

  it('is on only for enabled: true', async () => {
    db.config = { config_value: { enabled: true } };
    expect((await getAllianceMarkersConfig()).enabled).toBe(true);
  });

  it('the post-session hook does nothing while the switch is off', async () => {
    maybeRateAllianceForSession('s1');
    await flush();
    expect(db.upserts).toEqual([]);
  });

  it('the post-session hook skips a harness session that did not opt in, even when on', async () => {
    db.config = { config_value: { enabled: true } };
    harness.skip = true;
    maybeRateAllianceForSession('s1');
    await flush();
    expect(db.upserts).toEqual([]);
  });

  it('the post-session hook never throws, whatever goes wrong', async () => {
    db.configThrows = true;
    expect(() => maybeRateAllianceForSession('s1')).not.toThrow();
    await flush();
  });
});

describe('rateSessionAlliance', () => {
  it('refuses a session that is not eligible without reading its turns or calling the judge', async () => {
    db.eligible = false;
    const { client, create } = fakeClient();
    expect(await rateSessionAlliance('s1', { client })).toEqual({ outcome: 'skipped', reason: 'not_eligible' });
    expect(create).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });

  it('does not rate twice under the same judge version', async () => {
    db.existing = { status: 'rated' };
    const { client, create } = fakeClient();
    expect(await rateSessionAlliance('s1', { client })).toEqual({ outcome: 'skipped', reason: 'already_rated' });
    expect(create).not.toHaveBeenCalled();
  });

  it('rates again after an errored attempt, and under force', async () => {
    db.existing = { status: 'errored' };
    const a = fakeClient();
    await rateSessionAlliance('s1', { client: a.client });
    expect(a.create).toHaveBeenCalledTimes(1);

    db.existing = { status: 'rated' };
    const b = fakeClient();
    await rateSessionAlliance('s1', { client: b.client, force: true });
    expect(b.create).toHaveBeenCalledTimes(1);
  });

  it('stores a too-short session as not rateable without a model call', async () => {
    db.turns = [
      { role: 'assistant', text: 'Hi, what would you like to talk about?' },
      { role: 'participant', text: 'Sorry, I have to go.' },
    ];
    const { client, create } = fakeClient();
    const result = await rateSessionAlliance('s1', { client });
    expect(create).not.toHaveBeenCalled();
    expect(result.outcome).toBe('stored');
    const stored = db.upserts[0] as { status: string; subscales: Record<string, { rateable: boolean; score: null }> };
    expect(stored.status).toBe('too_short');
    for (const s of ['task', 'bond', 'goal']) {
      expect(stored.subscales[s].rateable).toBe(false);
      expect(stored.subscales[s].score).toBeNull();
    }
    expect(stored).toMatchObject({ model: null, tokensIn: null, participantTurns: 1 });
  });

  it('stores the ratings, the judge version, the model and the token counts', async () => {
    const { client, create } = fakeClient();
    await rateSessionAlliance('s1', { client });
    expect(create).toHaveBeenCalledTimes(1);
    const sent = create.mock.calls[0] as unknown as [{ input: Array<{ role: string; content: string }> }];
    expect(sent[0].input[1].content.startsWith('Assistant: I want to work on')).toBe(true);
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toMatchObject({
      sessionId: 's1',
      judgeVersion: ALLIANCE_JUDGE_VERSION,
      status: 'rated',
      model: 'gpt-6-luna',
      tokensIn: 900,
      tokensOut: 0,
      participantTurns: 3,
      transcriptTruncated: false,
    });
    const stored = db.upserts[0] as { subscales: Record<string, { level: number; rateable: boolean }> };
    expect(stored.subscales.bond).toMatchObject({ rateable: true, level: 4 });
  });

  it('stores nothing that could hold transcript text', async () => {
    const { client } = fakeClient();
    await rateSessionAlliance('s1', { client });
    expect(JSON.stringify(db.upserts[0])).not.toContain('sleeping better');
  });

  it.each([
    ['the API call fails', async () => Promise.reject(new Error('503 upstream'))],
    ['the answer is malformed', async () => ({ answers: [{ type: 'refusal', name: 'task_rateable' }] })],
  ])('stores an errored row with no scores when %s', async (_label, impl) => {
    const { client } = fakeClient(impl as () => Promise<unknown>);
    const result = await rateSessionAlliance('s1', { client });
    expect(result.outcome).toBe('stored');
    const stored = db.upserts[0] as { status: string; subscales?: unknown; error: string };
    expect(stored.status).toBe('errored');
    expect(stored.subscales).toBeUndefined();
    expect(stored.error.length).toBeGreaterThan(0);
  });
});

describe('backfillAllianceRatings', () => {
  it('rates each waiting session once and counts the outcomes', async () => {
    db.waiting = ['a', 'b', 'c'];
    let n = 0;
    const { client, create } = fakeClient(async () => {
      n++;
      if (n === 2) throw new Error('boom');
      return goodResponse();
    });
    const summary = await backfillAllianceRatings({ client });
    expect(create).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({ candidates: 3, rated: 2, tooShort: 0, errored: 1, skipped: 0 });
  });
});
