// Independent review cases for the context wake (ai-therapist-299), written
// against the class of failure rather than the one reproduction sentence:
// statements of intent, timing, plan, goodbye and giving possessions away that
// carry no crisis keyword, in three kinds of session (flagged, recently
// risk-bearing, calm).
//
// The assessor is mocked at the OpenAI boundary and answers the way a competent
// assessor would for the conversation it is shown; everything else is the real
// detection code. What these cases pin:
//
//  - in a flagged or recently risk-bearing session EVERY such statement reaches
//    the assessor, whatever its wording;
//  - in a calm session only the ones the signal screen recognises do. The rest
//    score 0 until the periodic sweep (every SWEEP_EVERY keyword-free turns),
//    exactly as before the context wake existed. That remaining hole is stated
//    here as a test so that it cannot be closed, or widened, silently;
//  - no failure of the context assessment (rejection, timeout, malformed JSON,
//    truncated output, refusal, failed session lookup) scores a turn below what
//    the keyword screen alone would have scored it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock, createMock, moderationCreateMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  createMock: vi.fn(),
  moderationCreateMock: vi.fn(),
}));

vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn() } }));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: vi.fn() }));
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

const { analyzeMessageRisk, detectContextSignals, detectCrisisKeywords, SWEEP_EVERY } = await import(
  './crisisDetection.service.js'
);
const { _resetAssessorHealthForTests } = await import('./riskAssessorHealth.service.js');

const MOD_QUIET = { results: [{ flagged: false, category_scores: { 'self-harm/intent': 0.1 } }] };

/** What a competent assessor returns for a statement of intent after ideation. */
const INTENT_VERDICT = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          risk_score: 88,
          severity: 'high',
          context: 'genuine',
          factors: ['stated intent'],
          reasoning: 'Read against the earlier ideation, the latest message states intent.',
          states_intent: true,
          loss_or_disclosure: true,
        }),
      },
    },
  ],
};
const verdict = (risk_score: number, extra: Record<string, unknown> = {}) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          risk_score,
          severity: risk_score >= 75 ? 'high' : risk_score >= 50 ? 'medium' : risk_score >= 25 ? 'low' : 'none',
          context: 'genuine',
          factors: [],
          reasoning: 'test',
          states_intent: false,
          loss_or_disclosure: false,
          ...extra,
        }),
      },
    },
  ],
});

interface SessionState {
  flagged?: boolean;
  severity?: string | null;
  recent?: Array<{ risk_score: number; score_factors?: Record<string, unknown> }>;
  lookupFails?: boolean;
  trajectory?: number[];
}
function sessionIs(state: SessionState): void {
  queryMock.mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('session-risk-context')) {
      if (state.lookupFails) throw new Error('db down');
      return {
        rows: [
          {
            crisis_flagged: state.flagged ?? false,
            crisis_severity: state.severity ?? null,
            recent: (state.recent ?? []).map((r) => ({
              risk_score: r.risk_score,
              score_factors: r.score_factors ?? {},
            })),
          },
        ],
      };
    }
    if (text.includes('LIMIT 5') && state.trajectory) {
      return { rows: state.trajectory.map((risk_score) => ({ risk_score, calculated_at: new Date() })) };
    }
    return { rows: [] };
  });
}

const CALM: SessionState = {};
const FLAGGED_MEDIUM: SessionState = {
  flagged: true,
  severity: 'medium',
  recent: [{ risk_score: 55, score_factors: { method: 'llm_assessed', llm_factors: ['passive ideation'] } }],
};
/** Not flagged; a keyword turn scored in the low band four turns ago. */
const RECENT_LOW: SessionState = {
  recent: [
    { risk_score: 0 },
    { risk_score: 0 },
    { risk_score: 0 },
    { risk_score: 30, score_factors: { method: 'llm_assessed', llm_factors: ['hopelessness'] } },
  ],
};

let seq = 0;
const turn = (content: string, sessionId = `sess-class-${++seq}`) => ({
  content,
  session_id: sessionId,
  message_id: 9,
});

function riskRow(): Record<string, unknown> {
  const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO risk_score_history'));
  expect(insert).toBeDefined();
  return { ...JSON.parse(insert![1][4] as string), _score: insert![1][2] };
}

