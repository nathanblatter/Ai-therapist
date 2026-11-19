// ai-therapist-373, in the scorer:
//  - the context-blind rule (applyContextBlindFloor): a turn with no history
//    it can rely on, whose own words carry risk, is raised to the page line;
//    an ordinary message is not;
//  - the history source is recorded on the risk row;
//  - a reply to a safety question reads the assessor's settings alongside the
//    other reads (one read deadline, not two, before its page);
//  - the flag retry writes nothing for a turn already on record or after a
//    staff unflag (flagSessionCrisis { retry, attemptedAt }).
// OpenAI and the database are mocked; no network.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock, connectMock, createMock, moderationCreateMock, draftMock, getSystemConfigMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
  createMock: vi.fn(),
  moderationCreateMock: vi.fn(),
  draftMock: vi.fn(),
  getSystemConfigMock: vi.fn(),
}));

vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: connectMock } }));
vi.mock('../utils/sessionHelpers.js', () => ({ getSystemConfig: getSystemConfigMock }));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('../db/crisis.queries.js', () => ({
  getRecentSessionMessages: vi.fn(async () => []),
  recordCrisisEvent: vi.fn(async (_event: unknown, client: { query: (sql: string) => Promise<unknown> }) =>
    client.query('INSERT INTO crisis_events'),
  ),
}));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: draftMock }));
vi.mock('./crisisAlert.service.js', () => ({
  reportOpenAIQuotaExhausted: vi.fn().mockResolvedValue(undefined),
  reportRiskAssessorOutage: vi.fn().mockResolvedValue(true),
  sendCrisisAlert: vi.fn(),
}));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
    moderations = { create: moderationCreateMock };
  },
}));

const { analyzeMessageRisk, applyContextBlindFloor, detectCrisisKeywords, flagSessionCrisis } = await import(
  './crisisDetection.service.js'
);
const { _resetAssessorHealthForTests } = await import('./riskAssessorHealth.service.js');

const assess = (risk_score: number, context = 'genuine') => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          risk_score,
          severity: risk_score >= 65 ? 'high' : risk_score >= 50 ? 'medium' : risk_score >= 25 ? 'low' : 'none',
          context,
          factors: [],
          reasoning: 'test',
          states_intent: false,
          loss_or_disclosure: false,
          acute: 'none',
        }),
      },
    },
  ],
});
const moderation = (selfHarm: number) => ({
  results: [
    {
      flagged: selfHarm > 0.5,
      categories: {},
      category_scores: { 'self-harm': selfHarm, 'self-harm/intent': selfHarm, 'self-harm/instructions': 0 },
    },
  ],
});

let seq = 0;
const turn = (content: string, extra: Record<string, unknown> = {}) => ({
  content,
  session_id: `sess-blind-${++seq}`,
  message_id: 7,
  ...extra,
});
function riskRow(): Record<string, unknown> {
  const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO risk_score_history'));
  expect(insert).toBeDefined();
  return { ...JSON.parse(insert![1][4] as string), _score: insert![1][2] };
}

beforeEach(() => {
  _resetAssessorHealthForTests();
  queryMock.mockReset().mockResolvedValue({ rows: [] });
  createMock.mockReset();
  moderationCreateMock.mockReset().mockResolvedValue(moderation(0));
  draftMock.mockReset().mockResolvedValue(1);
  getSystemConfigMock.mockReset().mockResolvedValue({});
});

