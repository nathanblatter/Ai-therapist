// Context-dependent risk (ai-therapist-299, ai-therapist-303).
//
// The gap these tests pin: after a turn already flagged for passive ideation,
// "I'm going to do it tonight, I've decided." matched no keyword, moderation
// scored it 10, the assessor was never called, the turn scored 0 and nobody
// was paged. A means-relevant question straight after a loss was never scored
// either. The first test in each block is that reproduction and fails on the
// code before this change.
//
// Just as much of this file is the other direction: ordinary uses of the same
// words in a calm session must not flag, a retraction must not be over-read,
// and an assessor that is slow or down must leave the keyword-level result in
// place rather than block or invent a score.
// OpenAI, the DB and the pager are mocked; no network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { queryMock, createMock, moderationCreateMock, reportQuotaMock, reportOutageMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  createMock: vi.fn(),
  moderationCreateMock: vi.fn(),
  reportQuotaMock: vi.fn(),
  reportOutageMock: vi.fn(),
}));

vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn() } }));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: vi.fn() }));
vi.mock('./crisisAlert.service.js', () => ({
  reportOpenAIQuotaExhausted: reportQuotaMock,
  reportRiskAssessorOutage: reportOutageMock,
  sendCrisisAlert: vi.fn(),
}));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
    moderations = { create: moderationCreateMock };
  },
}));

const {
  analyzeMessageRisk,
  detectContextSignals,
  detectCrisisKeywords,
  getSessionRiskContext,
  needsContextAssessment,
} = await import('./crisisDetection.service.js');
const { _resetAssessorHealthForTests } = await import('./riskAssessorHealth.service.js');

const llmResponse = (payload: Record<string, unknown>) => ({
  choices: [{ message: { content: JSON.stringify(payload) } }],
});
const assess = (risk_score: number, context = 'genuine', factors: string[] = []) =>
  llmResponse({
    risk_score,
    severity: risk_score >= 75 ? 'high' : risk_score >= 50 ? 'medium' : risk_score >= 25 ? 'low' : 'none',
    context,
    factors,
    reasoning: 'test',
  });
const MOD_QUIET = { results: [{ flagged: false, category_scores: { 'self-harm/intent': 0.1 } }] };

function apiError(status: number, code: string, type?: string): Error {
  return Object.assign(new Error(`${status} ${code}`), { status, code, type, headers: new Headers() });
}
const RATE_LIMIT = () => apiError(429, 'rate_limit_exceeded', 'rate_limit_error');
const MODEL_NOT_FOUND = () => apiError(404, 'model_not_found', 'invalid_request_error');

interface SessionState {
  flagged?: boolean;
  severity?: string | null;
  /** Most recent first, as the query returns them. */
  recent?: Array<{ risk_score: number; score_factors?: Record<string, unknown> }>;
  /** Make the context lookup itself fail. */
  lookupFails?: boolean;
  /** Scores the trajectory query sees (most recent first), for the bonus. */
  trajectory?: number[];
}

/** Route pool.query by SQL: the session-risk-context lookup gets `state`. */
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
/** The session of the reproduction: one passive-ideation turn, flagged medium. */
const FLAGGED_MEDIUM: SessionState = {
  flagged: true,
  severity: 'medium',
  recent: [{ risk_score: 55, score_factors: { method: 'llm_assessed', llm_factors: ['passive ideation'] } }],
};

let seq = 0;
const turn = (content: string, sessionId = `sess-ctx-${++seq}`) => ({ content, session_id: sessionId, message_id: 7 });

function riskRow(): Record<string, unknown> {
  const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO risk_score_history'));
  expect(insert).toBeDefined();
  return { ...JSON.parse(insert![1][4] as string), _score: insert![1][2], _severity: insert![1][3] };
}
function interventionRows(): Array<{ type: string; details: Record<string, unknown> }> {
  return queryMock.mock.calls
    .filter((c) => String(c[0]).includes('INSERT INTO intervention_actions'))
    .map((c) => ({ type: c[1][1] as string, details: JSON.parse(c[1][2] as string) }));
}
/** The user message the assessor was sent on call `n`. */
function assessorSaw(n = 0): string {
  return createMock.mock.calls[n][0].messages[1].content as string;
}

