import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AllianceTurn } from './allianceMarkers.js';

const db = vi.hoisted(() => ({
  eligible: true,
  existing: null as { status: string; transcript_fingerprint?: string } | null,
  turns: [] as AllianceTurn[],
  fingerprint: 'fp-now',
  claimFree: true,
  claims: 0,
  claimsHeld: 0,
  mostClaimsAtOnce: 0,
  claimOrder: [] as string[],
  review: null as { sessionId: string; awaitingReview: number } | null,
  config: { config_value: { enabled: false } } as { config_value: unknown } | null,
  configThrows: false,
  upserts: [] as Array<Record<string, unknown>>,
  waiting: [] as string[],
}));

vi.mock('../db/index.js', () => ({
  isSessionAllianceEligible: vi.fn(async () => db.eligible),
  getAllianceRating: vi.fn(async () => db.existing),
  getTranscriptForAlliance: vi.fn(async () => ({ turns: db.turns, fingerprint: db.fingerprint })),
  getLeakReviewStateForMessage: vi.fn(async () => db.review),
  withAllianceRatingClaim: vi.fn(async (sessionId: string, _v: string, fn: () => Promise<unknown>) => {
    if (!db.claimFree) return { acquired: false };
    db.claims++;
    db.claimOrder.push(sessionId);
    db.claimsHeld++;
    db.mostClaimsAtOnce = Math.max(db.mostClaimsAtOnce, db.claimsHeld);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { acquired: true, result: await fn() };
    } finally {
      db.claimsHeld--;
    }
  }),
  getSessionsNeedingAllianceRating: vi.fn(async () => db.waiting),
  getSystemConfigByKey: vi.fn(async () => {
    if (db.configThrows) throw new Error('db down');
    return db.config;
  }),
  // Like the SQL: an errored result is refused (null) when an answer is stored.
  upsertAllianceRating: vi.fn(async (r: Record<string, unknown>) => {
    db.upserts.push(r);
    if (r.status === 'errored' && db.existing && db.existing.status !== 'errored') return null;
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
  maybeRateAllianceAfterLeakReview,
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
  db.fingerprint = 'fp-now';
  db.claimFree = true;
  db.claims = 0;
  db.claimsHeld = 0;
  db.mostClaimsAtOnce = 0;
  db.claimOrder = [];
  db.review = null;
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
    await maybeRateAllianceForSession('s1');
    await flush();
    expect(db.upserts).toEqual([]);
    expect(db.claims).toBe(0);
  });

  it('the leak-review hook does nothing while the switch is off', async () => {
    db.review = { sessionId: 's1', awaitingReview: 0 };
    await maybeRateAllianceAfterLeakReview(7);
    expect(db.upserts).toEqual([]);
    expect(db.claims).toBe(0);
  });

  it('the leak-review hook rates once the last message of the session is reviewed, not before', async () => {
    db.config = { config_value: { enabled: true } };
    db.review = { sessionId: 's1', awaitingReview: 2 };
    await maybeRateAllianceAfterLeakReview(7);
    expect(db.upserts).toEqual([]);

    db.review = { sessionId: 's1', awaitingReview: 0 };
    await maybeRateAllianceAfterLeakReview(7);
    expect(db.upserts).toHaveLength(1);

    db.review = null; // message gone
    await expect(maybeRateAllianceAfterLeakReview(8)).resolves.toBeUndefined();
    expect(db.upserts).toHaveLength(1);
  });

  it('the post-session hook rates one session at a time, in order', async () => {
    db.config = { config_value: { enabled: true } };
    await Promise.all(['a', 'b', 'c'].map((id) => maybeRateAllianceForSession(id)));
    expect(db.claimOrder).toEqual(['a', 'b', 'c']);
    expect(db.mostClaimsAtOnce).toBe(1);
  });

  it('the post-session hook skips a harness session that did not opt in, even when on', async () => {
    db.config = { config_value: { enabled: true } };
    harness.skip = true;
    await maybeRateAllianceForSession('s1');
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

  it('does not rate twice when the transcript has not changed', async () => {
    db.existing = { status: 'rated', transcript_fingerprint: 'fp-now' };
    const { client, create } = fakeClient();
    expect(await rateSessionAlliance('s1', { client })).toEqual({ outcome: 'skipped', reason: 'already_rated' });
    expect(create).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });

  it('rates a stale session again: the transcript changed since the stored rating', async () => {
    db.existing = { status: 'rated', transcript_fingerprint: 'fp-before-the-late-turn' };
    const { client, create } = fakeClient();
    const result = await rateSessionAlliance('s1', { client });
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('stored');
    expect(db.upserts[0]).toMatchObject({ status: 'rated', transcriptFingerprint: 'fp-now', transcriptMessages: 6 });
  });

  it('a too-short answer is stale too once the transcript has grown', async () => {
    db.existing = { status: 'too_short', transcript_fingerprint: 'fp-short' };
    const { client, create } = fakeClient();
    await rateSessionAlliance('s1', { client });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does nothing while another run holds the claim for the session', async () => {
    db.claimFree = false;
    const { client, create } = fakeClient();
    expect(await rateSessionAlliance('s1', { client, force: true })).toEqual({
      outcome: 'skipped',
      reason: 'in_progress',
    });
    expect(create).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });

  it('a failed re-rating reports that the stored answer was kept', async () => {
    db.existing = { status: 'rated', transcript_fingerprint: 'fp-now' };
    const { client } = fakeClient(async () => Promise.reject(new Error('503 upstream')));
    expect(await rateSessionAlliance('s1', { client, force: true })).toEqual({
      outcome: 'skipped',
      reason: 'kept_existing',
    });
  });

  it('rates again after an errored attempt, and under force', async () => {
    db.existing = { status: 'errored' };
    const a = fakeClient();
    await rateSessionAlliance('s1', { client: a.client });
    expect(a.create).toHaveBeenCalledTimes(1);

    db.existing = { status: 'rated', transcript_fingerprint: 'fp-now' };
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
    const stored = db.upserts[0] as {
      status: string;
      subscales: Record<string, { rateable: boolean; score: null; pRateable: null }>;
    };
    expect(stored.status).toBe('too_short');
    for (const s of ['task', 'bond', 'goal']) {
      expect(stored.subscales[s].rateable).toBe(false);
      expect(stored.subscales[s].score).toBeNull();
      // No judge call, so no probability: NULL, never an invented 0.
      expect(stored.subscales[s].pRateable).toBeNull();
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
