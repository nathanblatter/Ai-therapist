import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db barrel + OpenAI so tests exercise generateSessionInsights'
// idempotency, transcript assembly, and rolling case-profile merge
// (ai-therapist-47) without touching Postgres or the network.
const {
  createMock,
  getSessionMock,
  getSessionMessagesMock,
  getSessionInsightsMock,
  upsertSessionInsightsMock,
  getUserMemoryEnabledMock,
  getUserCaseProfileMock,
  upsertUserCaseProfileMock,
  getSessionSafetyContextMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  getSessionMock: vi.fn(),
  getSessionMessagesMock: vi.fn(),
  getSessionInsightsMock: vi.fn(),
  upsertSessionInsightsMock: vi.fn(),
  getUserMemoryEnabledMock: vi.fn(),
  getUserCaseProfileMock: vi.fn(),
  upsertUserCaseProfileMock: vi.fn(),
  getSessionSafetyContextMock: vi.fn(),
}));

/** Matches the real crisis.queries helper; the barrel is mocked wholesale. */
function hasSafetyContextImpl(ctx: {
  crisisEvents: unknown[]; escalations: unknown[]; resourceCards: unknown[]; adverseEvents: unknown[];
}): boolean {
  return ctx.crisisEvents.length > 0 || ctx.escalations.length > 0
    || ctx.resourceCards.length > 0 || ctx.adverseEvents.length > 0;
}

const EMPTY_SAFETY = { crisisEvents: [], escalations: [], resourceCards: [], adverseEvents: [] };