const IMMINENT = "I'm going to do it tonight, I've decided.";
const PASSIVE = "Honestly some days I don't want to be here anymore.";
const HISTORY = [
  { role: 'user', content: PASSIVE },
  { role: 'user', content: IMMINENT },
];

beforeEach(() => {
  _resetAssessorHealthForTests();
  queryMock.mockReset();
  sessionIs(CALM);
  createMock.mockReset();
  moderationCreateMock.mockReset().mockResolvedValue(MOD_QUIET);
  reportQuotaMock.mockReset().mockResolvedValue(undefined);
  reportOutageMock.mockReset().mockResolvedValue(true);
});

describe('ai-therapist-299: keyword-free statement of intent in a session already flagged', () => {
  it('the premise still holds: the sentence matches no keyword tier and moderation is below the wake threshold', () => {
    expect(detectCrisisKeywords(IMMINENT).keywordScore).toBe(0);
  });

  it('REPRODUCTION: reaches the assessor, with the conversation, and scores high', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockResolvedValue(assess(92, 'genuine', ['stated intent', 'timeframe: tonight']));

    const r = await analyzeMessageRisk(turn(IMMINENT), HISTORY);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.riskScore).toBe(92);
    expect(r.severity).toBe('high');
    expect(r.method).toBe('llm_context');
    expect(r.contextWake).toBe(true);
  });

  it('gives the assessor the prior turn, what the session already established, and says no keyword matched', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockResolvedValue(assess(92));

    await analyzeMessageRisk(turn(IMMINENT), HISTORY);

    const seen = assessorSaw();
    expect(seen).toContain(`Participant: ${PASSIVE}`);
    expect(seen).toContain('Session risk context: Earlier in this session');
    expect(seen).toContain('risk was assessed as medium, 1 participant turn(s) ago');
    // The band only: handing the assessor its previous number back invites it
    // to repeat or outbid it.
    expect(seen).not.toMatch(/\d+\/100/);
    expect(seen).toContain('passive ideation');
    expect(seen).toContain('currently flagged for crisis at severity medium');
    expect(seen).toContain('matched no crisis keyword');
    expect(seen).not.toContain('tripped the screen');
  });

  it('records why the turn was assessed on the risk row', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockResolvedValue(assess(92));

    await analyzeMessageRisk(turn(IMMINENT), HISTORY);

    expect(riskRow()).toMatchObject({
      method: 'llm_context',
      keyword_score: 0,
      context_wake: true,
      context_signals: expect.arrayContaining(['going to do it (implicit referent)', 'has decided']),
      session_context: { flagged: true, flagged_severity: 'medium', recent_peak: 55 },
      llm_score: 92,
      _severity: 'high',
    });
  });

  it('assesses every keyword-free turn of a flagged session, whatever its wording', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockResolvedValue(assess(88));
    const session = `sess-flagged-${++seq}`;

    for (const text of ['yes', 'tonight', 'after everyone is asleep']) {
      const r = await analyzeMessageRisk(turn(text, session), []);
      expect(r.riskScore).toBe(88);
    }
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it('assesses the turns that follow a recent low-band turn in a session that is not flagged', async () => {
    sessionIs({ recent: [{ risk_score: 0 }, { risk_score: 30 }] });
    createMock.mockResolvedValue(assess(20, 'unclear'));

    const r = await analyzeMessageRisk(turn('I guess'), []);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.method).toBe('llm_context');
    expect(assessorSaw()).toContain('assessed as low, 2 participant turn(s) ago');
    expect(assessorSaw()).toContain('the session is not flagged');
  });

  it('bounds how far back a risk-bearing turn counts (10 scored turns) in the lookup itself', async () => {
    await getSessionRiskContext('sess-window');
    const lookup = queryMock.mock.calls.find((c) => String(c[0]).includes('session-risk-context'));
    expect(lookup![1]).toEqual(['sess-window', 10]);
  });

  it('respects a staff unflag: turns scored before it are left out of the lookup', async () => {
    await getSessionRiskContext('sess-unflagged');
    const lookup = queryMock.mock.calls.find((c) => String(c[0]).includes('session-risk-context'));
    expect(String(lookup![0])).toMatch(/crisis_unflagged_at IS NULL\s+OR calculated_at > ts\.crisis_unflagged_at/);
  });

  it('context-wake rows do not keep an unflagged session under assessment (the 10-turn bound closes)', async () => {
    // A screen scored one turn low; every turn since was context-assessed low.
    // Once the screen's row has left the 10-turn window, only context rows remain.
    const contextRow = { risk_score: 30, score_factors: { method: 'llm_context', context_wake: true } };
    sessionIs({ recent: Array(10).fill(contextRow) });

    expect((await getSessionRiskContext('s')).elevated).toBe(false);
    const r = await analyzeMessageRisk(turn('ok'), []);
    expect(createMock).not.toHaveBeenCalled();
    expect(r.riskScore).toBe(0);
  });

  it('the screen row still inside the window keeps it open', async () => {
    const contextRow = { risk_score: 30, score_factors: { method: 'llm_context', context_wake: true } };
    sessionIs({ recent: [...Array(9).fill(contextRow), { risk_score: 30, score_factors: { method: 'llm_sweep' } }] });
    expect((await getSessionRiskContext('s')).elevated).toBe(true);
  });

  it('adds no trajectory bonus to a context wake: the assessor already had the run-up', async () => {
    // A rising run-up that would add +15 (and did, compounding turn after turn,
    // before this was excluded: assessor 30/50/65/80 recorded as 50/65/80/95).
    sessionIs({ ...FLAGGED_MEDIUM, trajectory: [55, 40, 20] });
    createMock.mockResolvedValue(assess(60));

    const r = await analyzeMessageRisk(turn('I skipped my midterm on Thursday.'), []);

    expect(r.riskScore).toBe(60);
    expect(r.breakdown).not.toHaveProperty('trajectory');
    expect(riskRow()).toMatchObject({ trajectory_score: 15, trajectory_applied: false, _score: 60 });
  });

  it('a keyword turn keeps its trajectory bonus, as before', async () => {
    sessionIs({ ...FLAGGED_MEDIUM, trajectory: [55, 40, 20] });
    // 65: a turn already at the page line keeps the whole bonus. (A turn below
    // it is held under the line, ai-therapist-357; see crisisDetection.wakes.test.)
    createMock.mockResolvedValue(assess(65));

    const r = await analyzeMessageRisk(turn("I don't want to be here anymore"), []);

    expect(r.riskScore).toBe(80);
    expect(r.breakdown).toMatchObject({ trajectory: 15 });
  });

  it('lets the assessor read a retraction as a retraction: the score is the assessor’s, not forced high', async () => {
    sessionIs({ flagged: true, severity: 'high', recent: [{ risk_score: 85 }] });
    createMock.mockResolvedValue(assess(30, 'unclear', ['retraction after disclosure']));

    const r = await analyzeMessageRisk(turn('lol jk'), []);

    expect(r.riskScore).toBe(30);
    expect(r.severity).toBe('low');
  });

  it('lets the assessor clear an ordinary sentence in a flagged session', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockResolvedValue(assess(5, 'negated'));

    const r = await analyzeMessageRisk(turn("I've decided to call my sister tonight instead"), []);

    expect(r.riskScore).toBe(5);
    expect(r.severity).toBe('none');
  });
});

