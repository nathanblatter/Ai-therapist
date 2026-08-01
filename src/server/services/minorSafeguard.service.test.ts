import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock secrets + OpenAI for stage 2, and the DB/collaborators for the shared
// post-confirmation handler.
const {
  createMock, recordLlmUsageMock, hasInterventionActionMock, updateSessionStatusMock,
  logInterventionActionMock, draftEligibilityAeMock, endChatSessionMock, clearSteeringMock,
  redactSessionMock, nameSessionMock, insightsMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  recordLlmUsageMock: vi.fn().mockResolvedValue(undefined),
  hasInterventionActionMock: vi.fn().mockResolvedValue(false),
  updateSessionStatusMock: vi.fn().mockResolvedValue({}),
  logInterventionActionMock: vi.fn().mockResolvedValue(undefined),
  draftEligibilityAeMock: vi.fn().mockResolvedValue(1),
  endChatSessionMock: vi.fn(),
  clearSteeringMock: vi.fn(),
  redactSessionMock: vi.fn().mockResolvedValue(undefined),
  nameSessionMock: vi.fn().mockResolvedValue(undefined),
  insightsMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));
vi.mock('../db/index.js', () => ({
  recordLlmUsage: recordLlmUsageMock,
  hasInterventionAction: hasInterventionActionMock,
  updateSessionStatus: updateSessionStatusMock,
}));
vi.mock('./crisisDetection.service.js', () => ({ logInterventionAction: logInterventionActionMock }));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromEligibility: draftEligibilityAeMock }));
vi.mock('./chatTherapy.service.js', () => ({ endChatSession: endChatSessionMock }));
vi.mock('./crisisIntervention.service.js', () => ({ clearSteeringState: clearSteeringMock }));
vi.mock('./sessionRedaction.service.js', () => ({ redactSession: redactSessionMock }));
vi.mock('./sessionName.service.js', () => ({ generateSessionNameAsync: nameSessionMock }));
vi.mock('./sessionInsights.service.js', () => ({ generateSessionInsightsAsync: insightsMock }));

const {
  detectMinorDisclosurePatterns, confirmMinorDisclosure, handleConfirmedMinor,
  MINOR_ELIGIBILITY_MESSAGE, REALTIME_MINOR_GUIDANCE,
} = await import('./minorSafeguard.service.js');

function llmResponse(payload: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}

const emitMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  hasInterventionActionMock.mockResolvedValue(false);
  (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit: emitMock })) };
});

describe('detectMinorDisclosurePatterns — stage 1 positives', () => {
  const positives = [
    "I'm 15",
    'i am sixteen years old',
    "I'm a minor",
    "I'm in 8th grade",
    'not 18 yet',
    'I turn 16 next month',
    "I'm only 14 years old",
    "I'm under 18",
    "I'm a high school sophomore",
  ];
  for (const text of positives) {
    it(`matches: "${text}"`, () => {
      expect(detectMinorDisclosurePatterns(text).matched).toBe(true);
    });
  }
});

describe('detectMinorDisclosurePatterns — stage 1 negatives (must NOT reach stage 2)', () => {
  const negatives = [
    'my minor in college is psych',
    'my 15-year-old daughter has a cold',
    'when I was 15 I moved a lot',
    "I'm 15 minutes away",
    'I work with 12-year-olds',
    "I'm 34 and struggling",
    'my son is 16',
    "I'm running about 10 minutes late",
  ];
  for (const text of negatives) {
    it(`does NOT match: "${text}"`, () => {
      expect(detectMinorDisclosurePatterns(text).matched).toBe(false);
    });
  }

  it('normalizes curly quotes', () => {
    expect(detectMinorDisclosurePatterns('I’m 15').matched).toBe(true);
  });
});

