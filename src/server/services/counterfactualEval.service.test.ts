// Counterfactual sweep decision logic (ai-therapist-236 chunk 3): replay vs
// fork mode selection, the non-study guard on the fork path, decision-point
// resolution, per-candidate error envelopes, judge gating and the persisted
// shapes. OpenAI and GPT-Live are mocked; nothing here touches the network.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  queryMock,
  responsesCreate,
  chatCreate,
  getSessionMessagesMock,
  getSessionConfigMock,
  createRunMock,
  recordResponseMock,
  recordJudgementMock,
  finishRunMock,
  getRunMock,
  forkAndProbeMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  responsesCreate: vi.fn(),
  chatCreate: vi.fn(),
  getSessionMessagesMock: vi.fn(),
  getSessionConfigMock: vi.fn(),
  createRunMock: vi.fn(),
  recordResponseMock: vi.fn(),
  recordJudgementMock: vi.fn(),
  finishRunMock: vi.fn(),
  getRunMock: vi.fn(),
  forkAndProbeMock: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    responses = { create: responsesCreate };
    chat = { completions: { create: chatCreate } };
  },
}));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn(), on: vi.fn() } }));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('sk-test') }));
vi.mock('../db/index.js', () => ({
  getSessionMessages: getSessionMessagesMock,
  getSessionConfig: getSessionConfigMock,
}));
vi.mock('../db/counterfactual.queries.js', () => ({
  createCounterfactualRun: createRunMock,
  recordCounterfactualResponse: recordResponseMock,
  recordCounterfactualJudgement: recordJudgementMock,
  finishCounterfactualRun: finishRunMock,
  getCounterfactualRun: getRunMock,
  listCounterfactualRuns: vi.fn(),
}));
vi.mock('./liveFork.service.js', () => ({ forkAndProbe: forkAndProbeMock }));

import { runCounterfactual, findRiskSpikePoint } from './counterfactualEval.service.js';

const SESSION = 'sess-1234567890abcdef';

// system turn dropped, redacted fallback used, blank assistant turn dropped.
const MESSAGES = [
  { role: 'system', content: 'sys prompt', content_redacted: null },
  { role: 'user', content: 'hello there', content_redacted: 'hello there' },
  { role: 'assistant', content: 'hi, how are you', content_redacted: null },
  { role: 'user', content: null, content_redacted: 'I have been feeling low' },
  { role: 'assistant', content: '   ', content_redacted: null },
];

const REPLY = { output_text: ' A caring reply. ', usage: { input_tokens: 100, output_tokens: 50 } };

function forkRow(overrides: Partial<{ is_demo: boolean | null; live_id: string | null; created_at: Date }> = {}) {
  return { rows: [{ is_demo: true, live_id: 'live_src_1', created_at: new Date(), ...overrides }] };
}

