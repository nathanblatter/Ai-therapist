import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JudgeTurn } from '../db/sessionJudge.queries.js';

const db = vi.hoisted(() => ({
  eligible: true,
  existing: null as { status: string; transcript_fingerprint?: string } | null,
  turns: [] as JudgeTurn[],
  fingerprint: 'fp-now',
  claimFree: true,
  claims: 0,
  claimsHeld: 0,
  mostClaimsAtOnce: 0,
  review: null as { sessionId: string; awaitingReview: number } | null,
  config: { config_value: { enabled: false } } as { config_value: unknown } | null,
  configThrows: false,
  configKeys: [] as string[],
  upserts: [] as Array<Record<string, unknown>>,
  waiting: [] as string[],
}));

vi.mock('../db/sessionJudge.queries.js', () => ({
  isSessionJudgeEligible: vi.fn(async () => db.eligible),
  getTranscriptForJudge: vi.fn(async () => ({ turns: db.turns, fingerprint: db.fingerprint })),
}));
vi.mock('../db/index.js', () => ({
  getSessionFeatures: vi.fn(async () => db.existing),
  getLeakReviewStateForMessage: vi.fn(async () => db.review),
  withSessionFeaturesClaim: vi.fn(async (_sessionId: string, _v: string, fn: () => Promise<unknown>) => {
    if (!db.claimFree) return { acquired: false };
    db.claims++;
    db.claimsHeld++;
    db.mostClaimsAtOnce = Math.max(db.mostClaimsAtOnce, db.claimsHeld);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { acquired: true, result: await fn() };
    } finally {
      db.claimsHeld--;
    }
  }),
  getSessionsNeedingFeatures: vi.fn(async () => db.waiting),
  getSystemConfigByKey: vi.fn(async (key: string) => {
    db.configKeys.push(key);
    if (db.configThrows) throw new Error('db down');
    return db.config;
  }),
  // Like the SQL: an errored result is refused (null) when an answer is stored.
  upsertSessionFeatures: vi.fn(async (r: Record<string, unknown>) => {
    db.upserts.push(r);
    if (r.status === 'errored' && db.existing && db.existing.status !== 'errored') return null;
    return { ...r };
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
  DEFAULT_SESSION_FEATURES_CONFIG,
  backfillSessionFeatures,
  extractSessionFeatures,
  getSessionFeaturesConfig,
  maybeExtractFeaturesAfterLeakReview,
  maybeExtractFeaturesForSession,
} = await import('./sessionFeatures.service.js');
const { SESSION_FEATURE_SET_VERSION, SESSION_FEATURES } = await import('./sessionFeatures.js');

const LONG_TURNS: JudgeTurn[] = Array.from({ length: 6 }, (_, i) => ({
  role: i % 2 ? ('participant' as const) : ('assistant' as const),
  text: 'I have not been sleeping and the worksheet from last time is still sitting there untouched to be honest',
}));

function goodResponse() {
  return {
    model: 'gpt-6-luna',
    answers: SESSION_FEATURES.map((f) =>
      f.type === 'predicate'
        ? { type: 'predicate', name: f.name, probability: f.name === 'topic_sleep' ? 0.97 : 0.03 }
        : {
            type: 'choice',
            name: f.name,
            probabilities: f.choices.map((c, i) => ({
              value: c.value,
              probability: i === 0 ? 0.9 : 0.1 / (f.choices.length - 1),
            })),
          },
    ),
    usage: { input_tokens: 5000, output_tokens: 0 },
  };
}

function fakeClient(impl: () => Promise<unknown> = async () => goodResponse()) {
  const create = vi.fn(impl);
  return { client: { decisions: { create } }, create };
}

beforeEach(() => {
  db.eligible = true;
  db.existing = null;
  db.turns = LONG_TURNS;
  db.fingerprint = 'fp-now';
  db.claimFree = true;
  db.claims = 0;
  db.claimsHeld = 0;
  db.mostClaimsAtOnce = 0;
  db.review = null;
  db.config = { config_value: { enabled: false } };
  db.configThrows = false;
  db.configKeys = [];
  db.upserts = [];
  db.waiting = [];
  harness.skip = false;
});

describe('the switch', () => {
  it('is off by default, and off on any doubt', async () => {
    expect(DEFAULT_SESSION_FEATURES_CONFIG).toEqual({ enabled: false });
    expect(await getSessionFeaturesConfig()).toEqual({ enabled: false });
    expect(db.configKeys).toEqual(['session_features']);
    db.config = null;
    expect(await getSessionFeaturesConfig()).toEqual({ enabled: false });
    for (const value of ['true', 1, { enabled: 'true' }, { enabled: 1 }, [], null]) {
      db.config = { config_value: value };
      expect(await getSessionFeaturesConfig(), JSON.stringify(value)).toEqual({ enabled: false });
    }
    db.configThrows = true;
    expect(await getSessionFeaturesConfig()).toEqual({ enabled: false });
    db.configThrows = false;
    db.config = { config_value: { enabled: true } };
    expect(await getSessionFeaturesConfig()).toEqual({ enabled: true });
  });
});

describe('extractSessionFeatures', () => {
  it('refuses an ineligible session before taking a claim or calling the judge', async () => {
    db.eligible = false;
    const { client, create } = fakeClient();
    expect(await extractSessionFeatures('s1', { client, force: true })).toEqual({
      outcome: 'skipped',
      reason: 'not_eligible',
    });
    expect(db.claims).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });

  it('stores the answers with what they were computed from', async () => {
    const { client, create } = fakeClient();
    const result = await extractSessionFeatures('s1', { client });
    expect(result.outcome).toBe('stored');
    expect(create).toHaveBeenCalledTimes(1);
    expect(db.upserts).toHaveLength(1);
    const row = db.upserts[0] as { features: Record<string, unknown> };
    expect(row).toMatchObject({
      sessionId: 's1',
      featureSetVersion: SESSION_FEATURE_SET_VERSION,
      status: 'extracted',
      unknownCount: 0,
      participantTurns: 3,
      transcriptMessages: 6,
      transcriptFingerprint: 'fp-now',
      transcriptTruncated: false,
      model: 'gpt-6-luna',
      tokensIn: 5000,
      tokensOut: 0,
    });
    expect(row.features.topic_sleep).toEqual({ kind: 'predicate', p: 0.97, present: true });
    expect(row.features.topic_family).toEqual({ kind: 'predicate', p: 0.03, present: false });
    expect(row.features.followup_status).toMatchObject({ kind: 'choice', value: 'not_discussed' });
    // Nothing of the transcript is in what is stored.
    expect(JSON.stringify(row)).not.toContain('worksheet from last time');
  });

  it('a session under the length floor is stored as too_short with no values and no model call', async () => {
    db.turns = [
      { role: 'assistant', text: 'Hi.' },
      { role: 'participant', text: 'hello' },
    ];
    const { client, create } = fakeClient();
    const result = await extractSessionFeatures('s1', { client });
    expect(result.outcome).toBe('stored');
    expect(create).not.toHaveBeenCalled();
    expect(db.upserts[0]).toMatchObject({ status: 'too_short', model: null, tokensIn: null });
    expect(db.upserts[0]).not.toHaveProperty('features');
  });

  it('a failed judge call is stored as errored with no values, and never throws', async () => {
    const { client } = fakeClient(async () => Promise.reject(new Error('503 upstream')));
    const result = await extractSessionFeatures('s1', { client });
    expect(result.outcome).toBe('stored');
    expect(db.upserts[0]).toMatchObject({ status: 'errored', error: '503 upstream', tokensIn: null });
    expect(db.upserts[0]).not.toHaveProperty('features');
  });

  it('a response with nothing usable is errored; one refused variable is unknown inside an extracted row', async () => {
    const allRefused = fakeClient(async () => ({
      answers: SESSION_FEATURES.map((f) => ({ type: 'refusal', name: f.name })),
    }));
    await extractSessionFeatures('s1', { client: allRefused.client });
    expect(db.upserts[0]).toMatchObject({ status: 'errored' });

    db.upserts = [];
    const oneRefused = fakeClient(async () => {
      const r = goodResponse();
      r.answers = r.answers.map((a) =>
        a.name === 'topic_substance_use' ? { type: 'refusal', name: a.name } : a,
      ) as never;
      return r;
    });
    await extractSessionFeatures('s1', { client: oneRefused.client });
    const row = db.upserts[0] as { features: Record<string, unknown> };
    expect(row).toMatchObject({ status: 'extracted', unknownCount: 1 });
    expect(row.features.topic_substance_use).toEqual({ kind: 'unknown', reason: 'refused' });
  });

  it('skips a session whose answer is current, codes a stale or errored one again, and honours force', async () => {
    const { client, create } = fakeClient();
    db.existing = { status: 'extracted', transcript_fingerprint: 'fp-now' };
    expect(await extractSessionFeatures('s1', { client })).toEqual({ outcome: 'skipped', reason: 'already_extracted' });
    db.existing = { status: 'too_short', transcript_fingerprint: 'fp-now' };
    expect(await extractSessionFeatures('s1', { client })).toEqual({ outcome: 'skipped', reason: 'already_extracted' });
    expect(create).not.toHaveBeenCalled();

    db.existing = { status: 'extracted', transcript_fingerprint: 'fp-before' };
    expect((await extractSessionFeatures('s1', { client })).outcome).toBe('stored');
    db.existing = { status: 'errored', transcript_fingerprint: 'fp-now' };
    expect((await extractSessionFeatures('s1', { client })).outcome).toBe('stored');
    db.existing = { status: 'extracted', transcript_fingerprint: 'fp-now' };
    expect((await extractSessionFeatures('s1', { client, force: true })).outcome).toBe('stored');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('a failed re-run keeps the stored answer', async () => {
    db.existing = { status: 'extracted', transcript_fingerprint: 'fp-before' };
    const { client } = fakeClient(async () => Promise.reject(new Error('timeout')));
    expect(await extractSessionFeatures('s1', { client })).toEqual({ outcome: 'skipped', reason: 'kept_existing' });
  });

  it('does nothing when another run holds the claim', async () => {
    db.claimFree = false;
    const { client, create } = fakeClient();
    expect(await extractSessionFeatures('s1', { client })).toEqual({ outcome: 'skipped', reason: 'in_progress' });
    expect(create).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });
});

describe('the automatic hooks', () => {
  it('do nothing while the switch is off: no eligibility read, no claim, no write', async () => {
    await maybeExtractFeaturesForSession('s1');
    db.review = { sessionId: 's1', awaitingReview: 0 };
    await maybeExtractFeaturesAfterLeakReview('42');
    expect(db.claims).toBe(0);
    expect(db.upserts).toEqual([]);
  });

  it('never reject, even when the config read or the job throws', async () => {
    db.configThrows = true;
    await expect(maybeExtractFeaturesForSession('s1')).resolves.toBeUndefined();
    await expect(maybeExtractFeaturesAfterLeakReview('42')).resolves.toBeUndefined();
  });

  it('skip a harness session that did not opt in', async () => {
    db.config = { config_value: { enabled: true } };
    harness.skip = true;
    await maybeExtractFeaturesForSession('s1');
    expect(db.claims).toBe(0);
  });

  it('with the switch on, the session hook reaches the job (which fails closed without a key) one session at a time', async () => {
    db.config = { config_value: { enabled: true } };
    await Promise.all([
      maybeExtractFeaturesForSession('s1'),
      maybeExtractFeaturesForSession('s2'),
      maybeExtractFeaturesForSession('s3'),
    ]);
    expect(db.claims).toBe(3);
    expect(db.mostClaimsAtOnce).toBe(1);
    // No key in tests: each attempt is stored as errored, never as an answer.
    expect(db.upserts.map((u) => u.status)).toEqual(['errored', 'errored', 'errored']);
  });

  it('the leak-review hook waits until no message of the session awaits review', async () => {
    db.config = { config_value: { enabled: true } };
    db.review = { sessionId: 's1', awaitingReview: 2 };
    await maybeExtractFeaturesAfterLeakReview('42');
    expect(db.claims).toBe(0);
    db.review = null;
    await maybeExtractFeaturesAfterLeakReview('42');
    expect(db.claims).toBe(0);
    db.review = { sessionId: 's1', awaitingReview: 0 };
    await maybeExtractFeaturesAfterLeakReview('42');
    expect(db.claims).toBe(1);
  });
});

describe('backfillSessionFeatures', () => {
  it('codes every waiting session and counts the outcomes', async () => {
    db.waiting = ['a', 'b', 'c'];
    let n = 0;
    const { client } = fakeClient(async () => {
      n++;
      if (n === 2) throw new Error('boom');
      return goodResponse();
    });
    expect(await backfillSessionFeatures({ client })).toEqual({
      candidates: 3,
      extracted: 2,
      tooShort: 0,
      errored: 1,
      skipped: 0,
    });
  });
});
