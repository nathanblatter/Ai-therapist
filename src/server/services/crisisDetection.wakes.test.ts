// Turns the screen used to leave unassessed, end to end through
// analyzeMessageRisk (goldens baseline 2026-11-18):
//  - someone else's active crisis (ai-therapist-326, owner decision: flag high
//    and page, labelled as a third party);
//  - shorthand ("ctb", "kms", "I want out");
//  - the reply to an assistant safety question in a calm session;
//  - the pre-session check-in text.
// And the other direction for each: what must not be assessed, must not be
// labelled, and must score 0 when the assessor is down.
// OpenAI, the DB and the pager are mocked; no network.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock, createMock, moderationCreateMock, recentMessagesMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  createMock: vi.fn(),
  moderationCreateMock: vi.fn(),
  recentMessagesMock: vi.fn(),
}));

vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn() } }));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('../db/crisis.queries.js', () => ({
  getRecentSessionMessages: recentMessagesMock,
  recordCrisisEvent: vi.fn(),
}));
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

const {
  analyzeMessageRisk,
  analyzeStandaloneRisk,
  buildRiskAssessmentUserMessage,
  getSessionRiskContext,
  needsContextAssessment,
  RISK_ASSESSMENT_PROMPT,
  THIRD_PARTY_FACTOR,
  HARM_TO_OTHERS_FACTOR,
  isLowContentFragment,
} = await import('./crisisDetection.service.js');
const { _resetAssessorHealthForTests } = await import('./riskAssessorHealth.service.js');

const assess = (risk_score: number, context = 'genuine', factors: string[] = []) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          risk_score,
          severity: risk_score >= 75 ? 'high' : risk_score >= 50 ? 'medium' : risk_score >= 25 ? 'low' : 'none',
          context,
          factors,
          reasoning: 'test',
          states_intent: false,
          loss_or_disclosure: false,
        }),
      },
    },
  ],
});
const MOD_QUIET = { results: [{ flagged: false, category_scores: { 'self-harm/intent': 0.1 } }] };
const MODEL_NOT_FOUND = () =>
  Object.assign(new Error('404 model_not_found'), {
    status: 404,
    code: 'model_not_found',
    type: 'invalid_request_error',
    headers: new Headers(),
  });

/** The session-risk-context lookup returns a calm, unflagged session. */
function calmSession(recent: Array<{ risk_score: number; score_factors?: Record<string, unknown> }> = []): void {
  queryMock.mockImplementation(async (sql: unknown) => {
    if (String(sql).includes('session-risk-context')) {
      return { rows: [{ crisis_flagged: false, crisis_severity: null, recent }] };
    }
    return { rows: [] };
  });
}

let seq = 0;
const turn = (content: string, extra: Record<string, unknown> = {}) => ({
  content,
  session_id: `sess-wake-${++seq}`,
  message_id: 7,
  ...extra,
});
function riskRow(): Record<string, unknown> {
  const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO risk_score_history'));
  expect(insert).toBeDefined();
  return { ...JSON.parse(insert![1][4] as string), _score: insert![1][2], _messageId: insert![1][1] };
}
const assessorSaw = (n = 0): string => createMock.mock.calls[n][0].messages[1].content as string;

beforeEach(() => {
  _resetAssessorHealthForTests();
  queryMock.mockReset();
  calmSession();
  createMock.mockReset();
  moderationCreateMock.mockReset().mockResolvedValue(MOD_QUIET);
  recentMessagesMock.mockReset().mockResolvedValue([]);
});

const ROOMMATE = "My roommate just texted me that she's going to kill herself tonight. I don't know what to do.";