beforeEach(() => {
  for (const m of [queryMock, responsesCreate, chatCreate, getSessionMessagesMock, getSessionConfigMock,
    createRunMock, recordResponseMock, recordJudgementMock, finishRunMock, getRunMock, forkAndProbeMock]) {
    m.mockReset();
  }
  getSessionMessagesMock.mockResolvedValue(MESSAGES);
  getSessionConfigMock.mockResolvedValue({ instructions: 'Be kind.', live_backend_model: 'gpt-5.6-terra' });
  createRunMock.mockResolvedValue({ id: 7 });
  recordResponseMock.mockResolvedValue(undefined);
  recordJudgementMock.mockResolvedValue(undefined);
  finishRunMock.mockResolvedValue(undefined);
  getRunMock.mockResolvedValue({ run: { id: 7 }, responses: [] });
  responsesCreate.mockResolvedValue(REPLY);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runCounterfactual replay mode (default)', () => {
  it('branches at the last participant turn, replays only the prior history, and never touches the fork guard', async () => {
    const summary = await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'] });

    // Replay works on any session: no therapy_sessions lookup, no fork.
    expect(queryMock).not.toHaveBeenCalled();
    expect(forkAndProbeMock).not.toHaveBeenCalled();
    expect(getSessionMessagesMock).toHaveBeenCalledWith(SESSION, false);

    expect(summary).toEqual({
      runId: 7,
      sessionId: SESSION,
      mode: 'replay',
      probeText: 'I have been feeling low',
      decisionPoint: 2,
      baselineModel: 'gpt-5.6-terra',
      candidates: 1,
      succeeded: 1,
      failed: 0,
    });

    expect(createRunMock).toHaveBeenCalledWith({
      sessionId: SESSION,
      mode: 'replay',
      decisionPoint: 2,
      probeText: 'I have been feeling low',
      probeReason: 'manual',
      baselineModel: 'gpt-5.6-terra',
      createdBy: null,
    });

    const [req] = responsesCreate.mock.calls[0] as [Record<string, unknown>];
    expect(req.model).toBe('gpt-5-nano');
    expect(req.instructions).toBe('Be kind.');
    // Participant content is never retained vendor-side on the replay path.
    expect(req.store).toBe(false);
    const input = req.input as string;
    expect(input).toContain('Participant: hello there\nAssistant: hi, how are you');
    expect(input).toContain('The participant has just said:\n"I have been feeling low"');
    // The probe itself is not part of the replayed history.
    expect(input).not.toContain('Participant: I have been feeling low');
    expect(input).not.toContain('sys prompt');

    expect(recordResponseMock).toHaveBeenCalledWith({
      runId: 7,
      model: 'gpt-5-nano',
      responseText: 'A caring reply.',
      tokensIn: 100,
      tokensOut: 50,
      // 100 in * $0.05/M + 50 out * $0.4/M
      estimatedCostUsd: 0.000025,
      latencyMs: expect.any(Number),
      error: null,
    });
    expect(finishRunMock).toHaveBeenCalledWith(7, 'completed', null);
  });

  it('falls back to a default prompt and null baseline when the session has no config', async () => {
    getSessionConfigMock.mockResolvedValue(null);
    const summary = await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'] });
    expect(summary.baselineModel).toBeNull();
    const [req] = responsesCreate.mock.calls[0] as [Record<string, unknown>];
    expect(req.instructions).toBe('You are a supportive mental-health assistant.');
    expect(createRunMock.mock.calls[0][0]).toMatchObject({ baselineModel: null });
  });

  it('passes createdBy and probeReason through to the run row', async () => {
    await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'], createdBy: 'admin', probeReason: 'risk_spike' });
    expect(createRunMock.mock.calls[0][0]).toMatchObject({ createdBy: 'admin', probeReason: 'risk_spike' });
  });

  it('honours an explicit participant decision point and replays only what came before it', async () => {
    const summary = await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'], decisionPoint: 0 });
    expect(summary.decisionPoint).toBe(0);
    expect(summary.probeText).toBe('hello there');
    const [req] = responsesCreate.mock.calls[0] as [Record<string, unknown>];
    expect(req.input).toContain('Conversation so far:\n\n\n');
    expect(req.input).not.toContain('hi, how are you');
  });

  it('rejects an assistant turn as the decision point', async () => {
    await expect(runCounterfactual({ sessionId: SESSION, decisionPoint: 1 }))
      .rejects.toThrow(/Decision point 1 is an assistant turn/);
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range decision point', async () => {
    await expect(runCounterfactual({ sessionId: SESSION, decisionPoint: 99 }))
      .rejects.toThrow('Decision point 99 is out of range.');
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it('refuses a session with no conversation content', async () => {
    getSessionMessagesMock.mockResolvedValue([{ role: 'system', content: 'x', content_redacted: null }]);
    await expect(runCounterfactual({ sessionId: SESSION }))
      .rejects.toThrow(`Session ${SESSION} has no conversation content to branch from.`);
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it('refuses a session with assistant-only turns', async () => {
    getSessionMessagesMock.mockResolvedValue([{ role: 'assistant', content: 'hi', content_redacted: null }]);
    await expect(runCounterfactual({ sessionId: SESSION }))
      .rejects.toThrow(`Session ${SESSION} contains no participant turns.`);
  });

  it('caps the replayed transcript at the most recent 12k characters', async () => {
    const long = 'x'.repeat(20_000);
    getSessionMessagesMock.mockResolvedValue([
      { role: 'user', content: 'OLDEST', content_redacted: null },
      { role: 'assistant', content: long, content_redacted: null },
      { role: 'user', content: 'probe', content_redacted: null },
    ]);
    await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'] });
    const [req] = responsesCreate.mock.calls[0] as [Record<string, unknown>];
    const input = req.input as string;
    expect(input).not.toContain('OLDEST');
    expect(input).toContain('x'.repeat(12_000));
    expect(input).not.toContain('x'.repeat(12_001));
  });

  it('records an empty backend reply as a failed candidate with no cost', async () => {
    responsesCreate.mockResolvedValue({ output_text: '  \n', usage: { input_tokens: 10, output_tokens: 0 } });
    const summary = await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'] });
    expect(summary).toMatchObject({ succeeded: 0, failed: 1 });
    expect(recordResponseMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5-nano',
      responseText: null,
      estimatedCostUsd: null,
      error: 'candidate produced no backend text',
    }));
    expect(finishRunMock).toHaveBeenCalledWith(7, 'failed', 'every candidate failed');
  });

  it('isolates a rejected candidate: records its error and keeps the sweep going', async () => {
    responsesCreate.mockImplementation(async ({ model }: { model: string }) => {
      if (model === 'gpt-bogus') throw new Error('HTTP 404 model not found');
      return REPLY;
    });
    const summary = await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano', 'gpt-bogus'] });
    expect(summary).toMatchObject({ candidates: 2, succeeded: 1, failed: 1 });
    expect(recordResponseMock).toHaveBeenCalledWith({ runId: 7, model: 'gpt-bogus', error: 'HTTP 404 model not found' });
    expect(finishRunMock).toHaveBeenCalledWith(7, 'completed', null);
  });

  it('still counts the failure when recording the failure itself fails', async () => {
    responsesCreate.mockRejectedValue(new Error('rate limited'));
    recordResponseMock.mockRejectedValue(new Error('db down'));
    const summary = await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'] });
    expect(summary).toMatchObject({ succeeded: 0, failed: 1 });
    expect(finishRunMock).toHaveBeenCalledWith(7, 'failed', 'every candidate failed');
  });

  it('records a successful unknown model with a null cost rather than dropping it', async () => {
    const summary = await runCounterfactual({ sessionId: SESSION, models: ['gpt-99-new'] });
    expect(summary).toMatchObject({ succeeded: 1, failed: 0 });
    expect(recordResponseMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-99-new',
      responseText: 'A caring reply.',
      estimatedCostUsd: null,
      error: null,
    }));
  });

  it('runs the default sweep when no models are given', async () => {
    const summary = await runCounterfactual({ sessionId: SESSION });
    expect(summary.candidates).toBeGreaterThan(1);
    expect(responsesCreate).toHaveBeenCalledTimes(summary.candidates);
  });
});