describe('applyContextBlindFloor (pure)', () => {
  const base = {
    historySource: 'none',
    riskScore: 10,
    keywordScore: 0,
    content: 'hello',
    llmContext: 'genuine',
  };
  const floor = (over: Partial<typeof base> & { historySource?: string | undefined }) =>
    applyContextBlindFloor({ ...base, ...over });
  /** The turn with its history missing, two ways: an assessor that read it
   *  low without its context ('unclear', 30), and the assessor down (the
   *  turn's own keyword tier is its score). Returns whether the rule raised
   *  the first and whether the second ends at or above the page line. */
  const blind = (content: string) => {
    const keywordScore = detectCrisisKeywords(content).keywordScore;
    const read = { historySource: 'none', keywordScore, content };
    const lowRead = applyContextBlindFloor({ ...read, riskScore: 30, llmContext: 'unclear' });
    const down = applyContextBlindFloor({ ...read, riskScore: keywordScore, llmContext: undefined });
    return { raised: lowRead.floored, pagesWhenDown: down.riskScore >= 65 };
  };

  // Owner decision 2026-11-19 (PR #88 review): only a STRONG signal, of the
  // kind that pages with the context too, is raised while the history is
  // missing. Passive ideation does not page, in this window as everywhere.
  it.each([
    ['stated intent to kill oneself (high tier)', 'sometimes I think about killing myself'],
    ['stated intent to die (high tier)', 'I want to end my life'],
    ['means (high tier)', 'I took an overdose an hour ago'],
    ['a final message to us', "This is the last time we'll talk. Thank you for listening."],
    ['a goodbye addressed to us', 'This is goodbye.'],
    ['a lethal-means question', "What's a lethal dose of my sleeping pills?"],
    ['a painless-way question', "What's the most painless way to die?"],
    ['a time and a goodbye together', "I'm doing it tonight. I've already said goodbye to my sister."],
    ['an implicit plan and a goodbye note together', "I'm going to do it after I finish my goodbye letters."],
    // A preparatory act (C-SSRS) is the goodbye half too.
    ['an implicit plan and a note written', "I wrote my note and I'm going to do it after my roommate leaves."],
    ['a time and a letter left', "I've left a letter for my mom. I'm doing it tonight."],
    ['a time and belongings given away', "I've given away all my things. I'm doing it tonight."],
    ['an implicit plan and belongings given away', "I gave my stuff away, I'm going to go through with it."],
  ])('blind, %s: raised (and pages with the assessor down)', (_label, content) => {
    expect(blind(content)).toEqual({ raised: true, pagesWhenDown: true });
  });

  it.each([
    ['passive ideation', "I'm tired of living."],
    ['passive ideation (indirect)', "I hope I just don't wake up tomorrow."],
    ['passive ideation (better off)', 'Everyone would be better off without me.'],
    ['passive ideation (life not worth it)', "Life isn't worth it."],
    ['slang', 'cant go on anymore'],
    ['a help step', "I'm going to do it, I'll text my sister tonight."],
    ['a help step (appointment)', "Ok, I'll call the counseling center tomorrow. I'll do it."],
    ['an ordinary plan', "I'm going to do it, I'm finally going to ask her out."],
    ['an ordinary plan with a time', "I've decided. I'm doing it this weekend."],
    ['a breakup', "I'm going to end it with my boyfriend this weekend."],
    ['an implicit plan alone (the referent is in the missing history)', "I'm going to do it tonight, I've decided."],
    ['a goodbye alone that is not to us', 'I said goodbye to my sister at the airport.'],
    ['a media reference', 'That episode where the character says goodbye forever to his dog wrecked me.'],
    ['no signal ("yes")', 'yes'],
    ['a lone fragment (" myself")', ' myself'],
    ['a low-tier keyword only', 'I feel hopeless'],
    ['a negated signal', "I'm not going to do it"],
    ['a negated time with a goodbye', "I'm not doing it tonight, I said goodbye to her at the station."],
    ['a retracted time and goodbye', "I'm doing it tonight, I said goodbye to everyone, jk"],
    // A weak signal only wakes the assessor; it is not the intent half.
    ['a weak "I\'ve decided" and a goodbye', "I've decided. I said goodbye to my sister at the airport."],
    ['a note written, no intent', 'I wrote my note.'],
    ['belongings given away, no intent', "I've given away all my things."],
    ['a note not written', "I haven't written my note, I'm going to do it tonight."],
    ['a retracted note and plan', "I wrote my note and I'm going to do it after my roommate leaves. jk"],
    // The negation and retraction guards apply to the preparatory act itself.
    ['a negated preparatory act beside a plan', "I don't think I gave my stuff away yet, I'm doing it this weekend."],
    [
      'a retracted preparatory act beside a plan',
      "I wrote a letter but tore it up instead. I'm doing it this weekend.",
    ],
    ['a negated plan beside a note', "I wrote my note. I'm not going to do it."],
    ['lecture notes and a plan', "I wrote my notes for the exam and I'm going to do it tonight."],
    ['a recommendation letter and a plan', "I wrote the letter of recommendation, I'm going to do it this weekend."],
    ['someone else gave things away', "She gave all my stuff away, I'm going to do it, I'm moving out."],
  ])('blind, %s: not raised (and no page with the assessor down)', (_label, content) => {
    expect(blind(content)).toEqual({ raised: false, pagesWhenDown: false });
  });

  it('a medium-tier keyword score alone is not a strong signal', () => {
    expect(floor({ keywordScore: 50, content: "I don't want to be here" })).toEqual({ riskScore: 10, floored: false });
    expect(floor({ keywordScore: 74 })).toEqual({ riskScore: 10, floored: false });
    expect(floor({ keywordScore: 75 })).toEqual({ riskScore: 65, floored: true });
  });

  it('two implicit intents without a goodbye, or two goodbyes without intent, are not raised', () => {
    expect(floor({ content: "I'm going to do it. I'm doing it tonight." }).floored).toBe(false);
    expect(floor({ content: 'I said goodbye to my sister, goodbye forever.' }).floored).toBe(false);
  });

  it.each(['negated', 'reference', 'bystander', 'harm_to_others'])(
    'the assessor settled it on its own words (%s): unchanged',
    (llmContext) => {
      expect(floor({ keywordScore: 75, llmContext })).toEqual({ riskScore: 10, floored: false });
    },
  );

  it('an assessor that was not reached (fallback) or said "unclear" does not exempt', () => {
    expect(floor({ keywordScore: 75, llmContext: undefined as unknown as string })).toEqual({
      riskScore: 65,
      floored: true,
    });
    expect(floor({ keywordScore: 75, llmContext: 'unclear' })).toEqual({ riskScore: 65, floored: true });
  });

  it.each([
    ['the stored history', undefined],
    ['a complete copy in memory', 'memory'],
  ])('with %s: unchanged whatever the turn says', (_label, historySource) => {
    expect(floor({ historySource, keywordScore: 75 })).toEqual({ riskScore: 10, floored: false });
  });

  it('a partial copy in memory (this process did not see the start) is blind', () => {
    expect(floor({ historySource: 'memory_partial', keywordScore: 75 })).toEqual({ riskScore: 65, floored: true });
  });

  // The split disclosure: the pipeline joins the fragments from whatever copy
  // it has, so with a partial copy the scorer sees the whole sentence, a
  // high-tier keyword, and the rule still raises it. With nothing kept the
  // fragment " myself" stands alone and carries no signal (not raised, as
  // before). A bare "yes" never carried a signal of its own: the rule did not
  // and does not raise it; it pages only when the copy holds the question.
  it('the split disclosure joined from a partial copy: raised; the lone fragment or "yes": not', () => {
    const joined = 'I have been thinking about how I would kill myself';
    const kw = (content: string) => detectCrisisKeywords(content).keywordScore;
    expect(
      floor({ historySource: 'memory_partial', content: joined, keywordScore: kw(joined), llmContext: 'unclear' }),
    ).toEqual({ riskScore: 65, floored: true });
    expect(floor({ content: ' myself', keywordScore: kw(' myself') }).floored).toBe(false);
    expect(floor({ historySource: 'memory_partial', content: 'yes', keywordScore: kw('yes') }).floored).toBe(false);
  });

  it('already at or above the page line: unchanged (never lowered)', () => {
    expect(floor({ keywordScore: 75, riskScore: 65 })).toEqual({ riskScore: 65, floored: false });
    expect(floor({ keywordScore: 75, riskScore: 90 })).toEqual({ riskScore: 90, floored: false });
  });
});

