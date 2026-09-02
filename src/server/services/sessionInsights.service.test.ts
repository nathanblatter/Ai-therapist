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
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  getSessionMock: vi.fn(),
  getSessionMessagesMock: vi.fn(),
  getSessionInsightsMock: vi.fn(),
  upsertSessionInsightsMock: vi.fn(),
  getUserMemoryEnabledMock: vi.fn(),
  getUserCaseProfileMock: vi.fn(),
  upsertUserCaseProfileMock: vi.fn(),
}));

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