describe('runCounterfactual fork mode guard', () => {
  it('refuses a participant (non-demo) session before creating a run', async () => {
    queryMock.mockResolvedValue(forkRow({ is_demo: false }));
    await expect(runCounterfactual({ sessionId: SESSION, mode: 'fork', models: ['gpt-5-nano'] }))
      .rejects.toThrow(/Fork mode is restricted to non-study sessions/);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SELECT is_demo, openai_live_session_id AS live_id, created_at\s+FROM therapy_sessions WHERE session_id = \$1/);
    expect(params).toEqual([SESSION]);
    expect(createRunMock).not.toHaveBeenCalled();
    expect(forkAndProbeMock).not.toHaveBeenCalled();
  });

  it('treats a null is_demo as a study session', async () => {
    queryMock.mockResolvedValue(forkRow({ is_demo: null }));
    await expect(runCounterfactual({ sessionId: SESSION, mode: 'fork' }))
      .rejects.toThrow(/restricted to non-study sessions/);
  });

  it('refuses an unknown session', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(runCounterfactual({ sessionId: SESSION, mode: 'fork' }))
      .rejects.toThrow(`Session ${SESSION} not found`);
  });

  it('refuses a demo session that never ran on GPT-Live', async () => {
    queryMock.mockResolvedValue(forkRow({ live_id: null }));
    await expect(runCounterfactual({ sessionId: SESSION, mode: 'fork' }))
      .rejects.toThrow(/has no GPT-Live session id/);
  });

  it('refuses a session older than the 30-day recording window', async () => {
    queryMock.mockResolvedValue(forkRow({ created_at: new Date(Date.now() - 31 * 86_400_000) }));
    await expect(runCounterfactual({ sessionId: SESSION, mode: 'fork' }))
      .rejects.toThrow(/is 31 days old; GPT-Live recordings expire after 30 days/);
  });

  it('allows a 29-day-old demo Live session', async () => {
    queryMock.mockResolvedValue(forkRow({ created_at: new Date(Date.now() - 29 * 86_400_000) }));
    forkAndProbeMock.mockResolvedValue({
      forkSessionId: 'f1', responseText: 'ok', spokenText: 'ok', tokensIn: 1, tokensOut: 1,
      latencyMs: 5, voiceSeconds: 1, error: null,
    });
    await expect(runCounterfactual({ sessionId: SESSION, mode: 'fork', models: ['gpt-5-nano'] })).resolves.toMatchObject({ mode: 'fork' });
  });
});

