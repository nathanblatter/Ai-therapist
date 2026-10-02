// Redaction leak-check (ai-therapist-262): backend selection, the isolated
// Decisions API adapter, the Responses fallback, and the per-row persistence.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { postMock, createMock, queryMock, getSystemConfigByKeyMock, recordLlmUsageMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  createMock: vi.fn(),
  queryMock: vi.fn(),
  getSystemConfigByKeyMock: vi.fn(),
  recordLlmUsageMock: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    post = postMock;
    responses = { create: createMock };
  },
}));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: async () => 'test-key' }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn(), on: vi.fn() } }));
vi.mock('../db/index.js', () => ({
  getSystemConfigByKey: getSystemConfigByKeyMock,
  recordLlmUsage: recordLlmUsageMock,
}));

import {
  askLeakCheck,
  buildDecisionsBody,
  parseDecisionsResponse,
  isDecisionsUnavailableError,
  verifyRedactedMessages,
  getVerifierConfig,
  DEFAULT_VERIFIER_CONFIG,
  _resetVerifierStateForTests,
} from './redactionVerifier.service.js';

const CFG = { ...DEFAULT_VERIFIER_CONFIG };

beforeEach(() => {
  postMock.mockReset();
  createMock.mockReset();
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
  getSystemConfigByKeyMock.mockReset();
  getSystemConfigByKeyMock.mockResolvedValue(null);
  recordLlmUsageMock.mockReset();
  recordLlmUsageMock.mockResolvedValue(undefined);
  _resetVerifierStateForTests();
});

describe('Decisions API adapter', () => {
  it('sends one bounded yes/no question with store:false and never the raw transcript', () => {
    const body = buildDecisionsBody('I talked to [REDACTED: NAME] yesterday');
    expect(body.model).toBe('gpt-6-luna');
    expect(body.input).toBe('I talked to [REDACTED: NAME] yesterday');
    expect(body.store).toBe(false);
    expect((body.question as { answers: string[] }).answers).toEqual(['yes', 'no']);
  });

  it('reads p(yes) from a per-answer probability map', () => {
    expect(parseDecisionsResponse({ probabilities: { yes: 0.83, no: 0.17 } }).pLeak).toBeCloseTo(0.83);
  });

  it('derives p(leak) from a choice + confidence pair in either direction', () => {
    expect(parseDecisionsResponse({ choice: 'yes', confidence: 0.9 }).pLeak).toBeCloseTo(0.9);
    expect(parseDecisionsResponse({ choice: 'no', confidence: 0.9 }).pLeak).toBeCloseTo(0.1);
  });

  it('unwraps a nested decisions[] / output[] envelope and carries usage', () => {
    const r = parseDecisionsResponse({
      output: [{ answer: 'yes', probability: 0.7 }],
      usage: { input_tokens: 40, output_tokens: 1 },
    });
    expect(r).toEqual({ pLeak: 0.7, tokensIn: 40, tokensOut: 1 });
  });

  it('throws on an unrecognizable shape instead of inventing a probability', () => {
    expect(() => parseDecisionsResponse({ something: 'else' })).toThrow(/no recognizable/);
  });

  it('recognizes the preview-gating error', () => {
    expect(isDecisionsUnavailableError(new Error('Decision API is not enabled for this user.'))).toBe(true);
    expect(isDecisionsUnavailableError(Object.assign(new Error('Not Found'), { status: 404 }))).toBe(true);
    expect(isDecisionsUnavailableError(new Error('rate limit exceeded'))).toBe(false);
  });
});