describe('analyzeMessageRisk with the history source', () => {
  it('blind, a keyword turn the assessor reads low: 65, high, recorded on the risk row', async () => {
    createMock.mockResolvedValue(assess(30));
    const result = await analyzeMessageRisk(
      turn('sometimes I think about killing myself', { history_source: 'none' }),
      [],
    );
    expect(result.riskScore).toBe(65);
    expect(result.severity).toBe('high');
    expect(result.factors).toContain('risk words scored without the conversation (history unreadable)');
    expect(riskRow()).toMatchObject({ history_source: 'none', context_blind_floor: 65, _score: 65 });
  });

  it('the same turn with the stored history: the assessor stands', async () => {
    createMock.mockResolvedValue(assess(30));
    const result = await analyzeMessageRisk(turn('sometimes I think about killing myself'), []);
    // The passive-ideation floor (50) applies as always; nothing more.
    expect(result.riskScore).toBe(50);
    expect(riskRow()).not.toHaveProperty('history_source');
    expect(riskRow()).not.toHaveProperty('context_blind_floor');
  });

  it('from a complete copy in memory: the source is recorded, nothing is raised', async () => {
    createMock.mockResolvedValue(assess(30));
    const result = await analyzeMessageRisk(
      turn('sometimes I think about killing myself', { history_source: 'memory' }),
      [],
    );
    // The passive-ideation floor (50) applies as always; nothing more.
    expect(result.riskScore).toBe(50);
    expect(riskRow()).toMatchObject({ history_source: 'memory' });
    expect(riskRow()).not.toHaveProperty('context_blind_floor');
  });

  it('blind, an ordinary message: not raised', async () => {
    const result = await analyzeMessageRisk(turn('work was long today', { history_source: 'none' }), []);
    expect(result.riskScore).toBe(0);
  });

  it('blind, passive ideation the assessor reads below high: not raised (passive ideation does not page)', async () => {
    createMock.mockResolvedValue(assess(55));
    const result = await analyzeMessageRisk(turn("I'm tired of living.", { history_source: 'none' }), []);
    expect(result.riskScore).toBe(55);
    expect(result.severity).toBe('medium');
    expect(riskRow()).not.toHaveProperty('context_blind_floor');
  });

  it('blind, passive ideation with the assessor down: the medium tier stands, no page', async () => {
    createMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    const result = await analyzeMessageRisk(turn("I'm tired of living.", { history_source: 'none' }), []);
    expect(result.riskScore).toBe(50);
    expect(result.factors).not.toContain('risk words scored without the conversation (history unreadable)');
  });

  it('blind, a moderation score below the page line on its own: not raised', async () => {
    moderationCreateMock.mockResolvedValue(moderation(0.5));
    createMock.mockResolvedValue(assess(30));
    const result = await analyzeMessageRisk(turn('everything is a lot right now', { history_source: 'none' }), []);
    expect(result.riskScore).toBeLessThan(65);
    expect(riskRow()).not.toHaveProperty('context_blind_floor');
  });

  // PR #86 review, in this window: the rule no longer raises a help step, so
  // the page rests on the assessor's own reading; the help-step cap must still
  // not hold that reading at 64 when the session context is unread.
  it('blind with the context unread, a help step the assessor reads as high: not capped, pages', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('session-risk-context')) throw new Error('timeout exceeded when trying to connect');
      return { rows: [] };
    });
    createMock.mockResolvedValue(assess(70));
    const result = await analyzeMessageRisk(
      turn("I'm going to do it, I'll text my sister tonight.", { history_source: 'none' }),
      [],
    );
    expect(result.riskScore).toBe(70);
    expect(result.severity).toBe('high');
    expect(riskRow().help_step_cap).toBeUndefined();
    expect(riskRow()).not.toHaveProperty('context_blind_floor');
  });

  it('blind, the assessor down on a keyword turn: the screen tier stands (already high)', async () => {
    createMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    const result = await analyzeMessageRisk(turn('I want to kill myself', { history_source: 'none' }), []);
    expect(result.riskScore).toBeGreaterThanOrEqual(65);
  });
});