describe('runCounterfactual fork mode', () => {
  beforeEach(() => {
    queryMock.mockResolvedValue(forkRow());
  });

  it('forks the stored Live session onto the candidate backend and records spoken text', async () => {
    forkAndProbeMock.mockResolvedValue({
      forkSessionId: 'live_fork_1',
      responseText: 'backend reasoning',
      spokenText: 'what the voice said',
      tokensIn: 200,
      tokensOut: 100,
      latencyMs: 1500,
      voiceSeconds: 4,
      error: null,
    });

    const summary = await runCounterfactual({ sessionId: SESSION, mode: 'fork', models: ['gpt-5-nano'] });
    expect(summary).toMatchObject({ mode: 'fork', succeeded: 1, failed: 0 });
    expect(responsesCreate).not.toHaveBeenCalled();

    expect(forkAndProbeMock).toHaveBeenCalledWith({
      sourceSessionId: 'live_src_1',
      apiKey: 'sk-test',
      backendModel: 'gpt-5-nano',
      backendInstructions: 'Be kind.',
      probeText: 'I have been feeling low',
    });
    expect(createRunMock.mock.calls[0][0]).toMatchObject({ mode: 'fork' });
    expect(recordResponseMock).toHaveBeenCalledWith({
      runId: 7,
      model: 'gpt-5-nano',
      responseText: 'backend reasoning',
      spokenText: 'what the voice said',
      tokensIn: 200,
      tokensOut: 100,
      // 200 * 0.05/M + 100 * 0.4/M
      estimatedCostUsd: 0.00005,
      latencyMs: 1500,
      error: null,
    });
  });

  it('records a fork error envelope as a failed candidate with no cost', async () => {
    forkAndProbeMock.mockResolvedValue({
      forkSessionId: null, responseText: '', spokenText: '', tokensIn: null, tokensOut: null,
      latencyMs: 0, voiceSeconds: null, error: 'fork rejected: HTTP 404',
    });
    const summary = await runCounterfactual({ sessionId: SESSION, mode: 'fork', models: ['gpt-5-nano'] });
    expect(summary).toMatchObject({ succeeded: 0, failed: 1 });
    expect(recordResponseMock).toHaveBeenCalledWith(expect.objectContaining({
      responseText: null,
      spokenText: null,
      estimatedCostUsd: null,
      error: 'fork rejected: HTTP 404',
    }));
    expect(finishRunMock).toHaveBeenCalledWith(7, 'failed', 'every candidate failed');
  });

  it('treats a fork that resolved with no backend text as a failure', async () => {
    forkAndProbeMock.mockResolvedValue({
      forkSessionId: 'f', responseText: '', spokenText: 'hmm', tokensIn: 5, tokensOut: 0,
      latencyMs: 10, voiceSeconds: 2, error: null,
    });
    await runCounterfactual({ sessionId: SESSION, mode: 'fork', models: ['gpt-5-nano'] });
    expect(recordResponseMock).toHaveBeenCalledWith(expect.objectContaining({
      estimatedCostUsd: null,
      error: 'candidate produced no backend text',
    }));
  });
});