describe('confirmMinorDisclosure — stage 2', () => {
  it('parses a confirmed minor verdict and records usage', async () => {
    createMock.mockResolvedValue(llmResponse({ is_minor: true, stated_age: 15, confidence: 'high', reasoning: 'clear' }));
    const v = await confirmMinorDisclosure("I'm 15", [], 'sess-1');
    expect(v).toEqual({ isMinor: true, statedAge: 15, confidence: 'high', reasoning: 'clear' });
    expect(recordLlmUsageMock).toHaveBeenCalledWith('sess-1', 'eligibility', 'gpt-4o-mini', 10, 5);
  });

  it('returns is_minor=false for a false-positive family (adult / bystander)', async () => {
    createMock.mockResolvedValue(llmResponse({ is_minor: false, stated_age: null, confidence: 'high', reasoning: 'daughter' }));
    const v = await confirmMinorDisclosure('my 15-year-old daughter', [], 'sess-1');
    expect(v.isMinor).toBe(false);
  });

  it('defaults unknown confidence to low', async () => {
    createMock.mockResolvedValue(llmResponse({ is_minor: true, stated_age: 16 }));
    const v = await confirmMinorDisclosure("I'm 16", [], 'sess-1');
    expect(v.confidence).toBe('low');
  });

  it('THROWS on API failure (caller treats as not-confirmed / fail-open)', async () => {
    createMock.mockRejectedValue(new Error('openai down'));
    await expect(confirmMinorDisclosure("I'm 15", [], 'sess-1')).rejects.toThrow();
  });
});

describe('handleConfirmedMinor — shared actions', () => {
  it('chat: logs, drafts AE, emits, ends immediately', async () => {
    await handleConfirmedMinor({ sessionId: 'chat_1', messageId: 5, channel: 'chat', statedAge: 15 });
    expect(logInterventionActionMock).toHaveBeenCalledWith('chat_1', 'eligibility_minor_end', expect.objectContaining({ statedAge: 15, channel: 'chat' }));
    expect(draftEligibilityAeMock).toHaveBeenCalledWith('chat_1', expect.objectContaining({ statedAge: 15 }));
    expect(updateSessionStatusMock).toHaveBeenCalledWith('chat_1', 'ended', 'system');
    expect(endChatSessionMock).toHaveBeenCalledWith('chat_1');
  });

  it('is idempotent — skips everything if an eligibility_minor_end action already exists', async () => {
    hasInterventionActionMock.mockResolvedValue(true);
    await handleConfirmedMinor({ sessionId: 'chat_1', messageId: 5, channel: 'chat', statedAge: 15 });
    expect(logInterventionActionMock).not.toHaveBeenCalled();
    expect(draftEligibilityAeMock).not.toHaveBeenCalled();
    expect(updateSessionStatusMock).not.toHaveBeenCalled();
  });

  it('realtime: defers the status end past the grace window', async () => {
    vi.useFakeTimers();
    try {
      await handleConfirmedMinor({ sessionId: 'sess-1', messageId: 5, channel: 'realtime', statedAge: 15 });
      // Intervention + AE fire immediately; the status end is deferred.
      expect(logInterventionActionMock).toHaveBeenCalled();
      expect(updateSessionStatusMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(updateSessionStatusMock).toHaveBeenCalledWith('sess-1', 'ended', 'system');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('copy constants', () => {
  it('MINOR_ELIGIBILITY_MESSAGE embeds crisis resources so ending is safe', () => {
    expect(MINOR_ELIGIBILITY_MESSAGE).toContain('988');
    expect(MINOR_ELIGIBILITY_MESSAGE).toContain('741741');
    expect(MINOR_ELIGIBILITY_MESSAGE).toContain('18 or older');
  });
  it('REALTIME_MINOR_GUIDANCE is a hidden clinical-guidance directive', () => {
    expect(REALTIME_MINOR_GUIDANCE).toContain('[Clinical guidance');
    expect(REALTIME_MINOR_GUIDANCE).toContain('988');
  });
});
