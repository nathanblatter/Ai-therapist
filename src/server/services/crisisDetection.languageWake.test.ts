// The language wake (ai-therapist-329), end to end through analyzeMessageRisk:
// a turn that is partly or wholly not English, and matches no (English) crisis
// keyword, is sent to the assessor instead of being scored 0 unread. And the
// other direction: English turns are untouched, the wake never scores on its
// own, and with the assessor down the turn is recorded as NOT assessed.
// OpenAI, the DB and the pager are mocked; no network.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { warmCrisisPathImports } from '../testing/warmCrisisImports.js';

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

const { analyzeMessageRisk, needsContextAssessment } = await import('./crisisDetection.service.js');
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
        }),
      },
    },
  ],
});
const MOD_QUIET = { results: [{ flagged: false, category_scores: { 'self-harm/intent': 0.01 } }] };
const MOD_LOUD = { results: [{ flagged: true, category_scores: { 'self-harm/intent': 0.9, 'self-harm': 0.9 } }] };
const SERVER_DOWN = () => Object.assign(new Error('503 upstream'), { status: 503, headers: new Headers() });

let seq = 0;
const turn = (content: string, extra: Record<string, unknown> = {}) => ({
  content,
  session_id: `sess-lang-${++seq}`,
  message_id: 7,
  ...extra,
});
function riskRow(): Record<string, unknown> {
  const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO risk_score_history'));
  expect(insert).toBeDefined();
  return { ...JSON.parse(insert![1][4] as string), _score: insert![1][2] };
}
const assessorSaw = (): string => createMock.mock.calls[0][0].messages[1].content as string;

await warmCrisisPathImports();

beforeEach(() => {
  _resetAssessorHealthForTests();
  queryMock.mockReset().mockImplementation(async (sql: unknown) => {
    if (String(sql).includes('session-risk-context')) {
      return { rows: [{ crisis_flagged: false, crisis_severity: null, recent: [] }] };
    }
    return { rows: [] };
  });
  createMock.mockReset();
  moderationCreateMock.mockReset().mockResolvedValue(MOD_QUIET);
  recentMessagesMock.mockReset().mockResolvedValue([]);
});

const PILLS = 'Tengo las pastillas en la mesa y me las voy a tomar todas.';
const SWITCH = 'I told my sister everything is okay, pero tengo un plan y las pastillas listas.';

describe('a non-English turn with no English keyword', () => {
  it('REPRODUCTION: Spanish in a calm session, quiet moderation: the assessor is asked (it used to score 0 unread)', async () => {
    createMock.mockResolvedValue(assess(85));

    const result = await analyzeMessageRisk(turn(PILLS), []);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.riskScore).toBe(85);
    expect(result.severity).toBe('high');
    expect(result.method).toBe('llm_language_wake');
    expect(riskRow()).toMatchObject({
      method: 'llm_language_wake',
      language_wake: true,
      non_english: ['crisis_word', 'function_words'],
      keyword_score: 0,
    });
  });

  it('an English sentence that switches to Spanish for the disclosure is asked too', async () => {
    createMock.mockResolvedValue(assess(80));
    const result = await analyzeMessageRisk(turn(SWITCH), []);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.severity).toBe('high');
    expect(result.method).toBe('llm_language_wake');
  });

  it('the assessor is given the message as it was typed and told no keyword matched (existing wording, nothing new)', async () => {
    createMock.mockResolvedValue(assess(85));
    await analyzeMessageRisk(turn(PILLS), []);
    expect(assessorSaw()).toContain(`"${PILLS}"`);
    expect(assessorSaw()).toContain('it matched no crisis keyword');
  });

  it('never scores on its own: benign Spanish the assessor reads as nothing stays at 0, unflagged', async () => {
    createMock.mockResolvedValue(assess(0, 'reference'));
    const result = await analyzeMessageRisk(
      turn('Hoy tuve un día muy largo en el trabajo y estoy cansada, pero bien.'),
      [],
    );
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.riskScore).toBe(0);
    expect(result.severity).toBe('none');
  });

  it('a third party in crisis, reported in Spanish, is labelled like the English report', async () => {
    createMock.mockResolvedValue(assess(80, 'bystander'));
    const result = await analyzeMessageRisk(
      turn('Mi hermano me dijo anoche que se quiere matar y no sé qué hacer.'),
      [],
    );
    expect(result.subject).toBe('third_party');
    expect(result.severity).toBe('high');
  });

  it('the pre-session check-in is covered as well', async () => {
    createMock.mockResolvedValue(assess(50));
    const result = await analyzeMessageRisk(turn('Ya no quiero vivir.', { source: 'checkin', message_id: null }), []);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.severity).toBe('medium');
  });
});

describe('what the language wake does not change', () => {
  it('an English turn with no keyword in a calm session is still not assessed', async () => {
    const result = await analyzeMessageRisk(turn('Work was long today and I am tired, but fine.'), []);
    expect(createMock).not.toHaveBeenCalled();
    expect(result.riskScore).toBe(0);
    expect(result.method).toBe('keyword_only');
    expect(riskRow()).not.toHaveProperty('non_english');
    expect(riskRow()).not.toHaveProperty('language_wake');
  });

  it('a moderation wake keeps its own label, and adds no second assessor call', async () => {
    moderationCreateMock.mockResolvedValue(MOD_LOUD);
    createMock.mockResolvedValue(assess(80));
    const result = await analyzeMessageRisk(turn('Quiero matarme.'), []);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.method).toBe('llm_moderation_wake');
    // Still recorded as not English, for the audit trail.
    expect(riskRow()).toMatchObject({ method: 'llm_moderation_wake', non_english: ['crisis_word', 'function_words'] });
    expect(riskRow()).not.toHaveProperty('language_wake');
  });

  it('a mixed message whose English half has a keyword goes the keyword way, as before', async () => {
    createMock.mockResolvedValue(assess(55));
    const result = await analyzeMessageRisk(
      turn('Estoy cansada de todo, I think everyone would be better off without me.'),
      [],
    );
    expect(result.method).toBe('llm_assessed');
    expect(assessorSaw()).toContain('the one that tripped the screen');
  });
});

describe('when the assessor cannot answer', () => {
  it('the turn is recorded as NOT assessed (degraded), never as a clean 0', async () => {
    createMock.mockRejectedValue(SERVER_DOWN());

    const result = await analyzeMessageRisk(turn(PILLS), []);

    expect(createMock).toHaveBeenCalled();
    expect(result.degraded).toBe(true);
    expect(result.method).toBe('keyword_fallback');
    expect(riskRow()).toMatchObject({
      method: 'keyword_fallback',
      assessment_degraded: true,
      non_english: ['crisis_word', 'function_words'],
    });
  });

  it('the moderation screen still raises the score while the assessor is down', async () => {
    moderationCreateMock.mockResolvedValue(MOD_LOUD);
    createMock.mockRejectedValue(SERVER_DOWN());
    const result = await analyzeMessageRisk(turn('Quiero matarme.'), []);
    expect(result.degraded).toBe(true);
    expect(result.riskScore).toBeGreaterThanOrEqual(65);
  });
});

describe('chat: assessed before the reply', () => {
  it('a non-English turn is sent to the pipeline before the model answers, with no database read needed', async () => {
    await expect(needsContextAssessment('sess-lang-chat', PILLS)).resolves.toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('an ordinary English turn in a calm session is not', async () => {
    await expect(needsContextAssessment('sess-lang-chat-2', 'Work was long today.')).resolves.toBe(false);
  });
});