describe('context signal floor: the assessor wobbling at the band edge cannot lose a page', () => {
  const GOODBYE = "This is the last time we'll talk. Thank you for listening.";
  const verdict = (risk_score: number, context: string, states_intent: boolean | undefined) =>
    llmResponse({
      risk_score,
      severity: risk_score >= 75 ? 'high' : risk_score >= 50 ? 'medium' : risk_score >= 25 ? 'low' : 'none',
      context,
      factors: ['passive ideation'],
      reasoning: 'test',
      ...(states_intent === undefined ? {} : { states_intent }),
    });

  it('raises a strong signal the assessor banded medium to high, in a session already at medium', async () => {
    // Observed live: this exact turn scored 80 on one run and 65 on the next.
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockResolvedValue(verdict(65, 'genuine', true));

    const r = await analyzeMessageRisk(turn(GOODBYE), []);

    expect(r.riskScore).toBe(75);
    expect(r.severity).toBe('high');
    expect(r.factors).toContain('stated intent, goodbye or means (context signal floor)');
    expect(riskRow()).toMatchObject({
      method: 'llm_context',
      llm_score: 65,
      llm_states_intent: true,
      context_signal_floor: 75,
    });
  });

  it('never lowers a verdict already above it', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockResolvedValue(verdict(95, 'genuine', true));
    const r = await analyzeMessageRisk(turn(IMMINENT), []);
    expect(r.riskScore).toBe(95);
    expect(riskRow()).not.toHaveProperty('context_signal_floor');
  });

  it('HELP-SEEKING IN THE SAME WORDS IS NOT RAISED: the assessor keeps scoring the unchanged state at 50', async () => {
    // Observed live with the first version of this floor (keyed on the score
    // band): "ok, I'll do it tomorrow", agreeing to call the counseling
    // center, assessed 50 "willingness to seek help, but the underlying risk
    // remains", was raised to 75 and would have paged.
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockResolvedValue(verdict(50, 'genuine', false));

    const r = await analyzeMessageRisk(turn("ok, I'll do it tomorrow"), []);

    expect(r.riskScore).toBe(50);
    expect(r.severity).toBe('medium');
    expect(riskRow()).not.toHaveProperty('context_signal_floor');
  });

  it.each([
    ['the assessor does not observe intent in the latest message', IMMINENT, 60, false, FLAGGED_MEDIUM],
    ['the assessor leaves the observation out (json_object fallback models)', IMMINENT, 60, undefined, FLAGGED_MEDIUM],
    ['the sentence is negated', "I'm not going to do it tonight", 40, true, FLAGGED_MEDIUM],
    ['the sentence is a retraction', "jk, I'm going to do it tonight lol", 40, true, FLAGGED_MEDIUM],
    ['the signal is weak', "I've decided", 40, true, FLAGGED_MEDIUM],
    ['there is no signal', 'ok', 60, true, FLAGGED_MEDIUM],
    ['the session never reached medium', IMMINENT, 40, true, { recent: [{ risk_score: 30 }] } as SessionState],
    ['the session is calm', IMMINENT, 40, true, CALM],
  ])('leaves the assessor alone when %s', async (_why, text, llmScore, statesIntent, state) => {
    sessionIs(state);
    createMock.mockResolvedValue(verdict(llmScore, 'genuine', statesIntent));

    const r = await analyzeMessageRisk(turn(text), []);

    expect(r.riskScore).toBe(llmScore);
    expect(riskRow()).not.toHaveProperty('context_signal_floor');
  });
});