describe("ai-therapist-326: someone else's active crisis", () => {
  it('REPRODUCTION: the turn reaches the assessor (it used to score 0 with no call)', async () => {
    createMock.mockResolvedValue(assess(90, 'bystander', ['third party stated intent', 'timeframe tonight']));

    const result = await analyzeMessageRisk(turn(ROOMMATE), [{ role: 'user', content: ROOMMATE }]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.riskScore).toBe(90);
    expect(result.severity).toBe('high');
  });

  it('labels the result, the factors and the risk row as a third party at risk', async () => {
    createMock.mockResolvedValue(assess(90, 'bystander', ['third party stated intent']));

    const result = await analyzeMessageRisk(turn(ROOMMATE), []);

    expect(result.thirdParty).toBe(true);
    expect(result.factors[0]).toBe(THIRD_PARTY_FACTOR);
    expect(riskRow()).toMatchObject({ third_party: true, llm_context: 'bystander', context_wake: true });
  });

  it('medium (passive, nothing imminent) is labelled too; it flags and does not page', async () => {
    createMock.mockResolvedValue(assess(55, 'bystander'));
    const result = await analyzeMessageRisk(
      turn('My mom has depression and some days she says she wishes she was not here.'),
      [],
    );
    expect(result.severity).toBe('medium');
    expect(result.thirdParty).toBe(true);
  });

  it('ordinary worry scored low by the assessor is not labelled and does not flag', async () => {
    createMock.mockResolvedValue(assess(10, 'bystander'));
    const result = await analyzeMessageRisk(turn('She keeps joking that she wants to kill herself over finals.'), []);
    expect(result.riskScore).toBe(10);
    expect(result.thirdParty).toBe(false);
    expect(result.factors).not.toContain(THIRD_PARTY_FACTOR);
    expect(riskRow().third_party).toBeUndefined();
  });

  it('"my friend has been really down lately" is not assessed at all', async () => {
    const result = await analyzeMessageRisk(turn('My friend has been really down lately.'), []);
    expect(createMock).not.toHaveBeenCalled();
    expect(result.riskScore).toBe(0);
  });

  it("the participant's own crisis is never labelled third party", async () => {
    createMock.mockResolvedValue(assess(90, 'genuine', ['stated intent']));
    const result = await analyzeMessageRisk(turn('I am going to kill myself tonight.'), []);
    expect(result.thirdParty).toBe(false);
    expect(result.factors).not.toContain(THIRD_PARTY_FACTOR);
  });

  it('assessor down: a third-person sentence is not scored by the screen (it never pages on a film plot alone)', async () => {
    createMock.mockRejectedValue(MODEL_NOT_FOUND());
    const result = await analyzeMessageRisk(turn(ROOMMATE), []);
    // 10 is the moderation mock's signal, the only thing left to score with.
    expect(result.riskScore).toBe(10);
    expect(result.severity).toBe('none');
    expect(result.degraded).toBe(true);
    expect(riskRow()).toMatchObject({ assessment_degraded: true, context_wake: true });
  });

  it('later turns are told the earlier concern was for someone else, not the participant', async () => {
    calmSession([
      { risk_score: 90, score_factors: { method: 'llm_context', third_party: true, llm_factors: ['stated intent'] } },
    ]);
    const ctx = await getSessionRiskContext('sess-third');
    expect(ctx.peakThirdParty).toBe(true);

    queryMock.mockImplementation(async (sql: unknown) =>
      String(sql).includes('session-risk-context')
        ? {
            rows: [
              {
                crisis_flagged: true,
                crisis_severity: 'high',
                recent: [{ risk_score: 90, score_factors: { third_party: true, llm_factors: ['stated intent'] } }],
              },
            ],
          }
        : { rows: [] },
    );
    createMock.mockResolvedValue(assess(20, 'bystander'));
    await analyzeMessageRisk(turn('ok I called her mom and she is going over there'), []);
    expect(assessorSaw()).toContain("SOMEONE ELSE's crisis");
    expect(assessorSaw()).not.toContain("the participant's risk was assessed as");
  });

  it('thread messages carry the same label (standalone path)', async () => {
    createMock.mockResolvedValue(assess(85, 'bystander', ['third party plan']));
    const result = await analyzeStandaloneRisk('My best friend told me he has a plan to end his life this weekend.');
    expect(result.severity).toBe('high');
    expect(result.thirdParty).toBe(true);
    expect(result.factors[0]).toBe(THIRD_PARTY_FACTOR);
  });

  it('the rubric no longer caps a third-party crisis at 20 and still keeps worry and bereavement low', () => {
    expect(RISK_ASSESSMENT_PROMPT).not.toMatch(/someone ELSE's crisis or loss → score 0-20/);
    expect(RISK_ASSESSMENT_PROMPT).toMatch(/ACTIVE or IMMINENT and unresolved → 80-100, high/);
    expect(RISK_ASSESSMENT_PROMPT).toMatch(/Ordinary worry, a past crisis that has resolved,[^\n]*→ 0-20, none\/low/);
    // The help-seeking reminder that keeps "I'm going to do it, I'll text my
    // sister tonight" from being read as intent (it flipped to a page without it).
    expect(RISK_ASSESSMENT_PROMPT).toMatch(/read the latest message once more for help-seeking/);
  });
});

describe('shorthand is routed to the assessor, never scored by the screen', () => {
  it.each(['been thinking about ctb a lot lately', 'kms', 'I want out. Like out out. Of everything.'])(
    'assessed in a calm session: %s',
    async (text) => {
      createMock.mockResolvedValue(assess(60, 'genuine', ['ideation (slang)']));
      const result = await analyzeMessageRisk(turn(text), []);
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(result.riskScore).toBe(60);
      expect(result.method).toBe('llm_context');
      // The assessor is told no keyword matched, so it reads the context.
      expect(assessorSaw()).toContain('it matched no crisis keyword');
    },
  );

  it('"CTB" as an unrelated abbreviation: the assessor clears it and nothing is flagged', async () => {
    createMock.mockResolvedValue(assess(0, 'reference'));
    const result = await analyzeMessageRisk(turn('Our CTB committee meeting got moved to Friday.'), []);
    expect(result.riskScore).toBe(0);
    expect(result.severity).toBe('none');
  });

  it('assessor down: shorthand is not a keyword tier', async () => {
    createMock.mockRejectedValue(MODEL_NOT_FOUND());
    const result = await analyzeMessageRisk(turn('our CTB meeting got moved'), []);
    expect(result.severity).toBe('none');
    expect(riskRow().keyword_score).toBe(0);
  });

  it('a slang turn does not open the context window on its own when the assessor clears it', async () => {
    // A context-wake row (even a scored one) is not a screen row, so one
    // "kms" about a bad wifi day does not put the next ten turns under
    // assessment (getSessionRiskContext counts screen rows only).
    calmSession([{ risk_score: 30, score_factors: { method: 'llm_context', context_wake: true } }]);
    expect((await getSessionRiskContext('sess-slang')).elevated).toBe(false);
  });
});

describe('the reply to an assistant safety question is assessed with the question', () => {
  const QUESTION = { role: 'assistant', content: 'Do you ever have thoughts of not wanting to be alive?' };
  const REPLY = 'yeah. kind of. most nights.';

  it('REPRODUCTION: in a calm session the reply reaches the assessor (it used to score 0 with no call)', async () => {
    createMock.mockResolvedValue(assess(55, 'genuine', ['passive ideation']));

    const result = await analyzeMessageRisk(turn(REPLY), [QUESTION, { role: 'user', content: REPLY }]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.riskScore).toBe(55);
    expect(result.severity).toBe('medium');
    expect(result.method).toBe('llm_context');
  });

  it('the assessor is given the question and told the message answers it', async () => {
    createMock.mockResolvedValue(assess(55));
    await analyzeMessageRisk(turn(REPLY), [QUESTION, { role: 'user', content: REPLY }]);
    const saw = assessorSaw();
    expect(saw).toContain('Assistant: Do you ever have thoughts of not wanting to be alive?');
    expect(saw).toContain("it is the participant's answer to the assistant's safety question just above");
    expect(saw).toContain(`"${REPLY}"`);
    expect(riskRow()).toMatchObject({ context_wake: true, answers_safety_question: true });
  });

  it('a "no" is assessed too and stays what the assessor says it is', async () => {
    createMock.mockResolvedValue(assess(5, 'negated'));
    const result = await analyzeMessageRisk(turn('no, nothing like that'), [
      QUESTION,
      { role: 'user', content: 'no, nothing like that' },
    ]);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.riskScore).toBe(5);
    expect(result.severity).toBe('none');
  });

  it('must not fire: the same short reply to an ordinary question is not assessed', async () => {
    const result = await analyzeMessageRisk(turn(REPLY), [
      { role: 'assistant', content: 'Have you been sleeping badly?' },
      { role: 'user', content: REPLY },
    ]);
    expect(createMock).not.toHaveBeenCalled();
    expect(result.riskScore).toBe(0);
  });

  it('must not fire: a later turn, once the assistant has moved on', async () => {
    await analyzeMessageRisk(turn('yeah the essay is due friday'), [
      QUESTION,
      { role: 'user', content: 'no' },
      { role: 'assistant', content: 'Okay. What is on your plate this week?' },
      { role: 'user', content: 'yeah the essay is due friday' },
    ]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('assessor down: the reply is not scored by the screen and is marked degraded, as any keyword-free turn is', async () => {
    createMock.mockRejectedValue(MODEL_NOT_FOUND());
    const result = await analyzeMessageRisk(turn(REPLY), [QUESTION, { role: 'user', content: REPLY }]);
    expect(result.severity).toBe('none');
    expect(result.degraded).toBe(true);
    expect(riskRow()).toMatchObject({ assessment_degraded: true, answers_safety_question: true });
  });

  it('the chat route is told to assess before replying (needsContextAssessment)', async () => {
    recentMessagesMock.mockResolvedValue([QUESTION, { role: 'user', content: REPLY }]);
    expect(await needsContextAssessment('sess-chat-answer', REPLY)).toBe(true);

    recentMessagesMock.mockResolvedValue([
      { role: 'assistant', content: 'What would you like to focus on today?' },
      { role: 'user', content: REPLY },
    ]);
    expect(await needsContextAssessment('sess-chat-ordinary', REPLY)).toBe(false);
  });

  it('needsContextAssessment assesses when the recent turns cannot be read', async () => {
    recentMessagesMock.mockRejectedValue(new Error('db down'));
    expect(await needsContextAssessment('sess-chat-fail', 'ok')).toBe(true);
  });

  it('the rubric tells the assessor a hedged yes is a yes', () => {
    expect(RISK_ASSESSMENT_PROMPT).toMatch(/An answer to a safety question\./);
    expect(RISK_ASSESSMENT_PROMPT).toMatch(/"most nights"/);
  });
});

describe('the pre-session check-in is scored as a first message', () => {
  const CHECKIN = "I don't really want to be alive";

  it('goes through the keyword screen and the assessor, and the row says where it came from', async () => {
    createMock.mockResolvedValue(assess(55, 'genuine', ['passive ideation']));

    const result = await analyzeMessageRisk(
      { content: CHECKIN, session_id: 'sess-checkin-1', source: 'checkin' as const },
      [],
    );

    expect(result.riskScore).toBe(55);
    expect(result.severity).toBe('medium');
    const row = riskRow();
    expect(row).toMatchObject({ source: 'checkin', method: 'llm_assessed', keyword_score: 50 });
    // The check-in is not a messages row.
    expect(row._messageId ?? null).toBeNull();
  });

  it('tells the assessor it is reading the check-in form', async () => {
    createMock.mockResolvedValue(assess(55));
    await analyzeMessageRisk({ content: CHECKIN, session_id: 'sess-checkin-2', source: 'checkin' as const }, []);
    expect(assessorSaw()).toContain('What the participant wrote in the check-in form just before this session started');
  });

  it('assessor down: the keyword tier stands, exactly as for a message', async () => {
    createMock.mockRejectedValue(MODEL_NOT_FOUND());
    const result = await analyzeMessageRisk(
      { content: CHECKIN, session_id: 'sess-checkin-3', source: 'checkin' as const },
      [],
    );
    expect(result.riskScore).toBe(50);
    expect(result.severity).toBe('medium');
  });

  it('an ordinary check-in costs no assessor call', async () => {
    const result = await analyzeMessageRisk(
      { content: 'midterms\nfigure out a study plan', session_id: 'sess-checkin-4', source: 'checkin' as const },
      [],
    );
    expect(createMock).not.toHaveBeenCalled();
    expect(result.riskScore).toBe(0);
  });
});

describe('the assessor user message', () => {
  it('is unchanged for a keyword hit and for a plain context wake', () => {
    expect(buildRiskAssessmentUserMessage('T', 'm')).toBe(
      'Recent transcript:\nT\n\nLatest participant message (the one that tripped the screen):\n"m"',
    );
    expect(buildRiskAssessmentUserMessage('T', 'm', { keywordFree: true })).toBe(
      'Recent transcript:\nT\n\nLatest participant message (it matched no crisis keyword; assess it against the transcript and any session risk context above):\n"m"',
    );
  });
});

describe('ai-therapist-330: thoughts of harming another person', () => {
  const REAL = 'I keep picturing hurting him. I know where he parks.';
  const IDIOM = "I swear I'm going to kill my lab partner, he did nothing all semester.";

  it('REPRODUCTION: the turn reaches the assessor on the realtime path (it used to score 0 with no call)', async () => {
    createMock.mockResolvedValue(assess(80, 'harm_to_others', ['intent to harm another person']));

    const result = await analyzeMessageRisk(turn(REAL), [{ role: 'user', content: REAL }]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.riskScore).toBe(80);
    expect(result.severity).toBe('high');
    expect(result.method).toBe('llm_context');
  });

  it('labels the result, the factors and the risk row as risk to others, and not as a third party', async () => {
    createMock.mockResolvedValue(assess(80, 'harm_to_others', ['intent to harm another person']));

    const result = await analyzeMessageRisk(turn(REAL), []);

    expect(result.subject).toBe('harm_to_others');
    expect(result.thirdParty).toBe(false);
    expect(result.factors[0]).toBe(HARM_TO_OTHERS_FACTOR);
    expect(riskRow()).toMatchObject({ harm_to_others: true, llm_context: 'harm_to_others', context_wake: true });
    expect(riskRow().third_party).toBeUndefined();
  });

  it('the idiom is assessed and cleared: no score, no label', async () => {
    createMock.mockResolvedValue(assess(5, 'reference'));
    const result = await analyzeMessageRisk(turn(IDIOM), []);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.riskScore).toBe(5);
    expect(result.severity).toBe('none');
    expect(result.subject).toBeUndefined();
  });

  it('frightening unwanted thoughts scored low by the assessor carry no label and do not flag', async () => {
    createMock.mockResolvedValue(assess(30, 'harm_to_others'));
    const result = await analyzeMessageRisk(
      turn("I've been having thoughts about hurting my baby sister and it scares me. I would never do it."),
      [],
    );
    expect(result.severity).toBe('low');
    expect(result.subject).toBeUndefined();
    expect(riskRow().harm_to_others).toBeUndefined();
  });

  it('assessor down: the screen alone never scores it, so the idiom cannot page', async () => {
    createMock.mockRejectedValue(MODEL_NOT_FOUND());
    for (const text of [REAL, IDIOM]) {
      const result = await analyzeMessageRisk(turn(text), []);
      expect(result.severity, text).toBe('none');
      expect(result.degraded, text).toBe(true);
    }
  });

  it('later turns are told the earlier concern was about harming someone else', async () => {
    queryMock.mockImplementation(async (sql: unknown) =>
      String(sql).includes('session-risk-context')
        ? {
            rows: [
              {
                crisis_flagged: true,
                crisis_severity: 'high',
                recent: [{ risk_score: 80, score_factors: { harm_to_others: true, llm_factors: ['intent'] } }],
              },
            ],
          }
        : { rows: [] },
    );
    expect((await getSessionRiskContext('sess-harm')).peakHarmToOthers).toBe(true);
    createMock.mockResolvedValue(assess(20, 'harm_to_others'));
    await analyzeMessageRisk(turn('ok. i am not going to do anything tonight'), []);
    expect(assessorSaw()).toContain('thoughts of harming ANOTHER person');
    expect(assessorSaw()).not.toContain("the participant's risk was assessed as");
  });

  it('thread messages carry the same label (standalone path)', async () => {
    createMock.mockResolvedValue(assess(80, 'harm_to_others'));
    const result = await analyzeStandaloneRisk(REAL);
    expect(result.subject).toBe('harm_to_others');
    expect(result.thirdParty).toBeUndefined();
    expect(result.factors[0]).toBe(HARM_TO_OTHERS_FACTOR);
  });

  it('the rubric separates idiom from credible intent and offers the context label', () => {
    expect(RISK_ASSESSMENT_PROMPT).toMatch(/Harm to others\./);
    expect(RISK_ASSESSMENT_PROMPT).toMatch(/Idiom, exaggeration and ordinary anger → 0-10, none/);
    expect(RISK_ASSESSMENT_PROMPT).toMatch(/Credible intent or planning → 75-100, high, context "harm_to_others"/);
    expect(RISK_ASSESSMENT_PROMPT).toContain('"unclear" | "harm_to_others"');
  });
});

describe('the rubric agrees with the cutoff (owner decision 2026-11-18: 65 and up is high)', () => {
  it('no band is called high that the pipeline treats as medium', async () => {
    const { RISK_BANDS } = await import('../../shared/riskBands.js');
    expect(RISK_BANDS.high).toBe(65);
    // Every "N-M, high" band in the rubric starts at or above the cutoff, and
    // every "N-M, medium" band ends below it.
    for (const m of RISK_ASSESSMENT_PROMPT.matchAll(/(\d+)-(\d+), high/g)) {
      expect(Number(m[1]), m[0]).toBeGreaterThanOrEqual(RISK_BANDS.high);
    }
    for (const m of RISK_ASSESSMENT_PROMPT.matchAll(/(\d+)-(\d+), medium/g)) {
      expect(Number(m[2]), m[0]).toBeLessThan(RISK_BANDS.high);
    }
    expect(RISK_ASSESSMENT_PROMPT).toMatch(/active ideation without plan → 65-75, high, ALWAYS at least 65/);
    expect(RISK_ASSESSMENT_PROMPT).not.toMatch(/60-75, high/);
  });

  it('65 is high and 64 is medium, end to end', async () => {
    createMock.mockResolvedValue(assess(65, 'genuine', ['active ideation']));
    expect((await analyzeMessageRisk(turn("I've been thinking about ending my life a lot lately."), [])).severity).toBe(
      'high',
    );
    createMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              risk_score: 64,
              severity: 'medium',
              context: 'genuine',
              factors: [],
              reasoning: 't',
              states_intent: false,
              loss_or_disclosure: false,
            }),
          },
        },
      ],
    });
    expect((await analyzeMessageRisk(turn('I wish I was dead.'), [])).severity).toBe('medium');
  });
});