describe('a reply to a safety question reads the assessor settings alongside the other reads', () => {
  const SAFETY_HISTORY = [
    { role: 'assistant', content: 'Are you thinking about suicide?' },
    { role: 'user', content: 'yeah' },
  ];

  /** Holds the session risk context read until released; reports whether the
   *  assessor's model setting was asked for while it was held. */
  async function settingReadWhileContextHeld(
    history: Array<{ role: string; content: string }>,
    content: string,
  ): Promise<boolean> {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    queryMock.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('session-risk-context')) await held;
      return { rows: [] };
    });
    createMock.mockResolvedValue(assess(70));
    const done = analyzeMessageRisk(turn(content), history);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const early = getSystemConfigMock.mock.calls.length > 0;
    release();
    await done;
    return early;
  }

  it('a "yeah" to a safety question: the setting is read while the context read is still out', async () => {
    expect(await settingReadWhileContextHeld(SAFETY_HISTORY, 'yeah')).toBe(true);
  });

  it('a turn with a context signal: the same', async () => {
    expect(await settingReadWhileContextHeld([], "I'm going to do it tonight")).toBe(true);
  });

  it('a calm turn with nothing certain to be assessed: no extra read up front', async () => {
    expect(await settingReadWhileContextHeld([], 'work was long today')).toBe(false);
  });
});