vi.mock('../config/secrets.js', () => ({
  getOpenAIKey: vi.fn().mockResolvedValue('test-key'),
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

vi.mock('../db/index.js', () => ({
  getSession: getSessionMock,
  getSessionMessages: getSessionMessagesMock,
  getSessionInsights: getSessionInsightsMock,
  upsertSessionInsights: upsertSessionInsightsMock,
  getUserMemoryEnabled: getUserMemoryEnabledMock,
  getUserCaseProfile: getUserCaseProfileMock,
  upsertUserCaseProfile: upsertUserCaseProfileMock,
  getSessionSafetyContext: getSessionSafetyContextMock,
  hasSafetyContext: hasSafetyContextImpl,
}));

const { generateSessionInsights } = await import('./sessionInsights.service.js');

function llmResponse(payload: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

const BASIC_SUMMARY = { headline: 'Talked about work stress', topics: ['work'] };
const BASIC_SOAP = { subjective: 's', objective: 'o', assessment: 'a', plan: 'p' };

beforeEach(() => {
  createMock.mockReset();
  getSessionMock.mockReset().mockResolvedValue({ session_id: 's1', user_id: null, checkin: null });
  getSessionMessagesMock.mockReset().mockResolvedValue([
    { role: 'user', content: 'work has been rough' },
    { role: 'assistant', content: 'that sounds hard' },
  ]);
  getSessionInsightsMock.mockReset().mockResolvedValue(null);
  upsertSessionInsightsMock.mockReset().mockResolvedValue(undefined);
  getUserMemoryEnabledMock.mockReset().mockResolvedValue(false);
  getUserCaseProfileMock.mockReset().mockResolvedValue(null);
  upsertUserCaseProfileMock.mockReset().mockResolvedValue(undefined);
  getSessionSafetyContextMock.mockReset().mockResolvedValue(EMPTY_SAFETY);
});

describe('generateSessionInsights', () => {
  it('skips sessions that do not exist', async () => {
    getSessionMock.mockResolvedValue(null);
    await generateSessionInsights('missing');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('is idempotent: skips sessions that already have insights', async () => {
    getSessionInsightsMock.mockResolvedValue({ summary: BASIC_SUMMARY });
    await generateSessionInsights('s1');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('skips sessions with no conversation content', async () => {
    getSessionMessagesMock.mockResolvedValue([]);
    await generateSessionInsights('s1');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('persists summary + soap for an anonymous session, without touching the case profile', async () => {
    createMock.mockResolvedValue(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP }));
    await generateSessionInsights('s1');
    expect(upsertSessionInsightsMock).toHaveBeenCalledWith('s1', null, BASIC_SUMMARY, BASIC_SOAP, 'gpt-4o-mini', null);
    expect(getUserCaseProfileMock).not.toHaveBeenCalled();
    expect(upsertUserCaseProfileMock).not.toHaveBeenCalled();
  });

  it('throws when the model response is not valid JSON', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: 'not json' } }] });
    await expect(generateSessionInsights('s1')).rejects.toThrow(/not valid JSON/);
  });

  it('throws when the model response is missing summary or soap', async () => {
    createMock.mockResolvedValue(llmResponse({ summary: BASIC_SUMMARY }));
    await expect(generateSessionInsights('s1')).rejects.toThrow(/missing summary or soap/);
  });

  describe('safety context (ai-therapist-256)', () => {
    const AT = new Date('2026-09-20T14:35:00Z');
    const FULL_SAFETY = {
      crisisEvents: [{ event_type: 'crisis_flagged', severity: 'high', created_at: AT }],
      escalations: [{ source: 'tool', reason: 'domestic violence disclosure', urgency: 'urgent', status: null, created_at: AT }],
      resourceCards: [{ tool_name: 'show_resource_card', resource_type: 'domestic_violence', created_at: AT }],
      adverseEvents: [{ report_id: 77, severity: 'high', category: 'crisis', status: 'draft', summary: 'DV disclosure', created_at: AT }],
    };

    it('injects crisis events, escalations, resource cards and AE drafts into the LLM context', async () => {
      getSessionSafetyContextMock.mockResolvedValue(FULL_SAFETY);
      createMock.mockResolvedValue(llmResponse({
        summary: { ...BASIC_SUMMARY, safety: 'High-severity crisis flag after a DV disclosure; resources shown and escalated.' },
        soap: BASIC_SOAP,
      }));

      await generateSessionInsights('s1');

      const userMessage = createMock.mock.calls[0][0].messages[1].content as string;
      expect(userMessage).toContain('SAFETY EVENTS');
      expect(userMessage).toContain('crisis_flagged');
      expect(userMessage).toContain('severity: high');
      expect(userMessage).toContain('escalate_to_human tool call: domestic violence disclosure');
      expect(userMessage).toContain('show_resource_card (domestic_violence)');
      expect(userMessage).toContain('adverse-event report #77');
      const stored = upsertSessionInsightsMock.mock.calls[0][2];
      expect(stored.safety).toContain('DV disclosure');
    });

    it('substitutes a deterministic safety line when the model omits one', async () => {
      getSessionSafetyContextMock.mockResolvedValue(FULL_SAFETY);
      createMock.mockResolvedValue(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP }));

      await generateSessionInsights('s1');

      const stored = upsertSessionInsightsMock.mock.calls[0][2];
      expect(stored.safety).toContain('1 crisis event(s)');
      expect(stored.safety).toContain('highest severity high');
      expect(stored.safety).toContain('1 escalation(s) to a human');
      expect(stored.safety).toContain('show_resource_card');
      expect(stored.safety).toContain('#77');
    });

    it('replaces an empty safety string from the model when events exist', async () => {
      getSessionSafetyContextMock.mockResolvedValue({ ...EMPTY_SAFETY, crisisEvents: FULL_SAFETY.crisisEvents });
      createMock.mockResolvedValue(llmResponse({ summary: { ...BASIC_SUMMARY, safety: '   ' }, soap: BASIC_SOAP }));

      await generateSessionInsights('s1');

      expect(upsertSessionInsightsMock.mock.calls[0][2].safety).toMatch(/^Safety: this session recorded 1 crisis event/);
    });

    it('adds no safety block or field for a session with nothing safety-relevant', async () => {
      createMock.mockResolvedValue(llmResponse({ summary: { ...BASIC_SUMMARY, safety: '' }, soap: BASIC_SOAP }));

      await generateSessionInsights('s1');

      const userMessage = createMock.mock.calls[0][0].messages[1].content as string;
      expect(userMessage).not.toContain('SAFETY EVENTS');
      expect(upsertSessionInsightsMock.mock.calls[0][2]).not.toHaveProperty('safety');
    });
  });

  describe('rolling case profile (ai-therapist-47)', () => {
    beforeEach(() => {
      getSessionMock.mockResolvedValue({ session_id: 's1', user_id: 42, checkin: null });
    });

    it('does not request/store a case profile when the user has not consented to memory', async () => {
      getUserMemoryEnabledMock.mockResolvedValue(false);
      createMock.mockResolvedValue(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP }));
      await generateSessionInsights('s1');
      expect(getUserCaseProfileMock).not.toHaveBeenCalled();
      expect(upsertUserCaseProfileMock).not.toHaveBeenCalled();
      const userMessage = createMock.mock.calls[0][0].messages[1].content as string;
      expect(userMessage).not.toContain('PRIOR CASE PROFILE');
    });

    it('builds a fresh profile (no prior) for a first-time consented user', async () => {
      getUserMemoryEnabledMock.mockResolvedValue(true);
      getUserCaseProfileMock.mockResolvedValue(null);
      const freshProfile = { presenting_concerns: ['work stress'], coping_repertoire: [] };
      createMock.mockResolvedValue(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP, case_profile: freshProfile }));

      await generateSessionInsights('s1');

      const userMessage = createMock.mock.calls[0][0].messages[1].content as string;
      expect(userMessage).not.toContain('PRIOR CASE PROFILE');
      expect(upsertUserCaseProfileMock).toHaveBeenCalledWith(42, freshProfile);
    });

    it('passes the existing profile to the model and stores the MERGED result (not appended)', async () => {
      getUserMemoryEnabledMock.mockResolvedValue(true);
      const priorProfile = { presenting_concerns: ['sleep'], coping_repertoire: [{ technique: 'breathing', helpfulness: 'helped' }] };
      getUserCaseProfileMock.mockResolvedValue({ user_id: 42, profile: priorProfile, updated_at: new Date() });
      const mergedProfile = {
        presenting_concerns: ['sleep', 'work stress'],
        coping_repertoire: [{ technique: 'breathing', helpfulness: 'helped' }],
      };
      createMock.mockResolvedValue(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP, case_profile: mergedProfile }));

      await generateSessionInsights('s1');

      const userMessage = createMock.mock.calls[0][0].messages[1].content as string;
      expect(userMessage).toContain('PRIOR CASE PROFILE');
      expect(userMessage).toContain('"sleep"');
      // The service stores exactly what the model returned as the new merged
      // profile — it never appends the prior profile alongside it.
      expect(upsertUserCaseProfileMock).toHaveBeenCalledTimes(1);
      expect(upsertUserCaseProfileMock).toHaveBeenCalledWith(42, mergedProfile);
    });

    it('a case-profile persistence failure does not prevent the summary/soap from being saved', async () => {
      getUserMemoryEnabledMock.mockResolvedValue(true);
      getUserCaseProfileMock.mockResolvedValue(null);
      upsertUserCaseProfileMock.mockRejectedValue(new Error('db down'));
      createMock.mockResolvedValue(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP, case_profile: { presenting_concerns: [] } }));

      await expect(generateSessionInsights('s1')).resolves.not.toThrow();
      expect(upsertSessionInsightsMock).toHaveBeenCalled();
    });

    it('skips storing a case profile when the model omits it, without throwing', async () => {
      getUserMemoryEnabledMock.mockResolvedValue(true);
      getUserCaseProfileMock.mockResolvedValue(null);
      createMock.mockResolvedValue(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP }));

      await generateSessionInsights('s1');
      expect(upsertUserCaseProfileMock).not.toHaveBeenCalled();
    });
  });
});