describe('runCounterfactual judge gating', () => {
  const verdict = { scores: { empathy: 4, clinical_appropriateness: 5, specificity: 3, spoken_quality: 4 }, rationale: 'solid' };

  beforeEach(() => {
    getRunMock.mockResolvedValue({
      run: { id: 7 },
      responses: [
        { model: 'good', response_text: 'A reply', error: null },
        { model: 'empty', response_text: null, error: 'candidate produced no backend text' },
        { model: 'errored-with-text', response_text: 'partial', error: 'timed out' },
      ],
    });
    chatCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(verdict) } }] });
  });

  it('does not judge unless asked', async () => {
    await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'] });
    expect(getRunMock).not.toHaveBeenCalled();
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it('judges only candidates with text and no error, using the 4.x parameter shape by default', async () => {
    await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'], judge: true });

    expect(getRunMock).toHaveBeenCalledWith(7);
    expect(chatCreate).toHaveBeenCalledTimes(1);
    const [req] = chatCreate.mock.calls[0] as [Record<string, unknown>];
    expect(req.model).toBe('gpt-4o-mini');
    expect(req.response_format).toEqual({ type: 'json_object' });
    expect(req.temperature).toBe(0);
    expect(req.max_tokens).toBe(400);
    expect(req).not.toHaveProperty('max_completion_tokens');
    const messages = req.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toContain('Participant said:\n"I have been feeling low"');
    expect(messages[1].content).toContain('Candidate response:\n"A reply"');

    expect(recordJudgementMock).toHaveBeenCalledTimes(1);
    expect(recordJudgementMock).toHaveBeenCalledWith(7, 'good', verdict.scores, 'solid');
  });

  it('emits the reasoning-generation parameter shape for a GPT-5+ judge', async () => {
    await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'], judge: true, judgeModel: 'gpt-5.2' });
    const [req] = chatCreate.mock.calls[0] as [Record<string, unknown>];
    expect(req.model).toBe('gpt-5.2');
    expect(req.max_completion_tokens).toBe(800);
    expect(req).not.toHaveProperty('temperature');
    expect(req).not.toHaveProperty('max_tokens');
  });

  it('uses the reasoning shape for o-series judges too', async () => {
    await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'], judge: true, judgeModel: 'o3-mini' });
    const [req] = chatCreate.mock.calls[0] as [Record<string, unknown>];
    expect(req.max_completion_tokens).toBe(800);
    expect(req).not.toHaveProperty('temperature');
  });

  it('treats a judge failure as non-fatal and still completes the run', async () => {
    chatCreate.mockRejectedValue(new Error('judge exploded'));
    const summary = await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'], judge: true });
    expect(summary.succeeded).toBe(1);
    expect(recordJudgementMock).not.toHaveBeenCalled();
    expect(finishRunMock).toHaveBeenCalledWith(7, 'completed', null);
  });

  it('skips a verdict with no scores block and defaults a missing rationale to empty', async () => {
    chatCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ rationale: 'no scores here' }) } }] });
    await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'], judge: true });
    expect(recordJudgementMock).not.toHaveBeenCalled();

    recordJudgementMock.mockClear();
    chatCreate.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ scores: { empathy: 2 } }) } }] });
    await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'], judge: true });
    expect(recordJudgementMock).toHaveBeenCalledWith(7, 'good', { empathy: 2 }, '');
  });

  it('skips an empty judge completion', async () => {
    chatCreate.mockResolvedValue({ choices: [] });
    await runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'], judge: true });
    expect(recordJudgementMock).not.toHaveBeenCalled();
  });

  it('does not let a judgement write failure fail the run', async () => {
    recordJudgementMock.mockRejectedValue(new Error('db down'));
    await expect(runCounterfactual({ sessionId: SESSION, models: ['gpt-5-nano'], judge: true }))
      .resolves.toMatchObject({ succeeded: 1 });
    expect(finishRunMock).toHaveBeenCalledWith(7, 'completed', null);
  });
});

describe('findRiskSpikePoint', () => {
  it('returns null without querying when the session has no conversation', async () => {
    getSessionMessagesMock.mockResolvedValue([]);
    await expect(findRiskSpikePoint(SESSION)).resolves.toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('selects the highest-scored participant message and maps it to its conversation index', async () => {
    queryMock.mockResolvedValue({ rows: [{ content: ' I have been feeling low ' }] });
    await expect(findRiskSpikePoint(SESSION)).resolves.toBe(2);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("m.role = 'user'");
    expect(sql).toContain("m.message_type IN ('voice', 'text', 'message')");
    expect(sql).toContain("(m.metadata->>'risk_score') IS NOT NULL");
    expect(sql).toMatch(/ORDER BY \(m\.metadata->>'risk_score'\)::numeric DESC, m\.created_at ASC\s+LIMIT 1/);
    expect(params).toEqual([SESSION]);
  });

  it('returns null when the session has no scored risk history', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(findRiskSpikePoint(SESSION)).resolves.toBeNull();
  });

  it('returns null when the peak text no longer matches a participant turn', async () => {
    queryMock.mockResolvedValue({ rows: [{ content: 'hi, how are you' }] }); // an assistant line
    await expect(findRiskSpikePoint(SESSION)).resolves.toBeNull();
  });

  it('swallows a query failure as "no spike" rather than throwing', async () => {
    queryMock.mockRejectedValue(new Error('column does not exist'));
    await expect(findRiskSpikePoint(SESSION)).resolves.toBeNull();
  });
});