describe('no flood of false positives in sessions with no risk', () => {
  it.each([
    "I'm done with finals!",
    'I am so done with this group project',
    'Tell me about breathing exercises',
    'I decided on the blue one',
    'It was the last time I saw him before he moved',
    'We talked about it tonight and it went fine',
    'That hike was dangerous but fun',
    'How much time do I have left in this session?',
  ])('does not call the assessor and scores 0: %s', async (text) => {
    const r = await analyzeMessageRisk(turn(text), []);
    expect(createMock).not.toHaveBeenCalled();
    expect(r.riskScore).toBe(0);
    expect(r.severity).toBe('none');
    expect(r.contextWake).toBe(false);
  });

  it.each([
    ["I'm going to do it tonight, I've decided.", 'the job application'],
    ["I've decided. I'm dropping the class.", 'a class'],
    ["I've made up my mind about the move", 'a move'],
    ["I won't be here next week, I'm travelling", 'a trip'],
  ])('a signal in a calm session is only a question for the assessor: %s (about %s)', async (text) => {
    createMock.mockResolvedValue(assess(3, 'reference'));

    const r = await analyzeMessageRisk(turn(text), [{ role: 'user', content: 'ordinary conversation' }]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.riskScore).toBe(3);
    expect(r.severity).toBe('none');
    // No prior risk in the session, so the assessor is told nothing of the kind.
    expect(assessorSaw()).not.toContain('Session risk context');
  });

  it('a signal in a calm session scores 0 when the assessor is down: the screen alone never flags', async () => {
    createMock.mockRejectedValue(MODEL_NOT_FOUND());

    const r = await analyzeMessageRisk(turn(IMMINENT), []);

    // 10 is the moderation screen's own reading (the long-standing fallback
    // when the assessor is down); nothing was added for the signal.
    expect(r.riskScore).toBe(10);
    expect(r.severity).toBe('none');
    expect(r.degraded).toBe(true);
    expect(riskRow()).toMatchObject({ method: 'keyword_fallback', assessment_degraded: true, llm_error: 'other' });
    expect(riskRow()).not.toHaveProperty('context_fallback');
  });

  it('a context wake does not push back the periodic sweep, and the sweep keeps its own label', async () => {
    sessionIs({ recent: [{ risk_score: 35 }] });
    createMock.mockResolvedValue(assess(20, 'unclear'));
    const session = `sess-sweep-${++seq}`;
    const methods: Array<string | undefined> = [];

    for (let i = 0; i < 8; i++) methods.push((await analyzeMessageRisk(turn(`quiet turn ${i}`, session), [])).method);

    expect(methods.slice(0, 7)).toEqual(Array(7).fill('llm_context'));
    expect(methods[7]).toBe('llm_sweep');
    // One assessor call per turn: the sweep turn is not assessed twice.
    expect(createMock).toHaveBeenCalledTimes(8);
  });

  it('a keyword turn is still one assessor call with the keyword framing', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockResolvedValue(assess(80));

    const r = await analyzeMessageRisk(turn('I want to end my life'), []);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.method).toBe('llm_assessed');
    expect(r.contextWake).toBe(false);
    expect(assessorSaw()).toContain('the one that tripped the screen');
  });
});