/** Keyword-free statements, by class, and whether the signal screen knows them. */
const STATEMENTS: Array<{ cls: string; text: string; screened: boolean }> = [
  { cls: 'implicit intent', text: "I'm going to do it tonight, I've decided.", screened: true },
  { cls: 'implicit intent', text: "I've made up my mind. Nothing you say changes it.", screened: true },
  { cls: 'implicit intent', text: "It's happening. I'm done going back and forth on it.", screened: false },
  { cls: 'timing', text: "Tonight's the night.", screened: true },
  { cls: 'timing', text: "Tonight. After everyone's asleep.", screened: false },
  { cls: 'timing', text: 'By this time tomorrow none of you will have to deal with me.', screened: false },
  { cls: 'plan', text: 'I have everything I need now.', screened: true },
  { cls: 'plan', text: "It's all laid out on the bed. I checked it twice.", screened: false },
  { cls: 'plan', text: 'I drove out to the bridge yesterday to look at it.', screened: false },
  { cls: 'goodbye', text: "This is the last time we'll talk. Thank you for listening.", screened: true },
  { cls: 'goodbye', text: "Thanks for everything. You won't hear from me again.", screened: false },
  { cls: 'goodbye', text: 'I wrote to my mom and my sister. The envelopes are on my desk.', screened: false },
  { cls: 'giving away', text: 'I gave my guitar to my brother and my cat to the neighbor.', screened: false },
  { cls: 'giving away', text: "I've been handing my stuff out to people. I won't need it.", screened: false },
];

beforeEach(() => {
  _resetAssessorHealthForTests();
  queryMock.mockReset();
  sessionIs(CALM);
  createMock.mockReset().mockResolvedValue(INTENT_VERDICT);
  moderationCreateMock.mockReset().mockResolvedValue(MOD_QUIET);
});

describe('the class, not the sentence: keyword-free intent, timing, plan, goodbye, giving away', () => {
  it('premise: none of the statements matches a keyword tier, and the screen knows only some of them', () => {
    for (const s of STATEMENTS) {
      expect(detectCrisisKeywords(s.text).keywordScore, s.text).toBe(0);
      expect(detectContextSignals(s.text).length > 0, s.text).toBe(s.screened);
    }
  });

  it.each(STATEMENTS)('flagged session: "$text" ($cls) is assessed and takes the assessor score', async ({ text }) => {
    sessionIs(FLAGGED_MEDIUM);
    const r = await analyzeMessageRisk(turn(text), [{ role: 'user', content: text }]);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.riskScore).toBe(88);
    expect(r.severity).toBe('high');
    expect(r.method).toBe('llm_context');
  });

  it.each(STATEMENTS)('recently risk-bearing, unflagged session: "$text" ($cls) is assessed', async ({ text }) => {
    sessionIs(RECENT_LOW);
    const r = await analyzeMessageRisk(turn(text), [{ role: 'user', content: text }]);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.riskScore).toBe(88);
    expect(r.method).toBe('llm_context');
  });

  it.each(STATEMENTS.filter((s) => s.screened))(
    'calm session, statement the screen recognises: "$text" is assessed',
    async ({ text }) => {
      const r = await analyzeMessageRisk(turn(text), [{ role: 'user', content: text }]);
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(r.method).toBe('llm_context');
    },
  );

  // THE REMAINING HOLE, stated plainly. With no prior signal in the session and
  // no wording the screen recognises, the turn is not assessed and scores 0,
  // exactly as it did before the context wake. The only net under it is the
  // periodic sweep (next test).
  it.each(STATEMENTS.filter((s) => !s.screened))(
    'REMAINING HOLE: calm session, "$text" ($cls) is not assessed and scores 0',
    async ({ text }) => {
      const r = await analyzeMessageRisk(turn(text), [{ role: 'user', content: text }]);
      expect(createMock).not.toHaveBeenCalled();
      expect(r.riskScore).toBe(0);
      expect(r.method).toBe('keyword_only');
    },
  );

  it('the net under that hole is the periodic sweep: the same statement is assessed when it is the sweep turn', async () => {
    const sessionId = 'sess-class-sweep';
    const text = "It's all laid out on the bed. I checked it twice.";
    for (let i = 1; i < SWEEP_EVERY; i++) {
      const r = await analyzeMessageRisk(turn('We mostly talked about my classes.', sessionId), []);
      expect(r.riskScore).toBe(0);
    }
    expect(createMock).not.toHaveBeenCalled();
    const r = await analyzeMessageRisk(turn(text, sessionId), [{ role: 'user', content: text }]);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.method).toBe('llm_sweep');
    expect(r.riskScore).toBe(88);
  });
});