describe('flagSessionCrisis: the retry of a failed high flag', () => {
  function client(responses: { duplicate?: boolean; unflaggedAfter?: boolean } = {}) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const c = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('FROM crisis_events'))
          return { rows: responses.duplicate ? [{}] : [], rowCount: responses.duplicate ? 1 : 0 };
        if (sql.includes('crisis_unflagged_at >'))
          return { rows: responses.unflaggedAfter ? [{}] : [], rowCount: responses.unflaggedAfter ? 1 : 0 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(c);
    return { c, calls };
  }
  const attemptedAt = new Date('2030-01-01T12:00:00Z');
  const retry = (messageId: number | null, opts: Record<string, unknown> = { retry: true, attemptedAt }) =>
    flagSessionCrisis('s1', 'high', 80, 'system', 'auto', messageId, ['f'], 'notes', opts);

  it('the same message already flagged: nothing written, no draft', async () => {
    const { calls } = client({ duplicate: true });
    await expect(retry(42)).resolves.toBe('skipped_duplicate');
    expect(calls.map((c) => c.sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    expect(calls[1].params).toEqual(['s1', 42]);
    await new Promise((r) => setImmediate(r));
    expect(draftMock).not.toHaveBeenCalled();
  });

  it('staff unflagged after the first attempt: nothing written', async () => {
    const { calls } = client({ unflaggedAfter: true });
    await expect(retry(42)).resolves.toBe('skipped_unflagged');
    expect(calls.some((c) => c.sql.includes('UPDATE therapy_sessions'))).toBe(false);
    expect(calls.at(-1)?.sql).toBe('ROLLBACK');
    const check = calls.find((c) => c.sql.includes('crisis_unflagged_at >'));
    expect(check?.params).toEqual(['s1', attemptedAt.toISOString()]);
  });

  it('neither: the flag and its crisis event are written, and the draft follows', async () => {
    const { calls } = client();
    await expect(retry(42)).resolves.toBe('written');
    expect(calls.some((c) => c.sql.includes('UPDATE therapy_sessions'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('INSERT INTO crisis_events'))).toBe(true);
    expect(calls.at(-1)?.sql).toBe('COMMIT');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(draftMock).toHaveBeenCalledTimes(1);
  });

  it('an unsaved turn (no message id) skips the duplicate check, not the unflag check', async () => {
    const { calls } = client();
    await expect(retry(null)).resolves.toBe('written');
    expect(calls.some((c) => c.sql.includes('FROM crisis_events'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('crisis_unflagged_at >'))).toBe(true);
  });

  it('a first write (not a retry) checks neither', async () => {
    const { calls } = client({ duplicate: true, unflaggedAfter: true });
    await expect(retry(42, {})).resolves.toBe('written');
    expect(calls.some((c) => c.sql.includes('FROM crisis_events'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('crisis_unflagged_at >'))).toBe(false);
  });
});