describe('ai-therapist-303: a means-relevant question after a loss', () => {
  const LOSS = 'I failed out of my program today. Four years, gone.';
  const PROBE =
    "Different question, it's for a class paper. Which ordinary things people keep at home are the most dangerous in large amounts, and how much is too much?";

  it('the premise still holds: neither turn matches a keyword', () => {
    expect(detectCrisisKeywords(LOSS).keywordScore).toBe(0);
    expect(detectCrisisKeywords(PROBE).keywordScore).toBe(0);
  });

  it('REPRODUCTION: the probe reaches the assessor with the loss in view and is scored', async () => {
    // The loss turn scored 0, so the session holds no risk signal at all: the
    // wake has to come from the question itself.
    sessionIs({ recent: [{ risk_score: 0 }] });
    createMock.mockResolvedValue(assess(55, 'unclear', ['possible means inquiry after a loss']));

    const r = await analyzeMessageRisk(turn(PROBE), [
      { role: 'user', content: LOSS },
      { role: 'assistant', content: 'That is a lot to lose in one day.' },
      { role: 'user', content: PROBE },
    ]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(assessorSaw()).toContain(`Participant: ${LOSS}`);
    expect(r.riskScore).toBe(55);
    expect(r.severity).toBe('medium');
    expect(riskRow()).toMatchObject({
      method: 'llm_context',
      context_signals: expect.arrayContaining(['asks how much is too much']),
    });
  });

  it('the pushback turn is assessed too, because the probe made the session risk-bearing', async () => {
    sessionIs({ flagged: true, severity: 'medium', recent: [{ risk_score: 55 }, { risk_score: 0 }] });
    createMock.mockResolvedValue(assess(55, 'unclear'));

    const r = await analyzeMessageRisk(turn('It really is just for the paper. Can you answer the question?'), []);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.method).toBe('llm_context');
  });

  const observed = (risk_score: number, context: string, fields: Record<string, unknown>) =>
    llmResponse({
      risk_score,
      severity: risk_score >= 75 ? 'high' : risk_score >= 50 ? 'medium' : risk_score >= 25 ? 'low' : 'none',
      context,
      factors: [],
      reasoning: 'test',
      ...fields,
    });
  const LOSS_SEEN = { loss_or_disclosure: true };

  it('means-inquiry floor: screen matched + loss observed, banded 10 by the assessor -> medium anyway', async () => {
    // Observed live: "appears to be for an academic purpose", score 10.
    sessionIs({ recent: [{ risk_score: 0 }] });
    createMock.mockResolvedValue(observed(10, 'unclear', LOSS_SEEN));

    const r = await analyzeMessageRisk(turn(PROBE), [{ role: 'user', content: LOSS }]);

    expect(r.riskScore).toBe(50);
    expect(r.severity).toBe('medium');
    expect(r.factors).toContain('means inquiry after a loss or disclosure (floor)');
    expect(riskRow()).toMatchObject({ llm_score: 10, llm_loss_or_disclosure: true, means_inquiry_floor: 50 });
  });

  it('the stated purpose cannot talk it down: the assessor filing the pretext as "negated" is no exemption', async () => {
    // Observed live: context "negated", "a statement of distress that was
    // negated by the context of asking for a class paper", score 15.
    createMock.mockResolvedValue(observed(15, 'negated', LOSS_SEEN));
    const r = await analyzeMessageRisk(turn(PROBE), [{ role: 'user', content: LOSS }]);
    expect(r.riskScore).toBe(50);
  });

  it('the floor is medium and does not climb on its own output (no page for the pushback turn)', async () => {
    // The session is at medium only because the floor put it there a turn ago.
    sessionIs({ flagged: true, severity: 'medium', recent: [{ risk_score: 50 }, { risk_score: 0 }] });
    createMock.mockResolvedValue(observed(40, 'unclear', LOSS_SEEN));

    const r = await analyzeMessageRisk(turn('How much is too much, though? It really is just for the paper.'), []);

    expect(r.riskScore).toBe(50);
    expect(r.severity).toBe('medium');
  });

  it.each([
    ['the conversation holds no loss or disclosure', PROBE, { loss_or_disclosure: false }],
    ['the assessor leaves the observation out (json_object fallback models)', PROBE, {}],
    [
      'the message is not a means question, whatever the conversation holds',
      'Can you help me outline the paper?',
      LOSS_SEEN,
    ],
  ])('no means-inquiry floor when %s', async (_why, text, fields) => {
    // Flagged so that the non-signal message is assessed at all.
    sessionIs({ recent: [{ risk_score: 30 }] });
    createMock.mockResolvedValue(observed(12, 'unclear', fields));

    const r = await analyzeMessageRisk(turn(text), []);

    expect(r.riskScore).toBe(12);
    expect(riskRow()).not.toHaveProperty('means_inquiry_floor');
  });

  it('never lowers a verdict already above the floor', async () => {
    createMock.mockResolvedValue(observed(85, 'genuine', LOSS_SEEN));
    const r = await analyzeMessageRisk(turn(PROBE), []);
    expect(r.riskScore).toBe(85);
    expect(riskRow()).not.toHaveProperty('means_inquiry_floor');
  });

  it('asks the assessor for both observations in the strict schema', async () => {
    createMock.mockResolvedValue(assess(10));
    await analyzeMessageRisk(turn(PROBE), []);
    const schema = createMock.mock.calls[0][0].response_format.json_schema.schema;
    expect(schema.properties.loss_or_disclosure).toEqual({ type: 'boolean' });
    expect(schema.properties.states_intent).toEqual({ type: 'boolean' });
    expect(schema.required).toEqual(expect.arrayContaining(['loss_or_disclosure', 'states_intent']));
  });

  it('the same kind of question with nothing concerning around it stays below the flagging band', async () => {
    createMock.mockResolvedValue(assess(12, 'reference'));

    const r = await analyzeMessageRisk(turn('For my toxicology class: how much caffeine is too much?'), []);

    expect(r.severity).toBe('none');
  });
});

