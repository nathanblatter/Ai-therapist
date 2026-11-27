// Redaction leak-check (ai-therapist-262): backend selection, the isolated
// Decisions API adapter, the Responses fallback, and the per-row persistence.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { decisionsCreateMock, createMock, queryMock, getSystemConfigByKeyMock, recordLlmUsageMock, getOpenAIKeyMock } =
  vi.hoisted(() => ({
    getOpenAIKeyMock: vi.fn(),
    decisionsCreateMock: vi.fn(),
    createMock: vi.fn(),
    queryMock: vi.fn(),
    getSystemConfigByKeyMock: vi.fn(),
    recordLlmUsageMock: vi.fn(),
  }));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    decisions = { create: decisionsCreateMock };
    responses = { create: createMock };
  },
}));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: getOpenAIKeyMock }));
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
  decisionsCreateMock.mockReset();
  createMock.mockReset();
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
  getSystemConfigByKeyMock.mockReset();
  getSystemConfigByKeyMock.mockResolvedValue(null);
  recordLlmUsageMock.mockReset();
  recordLlmUsageMock.mockResolvedValue(undefined);
  getOpenAIKeyMock.mockReset();
  getOpenAIKeyMock.mockResolvedValue('test-key');
  _resetVerifierStateForTests();
});

/** A Decisions API response in the documented GA shape. */
function decision(probability: number, usage?: { input_tokens: number; output_tokens: number }) {
  return {
    model: 'gpt-6-luna',
    answers: [{ type: 'predicate', name: 'phi_leak', probability }],
    ...(usage ? { usage } : {}),
  };
}

describe('Decisions API adapter', () => {
  // ai-therapist-284: the GA API requires `questions` (array). The preview-era
  // `question` object 400s every request. This pins the exact wire body.
  it('sends the documented request shape: questions[] with one named predicate', () => {
    const body = buildDecisionsBody('I talked to [REDACTED: NAME] yesterday');
    expect(body).toEqual({
      model: 'gpt-6-luna',
      input: 'I talked to [REDACTED: NAME] yesterday',
      questions: [{ type: 'predicate', name: 'phi_leak', instructions: expect.stringMatching(/HIPAA Safe Harbor/) }],
    });
    expect(body).not.toHaveProperty('question');
    // Not a Decisions parameter; an unknown field risks another 400.
    expect(body).not.toHaveProperty('store');
  });

  it('reads the predicate probability from answers[] and carries usage', () => {
    expect(parseDecisionsResponse(decision(0.83, { input_tokens: 40, output_tokens: 0 }))).toEqual({
      pLeak: 0.83,
      tokensIn: 40,
      tokensOut: 0,
    });
  });

  it('picks the answer by question name, not by position', () => {
    const r = parseDecisionsResponse({
      answers: [
        { type: 'predicate', name: 'something_else', probability: 0.01 },
        { type: 'predicate', name: 'phi_leak', probability: 0.7 },
      ],
    });
    expect(r.pLeak).toBeCloseTo(0.7);
  });

  it('clamps an out-of-range probability', () => {
    expect(parseDecisionsResponse(decision(1.2)).pLeak).toBe(1);
    expect(parseDecisionsResponse(decision(-0.1)).pLeak).toBe(0);
  });

  it('throws on a refusal instead of treating it as clean', () => {
    expect(() => parseDecisionsResponse({ answers: [{ type: 'refusal', name: 'phi_leak' }] })).toThrow(/refused/);
  });

  it('throws on an unrecognizable shape instead of inventing a probability', () => {
    expect(() => parseDecisionsResponse({ something: 'else' })).toThrow(/no answers/);
    expect(() => parseDecisionsResponse({ answers: [] })).toThrow(/no answers/);
    expect(() => parseDecisionsResponse(null)).toThrow(/no answers/);
    expect(() =>
      parseDecisionsResponse({ answers: [{ type: 'choice', name: 'phi_leak', choice: 'yes', confidence: 0.9 }] }),
    ).toThrow(/no predicate probability/);
    expect(() =>
      parseDecisionsResponse({ answers: [{ type: 'predicate', name: 'phi_leak', probability: 'high' }] }),
    ).toThrow(/no predicate probability/);
  });

  it('recognizes the preview-gating error', () => {
    expect(isDecisionsUnavailableError(new Error('Decision API is not enabled for this user.'))).toBe(true);
    expect(isDecisionsUnavailableError(Object.assign(new Error('Not Found'), { status: 404 }))).toBe(true);
    expect(isDecisionsUnavailableError(new Error('rate limit exceeded'))).toBe(false);
  });
});