describe('askLeakCheck backend selection', () => {
  it('auto: uses the Decisions API when it answers', async () => {
    postMock.mockResolvedValue({ choice: 'no', confidence: 0.95 });
    const a = await askLeakCheck('clean text', CFG);
    expect(a.backend).toBe('decisions');
    expect(a.pLeak).toBeCloseTo(0.05);
    expect(postMock).toHaveBeenCalledWith('/decisions', expect.objectContaining({ body: expect.any(Object) }));
    expect(createMock).not.toHaveBeenCalled();
  });

  it('auto: falls back to Responses when the preview is not enabled, and stays there', async () => {
    postMock.mockRejectedValue(new Error('Decision API is not enabled for this user.'));
    createMock.mockResolvedValue({ output_text: JSON.stringify({ leaks: true, probability: 0.8 }), usage: { input_tokens: 50, output_tokens: 10 } });

    const first = await askLeakCheck('my sister Marie', CFG);
    expect(first.backend).toBe('responses');
    expect(first.pLeak).toBeCloseTo(0.8);

    await askLeakCheck('second message', CFG);
    expect(postMock).toHaveBeenCalledTimes(1); // not re-probed per message
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('auto: a non-gating Decisions error propagates (no silent fallback that hides an outage)', async () => {
    postMock.mockRejectedValue(new Error('rate limit exceeded'));
    await expect(askLeakCheck('x', CFG)).rejects.toThrow(/rate limit/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('backend=decisions never falls back', async () => {
    postMock.mockRejectedValue(new Error('Decision API is not enabled for this user.'));
    await expect(askLeakCheck('x', { ...CFG, backend: 'decisions' })).rejects.toThrow(/not enabled/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('responses fallback: strict schema, store:false, boolean and probability reconciled to the cautious side', async () => {
    createMock.mockResolvedValue({ output_text: JSON.stringify({ leaks: true, probability: 0.2 }) });
    const a = await askLeakCheck('text', { ...CFG, backend: 'responses' });
    const req = createMock.mock.calls[0][0];
    expect(req.store).toBe(false);
    expect(req.text.format.strict).toBe(true);
    expect(req.input).not.toMatch(/ignore previous/i);
    expect(a.pLeak).toBe(0.5); // leaks=true but p=0.2 -> at least 0.5
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe('verifyRedactedMessages', () => {
  it('persists a redaction_check verdict per row and records usage', async () => {
    postMock
      .mockResolvedValueOnce({ choice: 'yes', confidence: 0.9, usage: { input_tokens: 30, output_tokens: 1 } })
      .mockResolvedValueOnce({ choice: 'no', confidence: 0.99 });

    const summary = await verifyRedactedMessages('sess_1', [
      { id: 11, text: 'I saw Marie at the clinic' },
      { id: 12, text: 'I saw [REDACTED: NAME] at the clinic' },
    ]);

    expect(summary).toEqual({ checked: 2, flagged: 1 });
    const updates = queryMock.mock.calls.filter(([sql]) => /redaction_check/.test(sql as string));
    expect(updates).toHaveLength(2);
    const byId = Object.fromEntries(updates.map(([, params]) => [params![1], JSON.parse(params![0] as string)]));
    expect(byId[11]).toMatchObject({ p_leak: 0.9, flagged: true, backend: 'decisions', model: 'gpt-6-luna' });
    expect(byId[12]).toMatchObject({ p_leak: 0.01, flagged: false });
    await Promise.resolve();
    expect(recordLlmUsageMock).toHaveBeenCalledWith('sess_1', 'redaction', 'gpt-6-luna', 30, 1);
  });

  it('honours the configured threshold and disabled flag', async () => {
    getSystemConfigByKeyMock.mockResolvedValue({ config_value: { enabled: true, backend: 'decisions', threshold: 0.95 } });
    postMock.mockResolvedValue({ choice: 'yes', confidence: 0.9 });
    expect(await verifyRedactedMessages('s', [{ id: 1, text: 'x' }])).toEqual({ checked: 1, flagged: 0 });

    getSystemConfigByKeyMock.mockResolvedValue({ config_value: { enabled: false } });
    postMock.mockClear();
    expect(await verifyRedactedMessages('s', [{ id: 1, text: 'x' }])).toEqual({ checked: 0, flagged: 0 });
    expect(postMock).not.toHaveBeenCalled();
  });

  it('records a per-row error and never throws when the model call fails', async () => {
    postMock.mockRejectedValue(new Error('boom'));
    const summary = await verifyRedactedMessages('s', [{ id: 7, text: 'x' }], );
    expect(summary).toEqual({ checked: 0, flagged: 0 });
    const [, params] = queryMock.mock.calls.find(([sql]) => /redaction_check/.test(sql as string))!;
    expect(JSON.parse(params![0] as string)).toMatchObject({ flagged: false, error: 'boom' });
  });

  it('skips empty redacted text without a model call', async () => {
    expect(await verifyRedactedMessages('s', [{ id: 1, text: '   ' }])).toEqual({ checked: 0, flagged: 0 });
    expect(postMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('getVerifierConfig', () => {
  it('defaults when the row is missing or malformed', async () => {
    expect(await getVerifierConfig()).toEqual(DEFAULT_VERIFIER_CONFIG);
    getSystemConfigByKeyMock.mockResolvedValue({ config_value: { backend: 'bogus', threshold: 7 } });
    expect(await getVerifierConfig()).toEqual(DEFAULT_VERIFIER_CONFIG);
  });
});