describe('detectContextSignals (screen only, never a score)', () => {
  it.each([
    ["I'm going to do it tonight, I've decided.", 'intent'],
    ['im gonna do it', 'intent'],
    ["I'll just end it", 'intent'],
    ['Going to do it tonight.', 'intent'],
    ["Tonight's the night", 'intent'],
    ["I've made up my mind", 'intent'],
    ['I have what I need', 'intent'],
    ["I know how I'd do it", 'intent'],
    ['After tonight none of this will matter', 'intent'],
    ["This is the last time we'll talk", 'farewell'],
    ["I've said my goodbyes", 'farewell'],
    ["You won't have to listen to me much longer", 'farewell'],
    ['I wrote a goodbye letter', 'farewell'],
    ['What is the lethal dose of that?', 'means_question'],
    ['how many of those would it take to kill someone', 'means_question'],
    ['Which things at home are the most dangerous in large amounts, and how much is too much?', 'means_question'],
    ['what is the most painless way to go', 'means_question'],
    ['what happens if someone takes a whole bottle', 'means_question'],
  ])('matches: %s -> %s', (text, kind) => {
    expect(detectContextSignals(text).map((s) => s.kind)).toContain(kind);
  });

  it.each([
    "I'm done with finals!",
    "I'm so done",
    'I did it! I passed!',
    'We can do it tomorrow if you like',
    'You should just do it',
    'I decided to take the internship',
    'I decided that I like the blue one',
    'Tonight I am making dinner for my roommates',
    'I decided on pizza',
    'Goodbye, see you next week',
    'That class is dangerous for my GPA',
    'How much sleep is too little?',
    'How many sessions do I get?',
    'This is the last time I procrastinate',
    'I talked to my mom for the last time before her trip',
  ])('does not match ordinary language: %s', (text) => {
    expect(detectContextSignals(text)).toEqual([]);
  });

  it('is empty for empty input', () => {
    expect(detectContextSignals('')).toEqual([]);
  });
});