describe('askLeakCheck backend selection', () => {
  it('auto: uses the Decisions API when it answers', async () => {
    decisionsCreateMock.mockResolvedValue(decision(0.05));
    const a = await askLeakCheck('clean text', CFG);
    expect(a.backend).toBe('decisions');
    expect(a.pLeak).toBeCloseTo(0.05);
    expect(decisionsCreateMock).toHaveBeenCalledWith(buildDecisionsBody('clean text'));
    expect(createMock).not.toHaveBeenCalled();
  });

  it('auto: falls back to Responses when the preview is not enabled, and stays there', async () => {
    decisionsCreateMock.mockRejectedValue(new Error('Decision API is not enabled for this user.'));
    createMock.mockResolvedValue({
      output_text: JSON.stringify({ leaks: true, probability: 0.8 }),
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    const first = await askLeakCheck('my sister Marie', CFG);
    expect(first.backend).toBe('responses');
    expect(first.pLeak).toBeCloseTo(0.8);

    await askLeakCheck('second message', CFG);
    expect(decisionsCreateMock).toHaveBeenCalledTimes(1); // not re-probed per message
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('auto: a non-gating Decisions error propagates (no silent fallback that hides an outage)', async () => {
    decisionsCreateMock.mockRejectedValue(new Error('rate limit exceeded'));
    await expect(askLeakCheck('x', CFG)).rejects.toThrow(/rate limit/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('backend=decisions never falls back', async () => {
    decisionsCreateMock.mockRejectedValue(new Error('Decision API is not enabled for this user.'));
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
    expect(decisionsCreateMock).not.toHaveBeenCalled();
  });
});

describe('verifyRedactedMessages', () => {
  // ai-therapist-409: the model answered "clean" for about a third of the
  // organisation names redaction leaves in. A word still capitalised like a
  // name flags the row whatever the model said, and the row records which of
  // the two reasons applied.
  it('flags a row the model calls clean when a capitalised name is still in it', async () => {
    decisionsCreateMock.mockResolvedValueOnce(decision(0.1)).mockResolvedValueOnce(decision(0.1));

    const summary = await verifyRedactedMessages('sess_1', [
      { id: 21, text: 'I transferred to Utah Valley University this semester.' },
      { id: 22, text: 'I transferred to [REDACTED: LOCATION] this semester.' },
    ]);

    expect(summary).toEqual({ checked: 2, flagged: 1, errored: 0 });
    const updates = queryMock.mock.calls.filter(([sql]) => /redaction_check/.test(sql as string));
    const byId = Object.fromEntries(updates.map(([, params]) => [params![1], JSON.parse(params![0] as string)]));
    expect(byId[21]).toMatchObject({ p_leak: 0.1, flagged: true, model_flagged: false, capitalised_words: 2 });
    expect(byId[22]).toMatchObject({ p_leak: 0.1, flagged: false, model_flagged: false, capitalised_words: 0 });
  });

  it('persists a redaction_check verdict per row and records usage', async () => {
    decisionsCreateMock
      .mockResolvedValueOnce(decision(0.9, { input_tokens: 30, output_tokens: 1 }))
      .mockResolvedValueOnce(decision(0.01));

    const summary = await verifyRedactedMessages('sess_1', [
      { id: 11, text: 'I saw Marie at the clinic' },
      { id: 12, text: 'I saw [REDACTED: NAME] at the clinic' },
    ]);

    expect(summary).toEqual({ checked: 2, flagged: 1, errored: 0 });
    const updates = queryMock.mock.calls.filter(([sql]) => /redaction_check/.test(sql as string));
    expect(updates).toHaveLength(2);
    const byId = Object.fromEntries(updates.map(([, params]) => [params![1], JSON.parse(params![0] as string)]));
    expect(byId[11]).toMatchObject({
      status: 'checked',
      p_leak: 0.9,
      flagged: true,
      model_flagged: true,
      backend: 'decisions',
      model: 'gpt-6-luna',
    });
    expect(byId[12]).toMatchObject({ status: 'checked', p_leak: 0.01, flagged: false });
    expect(byId[12]).not.toHaveProperty('error');
    await Promise.resolve();
    expect(recordLlmUsageMock).toHaveBeenCalledWith('sess_1', 'redaction', 'gpt-6-luna', 30, 1);
  });

  it('honours the configured threshold and disabled flag', async () => {
    getSystemConfigByKeyMock.mockResolvedValue({
      config_value: { enabled: true, backend: 'decisions', threshold: 0.95 },
    });
    decisionsCreateMock.mockResolvedValue(decision(0.9));
    expect(await verifyRedactedMessages('s', [{ id: 1, text: 'x' }])).toEqual({ checked: 1, flagged: 0, errored: 0 });

    getSystemConfigByKeyMock.mockResolvedValue({ config_value: { enabled: false } });
    decisionsCreateMock.mockClear();
    expect(await verifyRedactedMessages('s', [{ id: 1, text: 'x' }])).toEqual({ checked: 0, flagged: 0, errored: 0 });
    expect(decisionsCreateMock).not.toHaveBeenCalled();
  });

  // ai-therapist-288: "could not check" must never read as "checked and clean".
  it('records a failed call as its own errored state (flagged null, never false) and never throws', async () => {
    decisionsCreateMock.mockRejectedValue(new Error('boom'));
    const summary = await verifyRedactedMessages('s', [{ id: 7, text: 'x' }]);
    expect(summary).toEqual({ checked: 0, flagged: 0, errored: 1 });
    const [, params] = queryMock.mock.calls.find(([sql]) => /redaction_check/.test(sql as string))!;
    const check = JSON.parse(params![0] as string);
    expect(check).toMatchObject({ status: 'errored', flagged: null, p_leak: -1, error: 'boom' });
    expect(check.flagged).not.toBe(false);
  });

  it('when no OpenAI client can be built, every due row is recorded as errored, not left looking unchecked', async () => {
    getOpenAIKeyMock.mockRejectedValue(new Error('no key'));
    const summary = await verifyRedactedMessages('s', [
      { id: 1, text: 'a' },
      { id: 2, text: '  ' },
      { id: 3, text: 'b' },
    ]);
    expect(summary).toEqual({ checked: 0, flagged: 0, errored: 2 });
    const writes = queryMock.mock.calls.filter(([sql]) => /redaction_check/.test(sql as string));
    expect(writes.map(([, p]) => p![1])).toEqual([1, 3]);
    for (const [, p] of writes) {
      expect(JSON.parse(p![0] as string)).toMatchObject({ status: 'errored', flagged: null, error: 'no key' });
    }
    expect(decisionsCreateMock).not.toHaveBeenCalled();
  });

  it('a failure to record the errored state is logged, not thrown, and not counted', async () => {
    decisionsCreateMock.mockRejectedValue(new Error('boom'));
    queryMock.mockRejectedValue(new Error('db down'));
    await expect(verifyRedactedMessages('s', [{ id: 7, text: 'x' }])).resolves.toEqual({
      checked: 0,
      flagged: 0,
      errored: 0,
    });
  });

  // The 2026-11-01 incident: the API 400'd every request. Pin what that does
  // so the fail policy is a tested fact: the row is recorded as errored (not
  // as unflagged, ai-therapist-288), nothing is counted as checked, and no
  // fallback is attempted.
  it('a 400 from the Decisions API leaves the row errored and unverified (fail-soft)', async () => {
    decisionsCreateMock.mockRejectedValue(
      Object.assign(new Error('400 Missing required parameter: questions.'), { status: 400 }),
    );
    const summary = await verifyRedactedMessages('s', [{ id: 9, text: 'I saw Marie' }]);
    expect(summary).toEqual({ checked: 0, flagged: 0, errored: 1 });
    expect(createMock).not.toHaveBeenCalled();
    const [, params] = queryMock.mock.calls.find(([sql]) => /redaction_check/.test(sql as string))!;
    expect(JSON.parse(params![0] as string)).toMatchObject({
      status: 'errored',
      p_leak: -1,
      flagged: null,
      model: 'n/a',
      error: expect.stringContaining('Missing required parameter: questions'),
    });
  });

  it('skips empty redacted text without a model call', async () => {
    expect(await verifyRedactedMessages('s', [{ id: 1, text: '   ' }])).toEqual({ checked: 0, flagged: 0, errored: 0 });
    expect(decisionsCreateMock).not.toHaveBeenCalled();
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