// ai-therapist-349: in a real voice session "wait, stop" (said during a
// breathing exercise) was transcribed as "would stop" and assessed 50,
// "passive ideation, hopelessness": flagged, then paged.
describe('ai-therapist-349: a low-content fragment is not over-read', () => {
  /** One earlier low-band screen turn (work stress): every turn is context-assessed. */
  const lowSession = () => calmSession([{ risk_score: 25, score_factors: { method: 'llm_assessed' } }]);
  const mediumSession = () =>
    queryMock.mockImplementation(async (sql: unknown) =>
      String(sql).includes('session-risk-context')
        ? {
            rows: [
              {
                crisis_flagged: true,
                crisis_severity: 'medium',
                recent: [{ risk_score: 55, score_factors: { method: 'llm_assessed' } }],
              },
            ],
          }
        : { rows: [] },
    );
  const EXERCISE = [
    { role: 'user', content: 'Work has been crushing me lately.' },
    { role: 'assistant', content: 'Breathe in for four, hold, and out for six. Keep going at your own pace.' },
  ];

  it.each(['would stop', 'wait stop', 'stop', 'ok stop', 'wait, stop.', 'ok', 'um hold on one sec', 'yeah', ''])(
    'is a fragment: "%s"',
    (text) => {
      expect(isLowContentFragment(text)).toBe(true);
    },
  );

  it.each([
    'tonight',
    'pills',
    'bought a gun',
    'do it',
    'i will do it',
    'i can not',
    'make it stop',
    'i want it to stop',
    'everything would stop',
    'not anymore',
    'ok so i wait and then i stop and then i go back again', // filler words, but a whole sentence
  ])('is not a fragment (it has content, or is a sentence): "%s"', (text) => {
    expect(isLowContentFragment(text)).toBe(false);
  });

  // Review of PR 65: each of these is made only of stop/go and filler words,
  // and each can be a statement of leaving or giving up. None matches a
  // keyword or a farewell signal, so in a session that already holds a
  // low-band turn the guard was the only thing deciding whether the assessor
  // saw them, and it said no.
  it.each([
    'just let me go',
    'let me go',
    'no going back now',
    'I can go now. Goodbye.',
    'it can stop now',
    'I can stop this now',
    'goodbye',
    'bye',
    'so sorry. goodbye.',
    'I am going now. goodbye.',
  ])('words of leaving are not a fragment: "%s"', (text) => {
    expect(isLowContentFragment(text)).toBe(false);
  });

  // What must stay a fragment for ai-therapist-349 to stay fixed.
  it.each(['can we stop', 'please stop', 'wait can you stop', 'hold on', 'one sec', 'never mind', 'nothing', 'sorry'])(
    'an interruption or an acknowledgement is still a fragment: "%s"',
    (text) => {
      expect(isLowContentFragment(text)).toBe(true);
    },
  );

  it('"just let me go" after a low-band turn reaches the assessor', async () => {
    lowSession();
    createMock.mockResolvedValue(assess(55, 'genuine', ['passive ideation']));
    const result = await analyzeMessageRisk(turn('just let me go'), []);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.severity).toBe('medium');
    expect(riskRow().low_content_fragment).toBeUndefined();
  });

  // The guard never applies to a turn that has a keyword or a signal of its
  // own, however short, or to a session with no earlier risk at all (nothing
  // is skipped there that was assessed before).
  it.each(['kms', 'i want it all to stop', 'tonight', 'pills', 'i want it to stop', 'make it stop', 'no more', 'done'])(
    'a short disclosure in a low session is assessed: "%s"',
    async (text) => {
      lowSession();
      createMock.mockResolvedValue(assess(55, 'genuine', ['passive ideation']));
      await analyzeMessageRisk(turn(text), []);
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(riskRow().low_content_fragment).toBeUndefined();
    },
  );

  it('REPRODUCTION: "would stop" in a low-band session is not sent to the assessor and scores 0', async () => {
    lowSession();
    createMock.mockResolvedValue(assess(50, 'genuine', ['passive ideation', 'hopelessness']));

    const result = await analyzeMessageRisk(turn('would stop'), [...EXERCISE, { role: 'user', content: 'would stop' }]);

    expect(createMock).not.toHaveBeenCalled();
    expect(result.riskScore).toBe(0);
    expect(result.severity).toBe('none');
    expect(riskRow()).toMatchObject({ method: 'keyword_only', low_content_fragment: true });
  });

  it('a turn with content in the same session is still context-assessed', async () => {
    lowSession();
    createMock.mockResolvedValue(assess(20, 'genuine'));
    await analyzeMessageRisk(turn('tonight'), []);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(riskRow().low_content_fragment).toBeUndefined();
  });

  it('the answer to a safety question is assessed however short: "yeah" is meaningful there', async () => {
    lowSession();
    createMock.mockResolvedValue(assess(55, 'genuine', ['passive ideation']));
    const question = { role: 'assistant', content: 'Do you ever have thoughts of not wanting to be alive?' };

    const result = await analyzeMessageRisk(turn('yeah'), [question, { role: 'user', content: 'yeah' }]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.severity).toBe('medium');
  });

  it('in a session already at medium the fragment is still assessed ("ok" may answer something out of view)', async () => {
    mediumSession();
    createMock.mockResolvedValue(assess(50, 'genuine'));
    await analyzeMessageRisk(turn('would stop'), []);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('a fragment that is also a signal ("this is goodbye") is assessed', async () => {
    lowSession();
    createMock.mockResolvedValue(assess(30, 'unclear'));
    await analyzeMessageRisk(turn('this is goodbye'), []);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('when the session state cannot be read the fragment is assessed rather than assumed calm', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('session-risk-context')) throw new Error('db down');
      return { rows: [] };
    });
    createMock.mockResolvedValue(assess(0, 'unclear'));
    await analyzeMessageRisk(turn('would stop'), []);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('chat: the reply is not held for a fragment in a low session, and is for a safety answer', async () => {
    lowSession();
    recentMessagesMock.mockResolvedValue(EXERCISE);
    expect(await needsContextAssessment('sess-frag-1', 'ok stop')).toBe(false);
    expect(await needsContextAssessment('sess-frag-2', 'i feel worse')).toBe(true);
    recentMessagesMock.mockResolvedValue([{ role: 'assistant', content: 'Are you having thoughts of suicide?' }]);
    expect(await needsContextAssessment('sess-frag-3', 'yeah')).toBe(true);
  });

  it('the rubric tells the assessor to score only what was said', () => {
    expect(RISK_ASSESSMENT_PROMPT).toMatch(/Fragments\. Voice transcripts arrive in pieces/);
    expect(RISK_ASSESSMENT_PROMPT).toMatch(/do not complete it into a sentence about dying, escape or giving up/);
  });
});

// Review of PR 65. A subject label switches off the suicide ladder, swaps the
// steer for one that says not to ask about the participant's own suicidal
// thoughts, and puts "not their own" / "not self-harm" on the page. Live, the
// assessor returned harm_to_others (100, states_intent true) for "I want to
// kill him and then myself", so a murder-suicide statement was handled as risk
// to others only.
describe("a subject label never stands on a turn that also carries the participant's own risk", () => {
  const assessWithIntent = (risk_score: number, context: string, factors: string[] = []) => {
    const base = assess(risk_score, context, factors);
    const body = JSON.parse(base.choices[0].message.content) as Record<string, unknown>;
    return { choices: [{ message: { content: JSON.stringify({ ...body, states_intent: true }) } }] };
  };

  it('REPRODUCTION: harm to others + the assessor observes own intent -> handled as the participant own risk', async () => {
    createMock.mockResolvedValue(
      assessWithIntent(100, 'harm_to_others', ['intent to harm another person', 'own intent']),
    );

    const result = await analyzeMessageRisk(turn('I want to kill him and then myself'), []);

    expect(result.severity).toBe('high');
    expect(result.subject).toBeUndefined();
    expect(result.thirdParty).toBe(false);
    expect(result.factors).not.toContain(HARM_TO_OTHERS_FACTOR);
    expect(result.factors).toContain('also: thoughts of harming another person (handled as own risk)');
    expect(riskRow()).toMatchObject({ subject_overridden: 'harm_to_others', llm_context: 'harm_to_others' });
    expect(riskRow().harm_to_others).toBeUndefined();
  });

  it('harm to others + a first-person keyword in the same message -> own risk, even if the assessor missed the intent', async () => {
    createMock.mockResolvedValue(assess(85, 'harm_to_others', ['intent to harm another person']));

    const result = await analyzeMessageRisk(turn("I'm going to hurt him and then kill myself"), []);

    expect(result.subject).toBeUndefined();
    expect(riskRow()).toMatchObject({ subject_overridden: 'harm_to_others' });
  });

  it('a third-party report in which the assessor observes the participant own intent -> own risk', async () => {
    createMock.mockResolvedValue(assessWithIntent(90, 'bystander', ['third party stated intent', 'own intent']));

    const result = await analyzeMessageRisk(turn(`${ROOMMATE} If she does it I am doing it too, tonight.`), []);

    expect(result.thirdParty).toBe(false);
    expect(result.subject).toBeUndefined();
    expect(result.factors).not.toContain(THIRD_PARTY_FACTOR);
  });

  it('a QUOTED first-person keyword does not undo a third-party label ("she texted: I want to kill myself")', async () => {
    createMock.mockResolvedValue(assess(90, 'bystander', ['third party stated intent']));

    const result = await analyzeMessageRisk(turn('My roommate just texted me "I want to kill myself tonight"'), []);

    expect(result.thirdParty).toBe(true);
    expect(result.subject).toBe('third_party');
  });

  it('plain risk to others keeps its label', async () => {
    createMock.mockResolvedValue(assess(80, 'harm_to_others', ['intent to harm another person']));
    const result = await analyzeMessageRisk(turn('I keep picturing hurting him. I know where he parks.'), []);
    expect(result.subject).toBe('harm_to_others');
    expect(riskRow().subject_overridden).toBeUndefined();
  });
});
