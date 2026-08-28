import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  createMock,
  getSessionMock,
  getSessionMessagesMock,
  getSessionConfigMock,
  getSessionEvalMock,
  hasSessionEvalMock,
  upsertSessionEvalMock,
  getUnevaluatedMock,
  getSystemConfigMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  getSessionMock: vi.fn(),
  getSessionMessagesMock: vi.fn(),
  getSessionConfigMock: vi.fn(),
  getSessionEvalMock: vi.fn(),
  hasSessionEvalMock: vi.fn(),
  upsertSessionEvalMock: vi.fn(),
  getUnevaluatedMock: vi.fn(),
  getSystemConfigMock: vi.fn(),
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
  hasSessionEval: hasSessionEvalMock,
  upsertSessionEval: upsertSessionEvalMock,
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
  validateRubric,
  maybeAutoEvalSession,
  EVAL_PROMPT_VERSION,
  EVAL_DIMENSIONS,
  DEFAULT_JUDGE_MODEL,
} from './sessionEval.service.js';

const GOOD_RUBRIC = Object.fromEntries(
  EVAL_DIMENSIONS.map(d => [d, { score: 4, rationale: `${d} ok` }])
);

function judgeReply(payload: unknown) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSystemConfigMock.mockResolvedValue({});
  getSessionMock.mockResolvedValue({ session_id: 's1', status: 'ended', user_id: 7 });
  hasSessionEvalMock.mockResolvedValue(false);
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
    );

    // The judge sees only user/assistant turns (system/tool rows excluded) and
    // the session's modality context.
    const request = createMock.mock.calls[0][0];
    const userMsg = request.messages.find((m: { role: string }) => m.role === 'user').content as string;
    expect(userMsg).toContain('Participant: I feel anxious');
    expect(userMsg).toContain('Assistant: That sounds really hard.');
    expect(userMsg).not.toContain('Tool called');
    expect(userMsg).toContain('CBT-informed');
    expect(request.temperature).toBe(0);
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
    getSystemConfigMock.mockResolvedValue({ evals: { judge_model: 'gpt-5-mini' } });
    createMock.mockResolvedValueOnce(judgeReply({ ...GOOD_RUBRIC, overall_comments: '' }));

    await evaluateSession('s1');

    expect(createMock.mock.calls[0][0].model).toBe('gpt-5-mini');
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
});