describe('sanitizeAffectCurve (ai-therapist-86)', () => {
  it('clamps ranges, drops malformed entries, sorts by turn, caps at 60', async () => {
    const { sanitizeAffectCurve } = await import('./sessionInsights.service.js');
    const raw = [
      { turn: 3, valence: 2.5, arousal: -0.2, label: 'ANXIOUS' },
      { turn: 1, valence: -0.4, arousal: 0.7, label: 'sad' },
      { turn: 'x', valence: 0.1, arousal: 0.1 },              // bad turn
      { turn: 2, valence: 'high', arousal: 0.5 },              // bad valence
      { turn: 4, valence: 0.2, arousal: 0.3, label: 'a quoted sentence from the user' }, // label rejected
    ];
    const out = sanitizeAffectCurve(raw)!;
    expect(out.map((p) => p.turn)).toEqual([1, 3, 4]);
    expect(out[1]).toEqual({ turn: 3, valence: 1, arousal: 0, label: 'anxious' });
    expect(out[2].label).toBeUndefined();
    const long = Array.from({ length: 100 }, (_, i) => ({ turn: i + 1, valence: 0, arousal: 0 }));
    expect(sanitizeAffectCurve(long)!.length).toBe(60);
  });

  it('returns null for non-arrays and empty results (affect never blocks insights)', async () => {
    const { sanitizeAffectCurve } = await import('./sessionInsights.service.js');
    expect(sanitizeAffectCurve(undefined)).toBeNull();
    expect(sanitizeAffectCurve('nope')).toBeNull();
    expect(sanitizeAffectCurve([{ turn: 'bad' }])).toBeNull();
  });
});
