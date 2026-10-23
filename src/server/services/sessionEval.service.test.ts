import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  createMock,
  getSessionMock,
  getSessionMessagesMock,
  getSessionConfigMock,
  getSessionEvalMock,
  hasSessionEvalMock,
  upsertSessionEvalMock,
  replaceSessionEvalJudgesMock,
  getUnevaluatedMock,
  getSystemConfigMock,
  getSessionIsDemoMock,
  isSandboxAccountSessionMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  getSessionMock: vi.fn(),
  getSessionMessagesMock: vi.fn(),
  getSessionConfigMock: vi.fn(),
  getSessionEvalMock: vi.fn(),
  hasSessionEvalMock: vi.fn(),
  upsertSessionEvalMock: vi.fn(),
  replaceSessionEvalJudgesMock: vi.fn(),
  getUnevaluatedMock: vi.fn(),
  getSystemConfigMock: vi.fn(),
  getSessionIsDemoMock: vi.fn(),
  isSandboxAccountSessionMock: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));
vi.mock('../config/secrets.js', () => ({
  getOpenAIKey: vi.fn().mockResolvedValue('sk-test'),
}));
vi.mock('../db/index.js', () => ({
  getSession: getSessionMock,
  getSessionMessages: getSessionMessagesMock,
  getSessionConfig: getSessionConfigMock,
  getSessionEval: getSessionEvalMock,
  getSessionIsDemo: getSessionIsDemoMock,
  hasSessionEval: hasSessionEvalMock,
  isSandboxAccountSession: isSandboxAccountSessionMock,
  upsertSessionEval: upsertSessionEvalMock,
  replaceSessionEvalJudges: replaceSessionEvalJudgesMock,
  getUnevaluatedEndedSessions: getUnevaluatedMock,
}));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: getSystemConfigMock,
  DEFAULT_MODALITY_PRESETS: {
    cbt: { label: 'CBT-informed', addition: '\nUse CBT techniques.' },
  },
}));

import {
  evaluateSession,
  evaluateSessionDetailed,
  validateRubric,
  maybeAutoEvalSession,
  resolveJudgeEnsemble,
  ensembleLabel,
  medianScore,
  consensusRubric,
  judgeSpread,
  judgeRequestParams,
  EVAL_PROMPT_VERSION,
  EVAL_DIMENSIONS,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_SECOND_JUDGE_MODEL,
  SELF_CONSISTENCY_SEED,
  type JudgeRun,
} from './sessionEval.service.js';

const GOOD_RUBRIC = Object.fromEntries(
  EVAL_DIMENSIONS.map(d => [d, { score: 4, rationale: `${d} ok` }])
);

function judgeReply(payload: unknown) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

// Single-judge config for the legacy v1 tests; the ensemble has its own block.
const SINGLE_JUDGE = { evals: { judge_models: [DEFAULT_JUDGE_MODEL] } };

beforeEach(() => {
  vi.clearAllMocks();
  getSystemConfigMock.mockResolvedValue(SINGLE_JUDGE);
  replaceSessionEvalJudgesMock.mockResolvedValue(undefined);
  getSessionMock.mockResolvedValue({ session_id: 's1', status: 'ended', user_id: 7 });
  hasSessionEvalMock.mockResolvedValue(false);
  getSessionIsDemoMock.mockResolvedValue(false);
  isSandboxAccountSessionMock.mockResolvedValue(false);
  getSessionConfigMock.mockResolvedValue({ modality: 'cbt' });
  getSessionMessagesMock.mockResolvedValue([
    { role: 'user', content: 'I feel anxious', content_redacted: null },
    { role: 'assistant', content: 'That sounds really hard. Tell me more?', content_redacted: null },
    { role: 'system', content: 'Tool called: log_mood', content_redacted: null },
  ]);
  upsertSessionEvalMock.mockImplementation(async (sessionId, rubric, comments, model, version) => ({
    eval_id: 1, session_id: sessionId, rubric, overall_comments: comments,
    judge_model: model, prompt_version: version, created_at: new Date(),
  }));
});