describe('a failed context assessment never scores below the keyword screen alone', () => {
  const SILENT = "Tonight. After everyone's asleep."; // no keyword, no signal
  const STRONG = "I'm going to do it tonight, I've decided.";
  const timeout = () => Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
  const failures: Array<[string, () => void]> = [
    [
      'the call is rejected (model not found)',
      () =>
        createMock.mockRejectedValue(
          Object.assign(new Error('404'), { status: 404, code: 'model_not_found', headers: new Headers() }),
        ),
    ],
    ['the call times out', () => createMock.mockRejectedValue(timeout())],
    [
      'the reply is not JSON',
      () => createMock.mockResolvedValue({ choices: [{ message: { content: 'risk: high' } }] }),
    ],
    [
      'the reply is cut off',
      () => createMock.mockResolvedValue({ choices: [{ finish_reason: 'length', message: { content: '{"risk_sc' } }] }),
    ],
    [
      'the model refuses',
      () => createMock.mockResolvedValue({ choices: [{ message: { refusal: 'no', content: null } }] }),
    ],
  ];

  it.each(failures)(
    'flagged session, no signal, %s: the moderation reading only (no action), marked degraded, never throws',
    async (_n, arrange) => {
      vi.useFakeTimers();
      try {
        sessionIs(FLAGGED_MEDIUM);
        arrange();
        const p = analyzeMessageRisk(turn(SILENT), [{ role: 'user', content: SILENT }]);
        await vi.runAllTimersAsync();
        const r = await p;
        // 10 is the mocked moderation reading: the screen-level score, below
        // every threshold that steers, flags or pages.
        expect(r.riskScore).toBe(10);
        expect(r.severity).toBe('none');
        expect(r.degraded).toBe(true);
        expect(riskRow()).toMatchObject({ method: 'keyword_fallback', assessment_degraded: true, context_wake: true });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(failures)(
    'flagged session, strong signal, %s: 75 from the screen (fails toward detection)',
    async (_n, arrange) => {
      vi.useFakeTimers();
      try {
        sessionIs(FLAGGED_MEDIUM);
        arrange();
        const p = analyzeMessageRisk(turn(STRONG), [{ role: 'user', content: STRONG }]);
        await vi.runAllTimersAsync();
        const r = await p;
        expect(r.riskScore).toBe(75);
        expect(r.severity).toBe('high');
        expect(riskRow()).toMatchObject({ context_fallback: true, assessment_degraded: true });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('a keyword turn in a risk-bearing session keeps its keyword tier when the assessor fails', async () => {
    vi.useFakeTimers();
    try {
      sessionIs(FLAGGED_MEDIUM);
      createMock.mockRejectedValue(timeout());
      const text = 'I want to kill myself';
      const tier = detectCrisisKeywords(text).keywordScore;
      expect(tier).toBeGreaterThanOrEqual(75);
      const p = analyzeMessageRisk(turn(text), [{ role: 'user', content: text }]);
      await vi.runAllTimersAsync();
      expect((await p).riskScore).toBeGreaterThanOrEqual(tier);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the session lookup failing does not skip the assessment or lose the assessor verdict', async () => {
    sessionIs({ lookupFails: true });
    const r = await analyzeMessageRisk(turn(SILENT), [{ role: 'user', content: SILENT }]);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.riskScore).toBe(88);
  });

  it('an assessor verdict of 0 on a context wake is recorded as 0, not as a failure', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockResolvedValue(verdict(0));
    const r = await analyzeMessageRisk(turn('ok'), [{ role: 'user', content: 'ok' }]);
    expect(r.riskScore).toBe(0);
    expect(r.degraded).toBe(false);
  });
});

// Defects found in review and fixed with it. Each case below failed before.
describe('review fixes: what may cancel a strong signal, and what may not', () => {
  const down = () =>
    createMock.mockRejectedValue(
      Object.assign(new Error('404'), { status: 404, code: 'model_not_found', headers: new Headers() }),
    );
  async function scoredWithAssessorDown(text: string) {
    vi.useFakeTimers();
    try {
      sessionIs(FLAGGED_MEDIUM);
      down();
      const p = analyzeMessageRisk(turn(text), [{ role: 'user', content: text }]);
      await vi.runAllTimersAsync();
      return await p;
    } finally {
      vi.useRealTimers();
    }
  }

  // Insisting uses the vocabulary of retracting. These scored the moderation
  // reading (no flag, no page) with the assessor down, and lost the
  // context-signal floor with it up.
  it.each([
    ["I'm not kidding. I'm going to do it tonight."],
    ["This isn't a joke, I'm going to do it tonight."],
    ["I'm not joking, tonight's the night."],
    ["I haven't changed my mind. I'm going to do it tonight."],
    ["I don't care anymore I'm going to do it tonight"],
    ["Nobody can stop me I'm going to do it tonight"],
    ["Instead of waiting I'm going to do it tonight."],
    ["I'm going to do it tonight instead of waiting."],
  ])('assessor down, medium-flagged session: "%s" still scores high from the screen', async (text) => {
    const r = await scoredWithAssessorDown(text);
    expect(r.riskScore).toBe(75);
    expect(r.severity).toBe('high');
  });

  it.each([
    ["I'm not kidding. I'm going to do it tonight."],
    ["I don't care anymore I'm going to do it tonight"],
    ["Instead of waiting I'm going to do it tonight."],
  ])('assessor up but banding it medium: "%s" keeps the context-signal floor', async (text) => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockResolvedValue(verdict(65, { states_intent: true }));
    const r = await analyzeMessageRisk(turn(text), [{ role: 'user', content: text }]);
    expect(r.riskScore).toBe(75);
    expect(riskRow()).toMatchObject({ context_signal_floor: 75 });
  });

  // The narrowing must not turn real negations and retractions into pages.
  it.each([
    ["I'm not going to do it tonight"],
    ['I was never going to do it, I promise'],
    ["I don't think I'm going to do it"],
    ["I'm not sure I'll do it"],
    ["I never said I'm going to do it"],
    ["It's not like I'm going to do it"],
    ["I don't know if I'll do it"],
    ["lol jk I'm going to do it tonight"],
    ["I'm going to do it tonight. Just kidding."],
    ['I was going to do it but I called my mom instead'],
    ['I was going to do it tonight but I changed my mind'],
  ])('assessor down, medium-flagged session: "%s" is still not paged from the screen', async (text) => {
    const r = await scoredWithAssessorDown(text);
    expect(r.riskScore).toBe(10);
    expect(riskRow()).not.toHaveProperty('context_fallback');
  });
});

describe('review fix: "the easiest way to go about it" is not a means question', () => {
  it.each([
    ["What's the easiest way to go about it?"],
    ["What's the fastest way to go home from campus?"],
    ['Is that the quickest way to go through the paperwork?'],
  ])('"%s" matches no context signal', (text) => {
    expect(detectContextSignals(text)).toEqual([]);
  });

  it.each([
    ["What's the most painless way to go?"],
    ['I just want the quickest way to go.'],
    ['the easiest way to die'],
  ])('"%s" is still screened as a means question', (text) => {
    const kinds = [
      ...detectContextSignals(text).map((s) => s.kind),
      ...(detectCrisisKeywords(text).keywordScore > 0 ? ['keyword'] : []),
    ];
    expect(kinds.length).toBeGreaterThan(0);
  });
});

describe('review fix: a periodic sweep that only repeats the session level gets no trajectory bonus', () => {
  // The session is flagged and every keyword-free turn is context-assessed. The
  // assessor repeats the level the session already holds (60). On the eighth
  // such turn the sweep is due; its run-up is that flat line, which the
  // trajectory reads as "deteriorating" (+15). Before the fix the sweep turn
  // was recorded at 75: a high flag and a page for a turn that said nothing.
  it('an assessor repeating the session level does not become a page on the sweep turn', async () => {
    const state: SessionState = {
      flagged: true,
      severity: 'medium',
      recent: [60, 60, 60, 60, 60].map((risk_score) => ({ risk_score, score_factors: { context_wake: true } })),
      trajectory: [60, 60, 60, 60, 60],
    };
    sessionIs(state);
    createMock.mockResolvedValue(verdict(60));
    const sessionId = 'sess-class-sweep-flagged';
    const seen: Array<{ method?: string; riskScore: number }> = [];
    for (let i = 1; i <= SWEEP_EVERY; i++) {
      seen.push(await analyzeMessageRisk(turn('yeah, classes are fine I guess', sessionId), []));
    }
    expect(seen.slice(0, -1).every((r) => r.method === 'llm_context' && r.riskScore === 60)).toBe(true);
    const sweep = seen[seen.length - 1];
    expect(sweep.method).toBe('llm_sweep');
    expect(sweep.riskScore).toBe(60);
    expect(sweep.riskScore).toBeLessThan(75);
  });

  it('a sweep that scores above the level the session holds keeps the bonus, as before', async () => {
    const state: SessionState = {
      flagged: true,
      severity: 'medium',
      recent: [55, 55, 55, 55, 55].map((risk_score) => ({ risk_score, score_factors: { context_wake: true } })),
      trajectory: [55, 55, 55, 55, 55],
    };
    sessionIs(state);
    createMock.mockResolvedValue(verdict(55));
    const sessionId = 'sess-class-sweep-rising';
    for (let i = 1; i < SWEEP_EVERY; i++) await analyzeMessageRisk(turn('fine I guess', sessionId), []);
    createMock.mockResolvedValue(verdict(65));
    const sweep = await analyzeMessageRisk(turn('I wrote some letters this week', sessionId), []);
    expect(sweep.method).toBe('llm_sweep');
    expect(sweep.riskScore).toBe(80);
  });

  it('a sweep in a calm session keeps the bonus, as before', async () => {
    sessionIs({ trajectory: [0, 0, 0] });
    createMock.mockResolvedValue(verdict(40));
    const sessionId = 'sess-class-sweep-calm';
    let last = await analyzeMessageRisk(turn('fine', sessionId), []);
    for (let i = 2; i <= SWEEP_EVERY; i++) last = await analyzeMessageRisk(turn('fine', sessionId), []);
    expect(last.method).toBe('llm_sweep');
    expect(last.riskScore).toBe(55);
  });

  it('a keyword turn in a risk-bearing session keeps the bonus, as before', async () => {
    sessionIs({ ...FLAGGED_MEDIUM, trajectory: [50, 50, 50] });
    createMock.mockResolvedValue(verdict(60));
    const text = 'I feel so hopeless';
    expect(detectCrisisKeywords(text).keywordScore).toBeGreaterThan(0);
    const r = await analyzeMessageRisk(turn(text), [{ role: 'user', content: text }]);
    expect(r.riskScore).toBe(75);
  });
});

describe('review of PR #46: a stitched voice sentence is not its own run-up', () => {
  // "some days I don't want to be here anymore." was scored when it arrived
  // (assessor 55, +15 on three calm rows = 70, medium). A trailing fragment
  // (" you know?") then has the whole sentence scored again. If the first
  // part's own row stays in the trajectory it reads as a sudden spike (0 to
  // 70): +20, 75, a HIGH flag and a page for a statement the assessor put at
  // 55 both times. Measured on the real assessor before the fix, 2 of 2.
  const ROWS = [
    { message_id: '8', risk_score: 70 }, // the first part, already scored
    { message_id: '3', risk_score: 0 },
    { message_id: '2', risk_score: 0 },
    { message_id: '1', risk_score: 0 },
  ];
  function historyIs(): void {
    queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('session-risk-context')) {
        return { rows: [{ crisis_flagged: false, crisis_severity: null, recent: [] }] };
      }
      if (text.includes('LIMIT 5')) {
        const excluded = Array.isArray(params?.[1]) ? (params[1] as string[]) : [];
        // The filter has to be in the SQL, not only in the parameters.
        const filters = /message_id::text = ANY\(\$2::text\[\]\)/.test(text);
        return { rows: ROWS.filter((r) => !(filters && excluded.includes(r.message_id))) };
      }
      return { rows: [] };
    });
  }
  const sentence = "Honestly some days I don't want to be here anymore. you know?";

  it('leaves the earlier part of the sentence out of the trajectory', async () => {
    historyIs();
    createMock.mockResolvedValue(verdict(55));
    const r = await analyzeMessageRisk({ ...turn(sentence), stitched_message_ids: ['8'] }, []);
    // The score is what this test pins: the sentence's own earlier part adds
    // no spike. 70 was medium when high began at 75; since the cutoff moved to
    // 65 (2026-11-18) the remaining +15 from the genuine run-up makes it high.
    expect(r.riskScore).toBe(70);
    expect(r.severity).toBe('high');
  });

  it('an ordinary turn after the same history keeps the spike bonus, as before', async () => {
    historyIs();
    createMock.mockResolvedValue(verdict(55));
    const r = await analyzeMessageRisk(turn(sentence), []);
    expect(r.riskScore).toBe(75);
    expect(r.severity).toBe('high');
  });
});