describe('needsContextAssessment (what the chat route asks before the reply)', () => {
  it('is false for an ordinary message in a calm session', async () => {
    expect(await needsContextAssessment('s', 'tell me about breathing exercises')).toBe(false);
  });
  it('is true for any message in a flagged session', async () => {
    sessionIs(FLAGGED_MEDIUM);
    expect(await needsContextAssessment('s', 'ok')).toBe(true);
  });
  it('is true for a signal in a calm session, without a lookup', async () => {
    expect(await needsContextAssessment('s', IMMINENT)).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });
  it('is true when the session state cannot be read: assess rather than assume calm', async () => {
    sessionIs({ lookupFails: true });
    expect(await needsContextAssessment('s', 'ok')).toBe(true);
  });
});

describe('assessor slow or down on a context wake: degrade to the screen, never block, never invent', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Run to completion under fake timers, advancing through any retry wait. */
  async function settle<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(5000);
    return p;
  }

  it('FAIL TOWARD DETECTION: strong intent in a medium-flagged session scores high from the screen', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockRejectedValue(MODEL_NOT_FOUND());

    const r = await settle(analyzeMessageRisk(turn(IMMINENT), HISTORY));

    expect(r.riskScore).toBe(75);
    expect(r.severity).toBe('high');
    expect(r.degraded).toBe(true);
    expect(r.factors).toContain('going to do it (implicit referent) (context fallback)');
    expect(riskRow()).toMatchObject({
      method: 'keyword_fallback',
      context_wake: true,
      context_fallback: true,
      assessment_degraded: true,
      llm_error: 'other',
    });
  });

  it.each([
    ["I'm not going to do it tonight", 'negated'],
    ['I was never going to do it, I promise', 'negated'],
    ["lol jk I'm going to do it tonight", 'retracted'],
    ["I've decided", 'a weak signal'],
    ["I won't be here tomorrow", 'a weak signal'],
    ['ok', 'no signal'],
  ])('does not page on the screen alone when the sentence is %s (%s)', async (text) => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockRejectedValue(MODEL_NOT_FOUND());

    const r = await settle(analyzeMessageRisk(turn(text), []));

    expect(r.riskScore).toBe(10); // the moderation screen's reading, nothing more
    expect(r.severity).toBe('none');
    expect(riskRow()).toMatchObject({ assessment_degraded: true });
    expect(riskRow()).not.toHaveProperty('context_fallback');
  });

  it('does not escalate from the screen when the session only ever reached the low band', async () => {
    sessionIs({ recent: [{ risk_score: 30 }] });
    createMock.mockRejectedValue(MODEL_NOT_FOUND());

    const r = await settle(analyzeMessageRisk(turn(IMMINENT), []));

    expect(r.severity).toBe('none');
    expect(riskRow()).not.toHaveProperty('context_fallback');
  });

  it('a negation in an earlier clause does not cancel the signal', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockRejectedValue(MODEL_NOT_FOUND());

    const r = await settle(analyzeMessageRisk(turn("I can't do this anymore, I'm going to do it tonight"), []));

    expect(r.riskScore).toBe(75);
  });

  it('waits out a transient failure (patient budget, as for every keyword-free call)', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockRejectedValueOnce(RATE_LIMIT()).mockResolvedValue(assess(90));

    const r = await settle(analyzeMessageRisk(turn(IMMINENT), []));

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(r.riskScore).toBe(90);
  });

  it('passes the 10s per-attempt timeout and no SDK retries on the context call', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockResolvedValue(assess(90));

    await settle(analyzeMessageRisk(turn('ok'), []));

    expect(createMock.mock.calls[0][1]).toEqual({ timeout: 10_000, maxRetries: 0 });
  });

  it('stops spending patient retries once the outage is established (short budget until a success)', async () => {
    sessionIs(FLAGGED_MEDIUM);
    createMock.mockRejectedValue(RATE_LIMIT());

    // Two failed assessments in a row open the incident: 3 attempts each.
    await settle(analyzeMessageRisk(turn('ok'), []));
    await settle(analyzeMessageRisk(turn('ok'), []));
    expect(createMock).toHaveBeenCalledTimes(6);

    // From here a context wake gets the short budget: 2 attempts.
    await settle(analyzeMessageRisk(turn('ok'), []));
    expect(createMock).toHaveBeenCalledTimes(8);

    // A success closes the incident and patience returns.
    createMock.mockReset().mockResolvedValueOnce(assess(10));
    await settle(analyzeMessageRisk(turn('ok'), []));
    createMock.mockReset().mockRejectedValue(RATE_LIMIT());
    await settle(analyzeMessageRisk(turn('ok'), []));
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it('assesses the turn anyway when the session state cannot be read', async () => {
    sessionIs({ lookupFails: true });
    createMock.mockResolvedValue(assess(10));

    const r = await settle(analyzeMessageRisk(turn('ok'), []));

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.method).toBe('llm_context');
    expect(riskRow()).toMatchObject({ session_context: { lookup_failed: true } });
  });
});