describe('evaluateSession', () => {
  it('scores an ended session and stores the rubric', async () => {
    createMock.mockResolvedValueOnce(judgeReply({ ...GOOD_RUBRIC, overall_comments: 'Solid session.' }));

    const row = await evaluateSession('s1');

    expect(row).not.toBeNull();
    expect(upsertSessionEvalMock).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ empathy: { score: 4, rationale: 'empathy ok' } }),
      'Solid session.',
      DEFAULT_JUDGE_MODEL,
      EVAL_PROMPT_VERSION,
      null, // single judge: no spread
    );
    // The raw run is persisted alongside the consensus row.
    expect(replaceSessionEvalJudgesMock).toHaveBeenCalledWith('s1', EVAL_PROMPT_VERSION, [
      expect.objectContaining({ judgeModel: DEFAULT_JUDGE_MODEL, runIndex: 0, seed: null }),
    ]);

    // The judge sees only user/assistant turns (system/tool rows excluded) and
    // the session's modality context.
    const request = createMock.mock.calls[0][0];
    const userMsg = request.messages.find((m: { role: string }) => m.role === 'user').content as string;
    expect(userMsg).toContain('Participant: I feel anxious');
    expect(userMsg).toContain('Assistant: That sounds really hard.');
    expect(userMsg).not.toContain('Tool called');
    expect(userMsg).toContain('CBT-informed');
    expect(request.temperature).toBe(0);
    expect(request.seed).toBeUndefined(); // single run keeps the exact v1 request shape
  });

  it('skips sessions that are not ended', async () => {
    getSessionMock.mockResolvedValue({ session_id: 's1', status: 'active' });
    expect(await evaluateSession('s1')).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('is idempotent: returns the existing eval without re-judging', async () => {
    hasSessionEvalMock.mockResolvedValue(true);
    getSessionEvalMock.mockResolvedValue({ eval_id: 42, session_id: 's1' });

    const row = await evaluateSession('s1');

    expect(row).toEqual({ eval_id: 42, session_id: 's1' });
    expect(createMock).not.toHaveBeenCalled();
    expect(upsertSessionEvalMock).not.toHaveBeenCalled();
  });

  it('re-evaluates when force is set', async () => {
    hasSessionEvalMock.mockResolvedValue(true);
    createMock.mockResolvedValueOnce(judgeReply({ ...GOOD_RUBRIC, overall_comments: null }));

    const row = await evaluateSession('s1', { force: true });

    expect(row?.prompt_version).toBe(EVAL_PROMPT_VERSION);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('skips sessions with no conversation content', async () => {
    getSessionMessagesMock.mockResolvedValue([
      { role: 'system', content: 'Session started', content_redacted: null },
    ]);
    expect(await evaluateSession('s1')).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('uses the configured judge model from system_config.evals', async () => {
    getSystemConfigMock.mockResolvedValue({ evals: { judge_models: ['gpt-5-mini'] } });
    createMock.mockResolvedValueOnce(judgeReply({ ...GOOD_RUBRIC, overall_comments: '' }));

    await evaluateSession('s1');

    expect(createMock.mock.calls[0][0].model).toBe('gpt-5-mini');
  });

  it('honours the legacy single-judge override even when an ensemble is configured', async () => {
    getSystemConfigMock.mockResolvedValue({ evals: { judge_models: ['gpt-4o-mini', 'gpt-5-mini'] } });
    createMock.mockResolvedValueOnce(judgeReply({ ...GOOD_RUBRIC, overall_comments: '' }));

    await evaluateSession('s1', { judgeModel: 'gpt-4.1-mini' });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].model).toBe('gpt-4.1-mini');
  });

  it('throws when the judge omits a rubric dimension', async () => {
    const incomplete: Record<string, unknown> = { ...GOOD_RUBRIC };
    delete incomplete.clinical_claims;
    createMock.mockResolvedValueOnce(judgeReply(incomplete));

    await expect(evaluateSession('s1')).rejects.toThrow(/clinical_claims/);
    expect(upsertSessionEvalMock).not.toHaveBeenCalled();
  });
});

describe('validateRubric', () => {
  it('rejects out-of-range scores', () => {
    const bad = { ...GOOD_RUBRIC, empathy: { score: 9, rationale: 'x' } };
    expect(() => validateRubric(bad)).toThrow(/empathy/);
  });

  it('rounds fractional scores and defaults missing rationales', () => {
    const rubric = validateRubric({
      ...GOOD_RUBRIC,
      empathy: { score: 4.6 },
    } as Record<string, unknown>);
    expect(rubric.empathy).toEqual({ score: 5, rationale: '' });
  });
});

describe('maybeAutoEvalSession', () => {
  // The stage-only env gate sits in front of the config checks; enable it here
  // so the tests below exercise the config logic.
  beforeEach(() => { process.env.EVALS_ENABLED = 'true'; });
  afterEach(() => { delete process.env.EVALS_ENABLED; });

  it('does nothing when EVALS_ENABLED is not set (prod posture), even with auto-run on', async () => {
    delete process.env.EVALS_ENABLED;
    getSystemConfigMock.mockResolvedValue({ evals: { auto_run_enabled: true } });
    maybeAutoEvalSession('s1');
    await new Promise(r => setTimeout(r, 0));
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('does nothing when auto-run is not enabled (default)', async () => {
    getSystemConfigMock.mockResolvedValue({ evals: {} });
    maybeAutoEvalSession('s1');
    await new Promise(r => setTimeout(r, 0));
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('runs the eval when system_config.evals.auto_run_enabled is true', async () => {
    getSystemConfigMock.mockResolvedValue({ evals: { auto_run_enabled: true } });
    createMock.mockResolvedValueOnce(judgeReply({ ...GOOD_RUBRIC, overall_comments: 'ok' }));

    maybeAutoEvalSession('s1');
    await vi.waitFor(() => expect(upsertSessionEvalMock).toHaveBeenCalled());
  });

  it('skips the auto-enqueue for is_demo sessions (demo/harness/sandbox)', async () => {
    getSystemConfigMock.mockResolvedValue({ evals: { auto_run_enabled: true } });
    getSessionIsDemoMock.mockResolvedValue(true);

    maybeAutoEvalSession('s1');
    await new Promise(r => setTimeout(r, 0));
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('sandbox exclusion (caseworker portal spec section 7)', () => {
  it('evaluateSession skips sandbox-account sessions even under force', async () => {
    isSandboxAccountSessionMock.mockResolvedValue(true);
    const row = await evaluateSession('sbx-1-0-0', { force: true });
    expect(row).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    expect(upsertSessionEvalMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Judge ensemble + self-consistency (eval spec G6, migration 107)
// ---------------------------------------------------------------------------

function rubricWith(overrides: Record<string, number>, base = 4) {
  return Object.fromEntries(
    EVAL_DIMENSIONS.map(d => [d, { score: overrides[d] ?? base, rationale: `${d} r` }])
  );
}

describe('judge ensemble', () => {
  it('defaults to gpt-4o-mini + gpt-5-mini, one run each, with the median as consensus', async () => {
    getSystemConfigMock.mockResolvedValue({});
    // Each judge gets the identical v1 prompt; replies are matched by model id.
    createMock.mockImplementation(async (req: { model: string }) =>
      req.model === DEFAULT_JUDGE_MODEL
        ? judgeReply({ ...rubricWith({ empathy: 5, safety_protocol: 2 }), overall_comments: 'primary' })
        : judgeReply({ ...rubricWith({ empathy: 3, safety_protocol: 2 }), overall_comments: 'second' }));

    const detailed = await evaluateSessionDetailed('s1');

    expect(detailed).not.toBeNull();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls.map(c => c[0].model)).toEqual([DEFAULT_JUDGE_MODEL, DEFAULT_SECOND_JUDGE_MODEL]);
    // Same system prompt to both judges (rubric/version untouched).
    expect(createMock.mock.calls[0][0].messages[0].content).toBe(createMock.mock.calls[1][0].messages[0].content);
    expect(detailed!.settings).toEqual({ models: [DEFAULT_JUDGE_MODEL, DEFAULT_SECOND_JUDGE_MODEL], runs: 1 });

    const [, rubric, comments, label, version, spread] = upsertSessionEvalMock.mock.calls[0];
    expect(label).toBe(`ensemble(${DEFAULT_JUDGE_MODEL},${DEFAULT_SECOND_JUDGE_MODEL})`);
    expect(version).toBe(EVAL_PROMPT_VERSION);
    expect(comments).toBe('primary'); // primary judge's comments carry the row
    expect(rubric.empathy.score).toBe(4); // median of 5 and 3
    expect(rubric.empathy.rationale).toContain('[judge scores: gpt-4o-mini 5, gpt-5-mini 3]');
    expect(rubric.safety_protocol.score).toBe(2);
    expect(rubric.safety_protocol.rationale).not.toContain('[judge scores'); // agreed: no annotation
    expect(spread).toMatchObject({ empathy: 2, safety_protocol: 0 });
    expect(replaceSessionEvalJudgesMock).toHaveBeenCalledWith('s1', EVAL_PROMPT_VERSION, [
      expect.objectContaining({ judgeModel: DEFAULT_JUDGE_MODEL, runIndex: 0 }),
      expect.objectContaining({ judgeModel: DEFAULT_SECOND_JUDGE_MODEL, runIndex: 0 }),
    ]);
  });

  it('sends reasoning-generation params to gpt-5-mini and temp-0 params to gpt-4o-mini', async () => {
    getSystemConfigMock.mockResolvedValue({});
    createMock.mockResolvedValue(judgeReply({ ...GOOD_RUBRIC, overall_comments: '' }));

    await evaluateSession('s1');

    const legacy = createMock.mock.calls.find(c => c[0].model === DEFAULT_JUDGE_MODEL)![0];
    const reasoning = createMock.mock.calls.find(c => c[0].model === DEFAULT_SECOND_JUDGE_MODEL)![0];
    expect(legacy).toMatchObject({ temperature: 0, max_tokens: 1200 });
    expect(legacy.max_completion_tokens).toBeUndefined();
    expect(reasoning).toMatchObject({ max_completion_tokens: 4000, reasoning_effort: 'low' });
    expect(reasoning.temperature).toBeUndefined();
    expect(reasoning.max_tokens).toBeUndefined();
    expect(reasoning.response_format).toEqual({ type: 'json_object' });
  });

  it('runs each judge k times with distinct seeds when self_consistency_runs > 1', async () => {
    getSystemConfigMock.mockResolvedValue({ evals: { judge_models: ['gpt-4o-mini'], self_consistency_runs: 3 } });
    const replies = [rubricWith({ empathy: 3 }), rubricWith({ empathy: 5 }), rubricWith({ empathy: 4 })];
    let i = 0;
    createMock.mockImplementation(async () => judgeReply({ ...replies[i++], overall_comments: '' }));

    const detailed = await evaluateSessionDetailed('s1');

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(createMock.mock.calls.map(c => c[0].seed)).toEqual([SELF_CONSISTENCY_SEED, SELF_CONSISTENCY_SEED + 1, SELF_CONSISTENCY_SEED + 2]);
    expect(detailed!.row.rubric.empathy.score).toBe(4); // median of 3, 5, 4
    expect(detailed!.row.judge_model).toBe('gpt-4o-minix3');
    expect(detailed!.runs.map(r => r.runIndex)).toEqual([0, 1, 2]);
  });

  it('keeps going when one judge fails and reports the failure', async () => {
    getSystemConfigMock.mockResolvedValue({});
    createMock.mockImplementation(async (req: { model: string }) => {
      if (req.model === DEFAULT_SECOND_JUDGE_MODEL) throw new Error('503 upstream');
      return judgeReply({ ...rubricWith({ empathy: 5 }), overall_comments: 'ok' });
    });

    const detailed = await evaluateSessionDetailed('s1');

    expect(detailed!.runs).toHaveLength(1);
    expect(detailed!.failed).toEqual([{ judgeModel: DEFAULT_SECOND_JUDGE_MODEL, runIndex: 0, error: '503 upstream' }]);
    expect(detailed!.row.rubric.empathy.score).toBe(5);
    expect(detailed!.spread).toBeNull(); // only one surviving run
    // The label still records the intended ensemble so the row is not mistaken for a single-judge score.
    expect(detailed!.row.judge_model).toBe(`ensemble(${DEFAULT_JUDGE_MODEL},${DEFAULT_SECOND_JUDGE_MODEL})`);
  });

  it('throws when every judge fails (nothing stored)', async () => {
    getSystemConfigMock.mockResolvedValue({});
    createMock.mockRejectedValue(new Error('boom'));
    await expect(evaluateSession('s1')).rejects.toThrow(/All judge runs failed/);
    expect(upsertSessionEvalMock).not.toHaveBeenCalled();
    expect(replaceSessionEvalJudgesMock).not.toHaveBeenCalled();
  });
});

describe('ensemble helpers (pure)', () => {
  it('resolveJudgeEnsemble precedence: options.judgeModels > judgeModel > config list > defaults', () => {
    expect(resolveJudgeEnsemble({}, {})).toEqual({ models: ['gpt-4o-mini', 'gpt-5-mini'], runs: 1 });
    expect(resolveJudgeEnsemble({}, { judge_model: 'gpt-4.1-mini' })).toEqual({ models: ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-mini'], runs: 1 });
    expect(resolveJudgeEnsemble({}, { judge_models: ['a', 'b', 'a', ''] })).toEqual({ models: ['a', 'b'], runs: 1 });
    expect(resolveJudgeEnsemble({ judgeModel: 'x' }, { judge_models: ['a', 'b'] })).toEqual({ models: ['x'], runs: 1 });
    expect(resolveJudgeEnsemble({ judgeModels: ['y'], judgeModel: 'x' }, {})).toEqual({ models: ['y'], runs: 1 });
    // runs clamp to 1..5; garbage falls back to 1
    expect(resolveJudgeEnsemble({}, { self_consistency_runs: 9 }).runs).toBe(5);
    expect(resolveJudgeEnsemble({ selfConsistencyRuns: 0 }, { self_consistency_runs: 3 }).runs).toBe(1);
    expect(resolveJudgeEnsemble({}, { self_consistency_runs: 2.5 }).runs).toBe(1);
  });

  it('ensembleLabel keeps the bare model id for single judge + single run', () => {
    expect(ensembleLabel({ models: ['gpt-4o-mini'], runs: 1 })).toBe('gpt-4o-mini');
    expect(ensembleLabel({ models: ['gpt-4o-mini'], runs: 2 })).toBe('gpt-4o-minix2');
    expect(ensembleLabel({ models: ['a', 'b'], runs: 1 })).toBe('ensemble(a,b)');
    expect(ensembleLabel({ models: ['a', 'b'], runs: 3 })).toBe('ensemble(a,b)x3');
  });

  it('medianScore: odd count exact, even-count .5 tie rounds up, stays an integer', () => {
    expect(medianScore([3])).toBe(3);
    expect(medianScore([5, 1, 3])).toBe(3);
    expect(medianScore([3, 4])).toBe(4); // 3.5 -> 4
    expect(medianScore([2, 2, 5, 5])).toBe(4); // 3.5 -> 4
    expect(medianScore([1, 5, 5, 5])).toBe(5);
    expect(medianScore([4, 4])).toBe(4);
  });

  it('consensusRubric + judgeSpread over three runs', () => {
    const runs: JudgeRun[] = [
      { judgeModel: 'a', runIndex: 0, seed: null, rubric: rubricWith({ empathy: 2 }), overallComments: 'first' },
      { judgeModel: 'b', runIndex: 0, seed: null, rubric: rubricWith({ empathy: 4 }), overallComments: 'second' },
      { judgeModel: 'b', runIndex: 1, seed: 1001, rubric: rubricWith({ empathy: 5 }), overallComments: 'third' },
    ];
    const rubric = consensusRubric(runs);
    expect(rubric.empathy.score).toBe(4);
    expect(rubric.empathy.rationale).toBe('empathy r [judge scores: a 2, b 4, b#2 5]');
    expect(rubric.clinical_claims).toEqual({ score: 4, rationale: 'clinical_claims r' });
    expect(judgeSpread(runs)).toMatchObject({ empathy: 3, clinical_claims: 0 });
    expect(judgeSpread(runs.slice(0, 1))).toBeNull();
    expect(() => consensusRubric([])).toThrow();
  });

  it('judgeRequestParams picks the generation-appropriate shape', () => {
    expect(judgeRequestParams('gpt-4o-mini')).toEqual({ temperature: 0, max_tokens: 1200 });
    expect(judgeRequestParams('gpt-4.1-mini')).toEqual({ temperature: 0, max_tokens: 1200 });
    expect(judgeRequestParams('gpt-5-mini')).toEqual({ max_completion_tokens: 4000, reasoning_effort: 'low' });
    expect(judgeRequestParams('o4-mini')).toEqual({ max_completion_tokens: 4000, reasoning_effort: 'low' });
  });
});
