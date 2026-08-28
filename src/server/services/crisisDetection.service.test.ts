import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the DB pool, secrets, and OpenAI so the tests exercise the two-stage
// risk pipeline (keyword screen → LLM context assessment → fallback) without
// touching Postgres or the network.
const { queryMock, createMock, connectMock, draftAeMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  createMock: vi.fn(),
  connectMock: vi.fn(),
  draftAeMock: vi.fn(),
}));

vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: connectMock },
}));

// The high-severity flag fires a fire-and-forget AE auto-draft (ai-therapist-95).
vi.mock('./adverseEvent.service.js', () => ({
  draftAdverseEventFromCrisis: draftAeMock,
}));

vi.mock('../config/secrets.js', () => ({
  getOpenAIKey: vi.fn().mockResolvedValue('test-key'),
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

const { detectCrisisKeywords, analyzeMessageRisk, analyzeStandaloneRisk, flagSessionCrisis } = await import('./crisisDetection.service.js');

function llmResponse(payload: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

describe('detectCrisisKeywords (stage 1 screen)', () => {
  it('scores explicit ideation as high tier (75)', () => {
    const r = detectCrisisKeywords('sometimes I think about suicide');
    expect(r.keywordScore).toBe(75);
    expect(r.keywords).toContain('suicide');
  });

  it('scores passive ideation as medium tier (40) — the old list missed these', () => {
    const r = detectCrisisKeywords("honestly I just don't want to be here anymore");
    expect(r.keywordScore).toBe(40);
  });

  it('scores acute distress as low tier (15)', () => {
    const r = detectCrisisKeywords('everything feels hopeless');
    expect(r.keywordScore).toBe(15);
  });

  it('normalizes curly quotes from Whisper transcripts', () => {
    const r = detectCrisisKeywords('I don’t want to be here');
    expect(r.keywordScore).toBe(40);
  });

  // ai-therapist-126: the spoken contraction slipped past the screen entirely
  // (score 0 → no LLM assessment) in the voice crisis ladder.
  it("normalizes colloquial contractions — the exact voice-transcript phrase that scored 0", () => {
    const r = detectCrisisKeywords("Honestly, some days I don't wanna be here anymore.");
    expect(r.keywordScore).toBe(40);
  });

  it('normalizes missing apostrophes from typed chat', () => {
    expect(detectCrisisKeywords('i dont want to be here').keywordScore).toBe(40);
    expect(detectCrisisKeywords('i cant go on').keywordScore).toBe(40);
  });

  it('catches "wanna die" via wanna → want to normalization (high tier)', () => {
    expect(detectCrisisKeywords('some days i just wanna die').keywordScore).toBe(75);
  });

  it('covers additional passive-ideation phrasings', () => {
    expect(detectCrisisKeywords("i'm so tired of living").keywordScore).toBe(40);
    expect(detectCrisisKeywords("i don't wanna be alive").keywordScore).toBe(40);
    expect(detectCrisisKeywords("i don't want to wake up tomorrow").keywordScore).toBe(40);
  });

  it('takes the max tier when multiple match', () => {
    const r = detectCrisisKeywords("I feel hopeless and want to die");
    expect(r.keywordScore).toBe(75);
  });

  it('returns 0 for ordinary content', () => {
    const r = detectCrisisKeywords('work was stressful but the weekend helped');
    expect(r.keywordScore).toBe(0);
    expect(r.keywords).toEqual([]);
  });
});

describe('analyzeMessageRisk (two-stage pipeline)', () => {
  beforeEach(() => {
    queryMock.mockReset().mockResolvedValue({ rows: [] });
    createMock.mockReset();
  });

  const msg = (content: string) => ({ content, session_id: 'sess-test', message_id: 1 });

  it('skips the LLM entirely when no keywords match', async () => {
    const r = await analyzeMessageRisk(msg('tell me about breathing exercises'));
    expect(r.riskScore).toBe(0);
    expect(r.severity).toBe('none');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('lets the LLM downgrade a keyword hit that is just a reference (988 problem)', async () => {
    createMock.mockResolvedValue(llmResponse({
      risk_score: 5, severity: 'none', context: 'reference',
      factors: [], reasoning: 'Participant is asking about the suicide prevention hotline, not expressing ideation.',
    }));
    const r = await analyzeMessageRisk(
      msg('what is the number for the suicide prevention hotline?'),
      [{ role: 'user', content: 'what is the number for the suicide prevention hotline?' }],
    );
    expect(r.riskScore).toBe(5);
    expect(r.severity).toBe('none');
    expect(createMock).toHaveBeenCalledOnce();
  });

  it('lets the LLM upgrade genuine ideation with context', async () => {
    createMock.mockResolvedValue(llmResponse({
      risk_score: 82, severity: 'high', context: 'genuine',
      factors: ['active ideation', 'expressed plan'], reasoning: 'Active ideation with plan.',
    }));
    const r = await analyzeMessageRisk(msg('I want to die and I know how I would do it'), []);
    expect(r.riskScore).toBe(82);
    expect(r.severity).toBe('high');
    expect(r.factors).toEqual(['active ideation', 'expressed plan']);
  });

  it('falls back to the keyword tier score when the LLM fails (fail toward detection)', async () => {
    createMock.mockRejectedValue(new Error('openai down'));
    const r = await analyzeMessageRisk(msg('I want to end my life'), []);
    expect(r.riskScore).toBe(75);
    expect(r.severity).toBe('high');
  });

  it('maps graduated severity bands from the LLM score', async () => {
    createMock.mockResolvedValue(llmResponse({
      risk_score: 55, severity: 'medium', context: 'genuine',
      factors: ['passive ideation'], reasoning: 'Passive ideation, no plan.',
    }));
    const r = await analyzeMessageRisk(msg("I don't want to be here anymore"), []);
    expect(r.severity).toBe('medium');
  });

  it('runs a periodic LLM sweep after 8 quiet user messages (no keyword trip)', async () => {
    createMock.mockResolvedValue(llmResponse({
      risk_score: 30, severity: 'low', context: 'genuine',
      factors: ['withdrawal'], reasoning: 'Increasing withdrawal without explicit language.',
    }));
    const sweepMsg = (i: number) => ({ content: `ordinary message ${i}`, session_id: 'sess-sweep', message_id: i });
    for (let i = 1; i <= 7; i++) {
      const r = await analyzeMessageRisk(sweepMsg(i), []);
      expect(r.riskScore).toBe(0);
    }
    expect(createMock).not.toHaveBeenCalled();
    // 8th quiet message triggers the sweep.
    const r = await analyzeMessageRisk(sweepMsg(8), []);
    expect(createMock).toHaveBeenCalledOnce();
    expect(r.riskScore).toBe(30);
    // Counter reset: the 9th message doesn't sweep again.
    await analyzeMessageRisk(sweepMsg(9), []);
    expect(createMock).toHaveBeenCalledOnce();
  });

  it('adds a trajectory bonus to a risky message after a deteriorating run-up', async () => {
    // Trajectory SELECT returns 3+ strictly increasing prior scores.
    queryMock.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM risk_score_history') && String(sql).includes('SELECT')) {
        return Promise.resolve({
          rows: [
            { risk_score: 40, calculated_at: new Date() },
            { risk_score: 30, calculated_at: new Date() },
            { risk_score: 20, calculated_at: new Date() },
          ], // DESC order; service reverses to chronological 20→30→40
        });
      }
      return Promise.resolve({ rows: [] });
    });
    createMock.mockResolvedValue(llmResponse({
      risk_score: 55, severity: 'medium', context: 'genuine',
      factors: ['passive ideation'], reasoning: 'Escalating passive ideation.',
    }));
    const r = await analyzeMessageRisk({ content: "I can't go on like this", session_id: 'sess-traj', message_id: 1 }, []);
    expect(r.riskScore).toBe(70); // 55 + 15 deteriorating-trend bonus
    expect(r.factors).toContain('trajectory: deteriorating');
    expect(r.breakdown.trajectory).toBe(15);
  });

  it('never applies trajectory bonus to a zero-risk message', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM risk_score_history') && String(sql).includes('SELECT')) {
        return Promise.resolve({
          rows: [
            { risk_score: 40, calculated_at: new Date() },
            { risk_score: 30, calculated_at: new Date() },
            { risk_score: 20, calculated_at: new Date() },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await analyzeMessageRisk({ content: 'the weather is nice today', session_id: 'sess-traj-zero', message_id: 2 }, []);
    expect(r.riskScore).toBe(0);
  });

  it('logs the assessment to risk_score_history with both stage breakdowns', async () => {
    createMock.mockResolvedValue(llmResponse({
      risk_score: 5, severity: 'none', context: 'bystander',
      factors: [], reasoning: 'Talking about a friend.',
    }));
    await analyzeMessageRisk(msg('my friend attempted suicide last year'), []);
    const historyInsert = queryMock.mock.calls.find(c => String(c[0]).includes('INSERT INTO risk_score_history'));
    expect(historyInsert).toBeDefined();
    const factorsJson = JSON.parse(historyInsert![1][4] as string);
    expect(factorsJson.method).toBe('llm_assessed');
    expect(factorsJson.keyword_score).toBe(75);
    expect(factorsJson.llm_score).toBe(5);
    expect(factorsJson.llm_context).toBe('bystander');
  });
});

describe('analyzeStandaloneRisk (messaging slice: no session machinery)', () => {
  beforeEach(() => {
    queryMock.mockReset().mockResolvedValue({ rows: [] });
    createMock.mockReset();
  });

  it('returns zero without an LLM call — and without any DB write — when no keywords match', async () => {
    const r = await analyzeStandaloneRisk('thanks, see you at our appointment');
    expect(r).toEqual({ riskScore: 0, severity: 'none', factors: [], method: 'keyword_only' });
    expect(createMock).not.toHaveBeenCalled();
    // No risk_score_history insert, no trajectory read: standalone content
    // has no session to log against.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('runs the stage-2 LLM on a keyword hit and returns its contextual verdict', async () => {
    createMock.mockResolvedValue(llmResponse({
      risk_score: 55, severity: 'medium', context: 'genuine',
      factors: ['passive ideation'], reasoning: 'Expressed wish to not be here.',
    }));
    const r = await analyzeStandaloneRisk(
      "lately I don't want to be here anymore",
      [{ role: 'assistant', content: 'How have things been since we spoke?' }],
    );
    expect(r.riskScore).toBe(55);
    expect(r.severity).toBe('medium');
    expect(r.factors).toEqual(['passive ideation']);
    expect(r.method).toBe('llm_assessed');
    expect(createMock).toHaveBeenCalledOnce();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('falls back to the keyword tier score when the LLM fails (fail toward detection)', async () => {
    createMock.mockRejectedValue(new Error('LLM unavailable'));
    const r = await analyzeStandaloneRisk('I keep thinking about suicide');
    expect(r.riskScore).toBe(75);
    expect(r.severity).toBe('high');
    expect(r.method).toBe('keyword_fallback');
    expect(r.factors).toContain('suicide');
  });

  it('never runs a periodic sweep: keyword-free messages stay LLM-free forever', async () => {
    for (let i = 0; i < 12; i++) {
      await analyzeStandaloneRisk('another completely neutral check-in message');
    }
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('flagSessionCrisis → adverse-event auto-draft hook', () => {
  beforeEach(() => {
    draftAeMock.mockReset().mockResolvedValue(1);
    // A fake pooled client whose BEGIN/UPDATE/INSERT/COMMIT all succeed.
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    connectMock.mockReset().mockResolvedValue(client);
  });

  it('schedules an AE draft on a high-severity flag', async () => {
    await flagSessionCrisis('sess-hi', 'high', 90, 'system', 'auto', 1, ['plan'], null);
    // The draft is fire-and-forget after COMMIT; let the microtask run.
    await new Promise(r => setTimeout(r, 0));
    expect(draftAeMock).toHaveBeenCalledWith('sess-hi');
  });

  it('does NOT schedule an AE draft on medium or low flags', async () => {
    await flagSessionCrisis('sess-med', 'medium', 60, 'system', 'auto', 1, [], null);
    await flagSessionCrisis('sess-low', 'low', 30, 'system', 'auto', 1, [], null);
    await new Promise(r => setTimeout(r, 0));
    expect(draftAeMock).not.toHaveBeenCalled();
  });
});