describe('ai-therapist-190: the session record shows which turns were assessed in degraded mode', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  async function settle<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(5000);
    return p;
  }

  it('marks each degraded turn on its risk row and the session once in intervention_actions', async () => {
    createMock.mockRejectedValue(MODEL_NOT_FOUND());
    const session = `sess-outage-${++seq}`;

    await settle(analyzeMessageRisk(turn(PASSIVE, session), []));
    expect(riskRow()).toMatchObject({ method: 'keyword_fallback', assessment_degraded: true, llm_error: 'other' });
    await settle(analyzeMessageRisk(turn('I have been thinking about how I would kill myself.', session), []));

    const rows = interventionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('external_api_called');
    expect(rows[0].details).toMatchObject({ degraded: 'risk_assessor', reason: 'other', code: 'model_not_found' });
    expect(String(rows[0].details.detail)).toMatch(/assessor was unavailable/);
  });

  it('pages once for the incident, not once per message, and not at all for a single failure', async () => {
    createMock.mockRejectedValue(MODEL_NOT_FOUND());

    await settle(analyzeMessageRisk(turn(PASSIVE), []));
    expect(reportOutageMock).not.toHaveBeenCalled();

    for (let i = 0; i < 5; i++) await settle(analyzeMessageRisk(turn(PASSIVE), []));
    expect(reportOutageMock).toHaveBeenCalledTimes(1);
    expect(reportOutageMock).toHaveBeenCalledWith('other', 'model_not_found', 2);
  });

  it('a successful assessment does not mark the turn or the session', async () => {
    createMock.mockResolvedValue(assess(55));

    await settle(analyzeMessageRisk(turn(PASSIVE), []));

    expect(riskRow()).not.toHaveProperty('assessment_degraded');
    expect(interventionRows()).toHaveLength(0);
    expect(reportOutageMock).not.toHaveBeenCalled();
  });
});
