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
  getSessionRiskPeakMock,
  recordLlmUsageMock,
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
  getSessionRiskPeakMock: vi.fn(),
  recordLlmUsageMock: vi.fn(),
}));

/** Matches the real crisis.queries helper; the barrel is mocked wholesale. */
function hasSafetyContextImpl(ctx: {
  crisisEvents: unknown[];
  escalations: unknown[];
  resourceCards: unknown[];
  adverseEvents: unknown[];
}): boolean {
  return (
    ctx.crisisEvents.length > 0 ||
    ctx.escalations.length > 0 ||
    ctx.resourceCards.length > 0 ||
    ctx.adverseEvents.length > 0
  );
}

const EMPTY_SAFETY = { crisisEvents: [], escalations: [], resourceCards: [], adverseEvents: [] };
const NO_PEAK = { crisis_flagged: false, peak_severity: null, peak_risk_score: null };

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
  getSessionRiskPeak: getSessionRiskPeakMock,
  hasSafetyContext: hasSafetyContextImpl,
  recordLlmUsage: recordLlmUsageMock,
}));

const { generateSessionInsights, FULL_MAX_COMPLETION_TOKENS, ESSENTIAL_MAX_COMPLETION_TOKENS, INCOMPLETE_HEADLINE } =
  await import('./sessionInsights.service.js');

function llmResponse(payload: Record<string, unknown>) {
  return {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }],
    usage: { prompt_tokens: 3600, completion_tokens: 1150 },
  };
}

/** A reply cut off at the output cap: finish_reason 'length', JSON unterminated. */
function truncatedResponse() {
  return {
    choices: [
      {
        finish_reason: 'length',
        message: { content: '{"summary": {"headline": "Struggles with Work Stress an' },
      },
    ],
    usage: { prompt_tokens: 3600, completion_tokens: 3200 },
  };
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
  getSessionRiskPeakMock.mockReset().mockResolvedValue(NO_PEAK);
  recordLlmUsageMock.mockReset().mockResolvedValue(undefined);
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

  it('ordinary path: one strict json_schema call with the raised cap, no retry', async () => {
    createMock.mockResolvedValue(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP, affect: [] }));
    await generateSessionInsights('s1');
    expect(createMock).toHaveBeenCalledTimes(1);
    const req = createMock.mock.calls[0][0];
    expect(req.model).toBe('gpt-4o-mini');
    expect(req.max_completion_tokens).toBe(FULL_MAX_COMPLETION_TOKENS);
    expect(req).not.toHaveProperty('max_tokens');
    expect(req.response_format.type).toBe('json_schema');
    expect(req.response_format.json_schema.strict).toBe(true);
    const props = req.response_format.json_schema.schema.properties;
    expect(Object.keys(props)).toEqual(['summary', 'soap', 'affect']); // no case_profile without memory consent
    expect(req.messages).toHaveLength(2);
    expect(upsertSessionInsightsMock).toHaveBeenCalledTimes(1);
    expect(upsertSessionInsightsMock.mock.calls[0][2].incomplete).toBeUndefined();
  });

  describe('truncation, retry and safety fallback (ai-therapist-346)', () => {
    it('a reply cut off at the cap (finish_reason length) triggers one essential-fields retry', async () => {
      createMock
        .mockResolvedValueOnce(truncatedResponse())
        .mockResolvedValueOnce(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP }));
      await generateSessionInsights('s1');
      expect(createMock).toHaveBeenCalledTimes(2);
      const retry = createMock.mock.calls[1][0];
      expect(retry.max_completion_tokens).toBe(ESSENTIAL_MAX_COMPLETION_TOKENS);
      expect(Object.keys(retry.response_format.json_schema.schema.properties)).toEqual(['summary', 'soap']);
      expect(retry.messages[1].content).toMatch(/^RETRY/);
      // Same transcript on the retry.
      expect(retry.messages[2].content).toBe(createMock.mock.calls[0][0].messages[1].content);
    });

    it('detects truncation from finish_reason even when the cut-off text happens to parse', async () => {
      const r = llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP });
      r.choices[0].finish_reason = 'length';
      createMock
        .mockResolvedValueOnce(r)
        .mockResolvedValueOnce(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP }));
      await generateSessionInsights('s1');
      expect(createMock).toHaveBeenCalledTimes(2);
    });

    it('retry success stores the full summary and SOAP note (no affect, case profile untouched)', async () => {
      getSessionMock.mockResolvedValue({ session_id: 's1', user_id: 42, checkin: null });
      getUserMemoryEnabledMock.mockResolvedValue(true);
      createMock
        .mockResolvedValueOnce(truncatedResponse())
        .mockResolvedValueOnce(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP }));
      await generateSessionInsights('s1');
      expect(upsertSessionInsightsMock).toHaveBeenCalledWith('s1', 42, BASIC_SUMMARY, BASIC_SOAP, 'gpt-4o-mini', null);
      expect(upsertUserCaseProfileMock).not.toHaveBeenCalled();
      // Both attempts are costed.
      await vi.waitFor(() => expect(recordLlmUsageMock).toHaveBeenCalledTimes(2));
    });

    it('double failure stores the safety fallback, marked incomplete, and does not throw', async () => {
      createMock.mockResolvedValueOnce(truncatedResponse()).mockRejectedValueOnce(new Error('503 upstream'));
      await expect(generateSessionInsights('s1')).resolves.toBeUndefined();
      expect(upsertSessionInsightsMock).toHaveBeenCalledTimes(1);
      const [, , summary, soap, model, affect] = upsertSessionInsightsMock.mock.calls[0];
      expect(summary).toMatchObject({
        headline: INCOMPLETE_HEADLINE,
        incomplete: true,
        crisis_flagged: false,
        peak_severity: null,
        peak_risk_score: null,
      });
      expect(summary.incomplete_reason).toMatch(/full: reply cut off at max_completion_tokens/);
      expect(summary.incomplete_reason).toMatch(/essential: API error: 503 upstream/);
      expect(summary).not.toHaveProperty('safety'); // nothing safety-relevant happened
      expect(soap.assessment).toMatch(/Automated draft unavailable/);
      expect(model).toBe('gpt-4o-mini');
      expect(affect).toBeNull();
    });

    it('invalid JSON, a missing field or a refusal are failed attempts, not thrown errors', async () => {
      createMock
        .mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] })
        .mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'no' } }] });
      await generateSessionInsights('s1');
      const summary = upsertSessionInsightsMock.mock.calls[0][2];
      expect(summary.incomplete_reason).toMatch(/full: reply was not valid JSON/);
      expect(summary.incomplete_reason).toMatch(/essential: model refused/);

      upsertSessionInsightsMock.mockClear();
      createMock.mockReset().mockResolvedValue(llmResponse({ summary: BASIC_SUMMARY }));
      await generateSessionInsights('s1');
      expect(upsertSessionInsightsMock.mock.calls[0][2].incomplete_reason).toMatch(/missing summary or soap/);
    });

    it('a crisis-flagged session ALWAYS ends with a safety line, peak severity and score stored', async () => {
      // Flag on the session row only (no crisis_events rows returned), and
      // both model attempts fail.
      getSessionRiskPeakMock.mockResolvedValue({ crisis_flagged: true, peak_severity: 'high', peak_risk_score: 88 });
      createMock.mockResolvedValueOnce(truncatedResponse()).mockResolvedValueOnce(truncatedResponse());
      await generateSessionInsights('s1');
      const summary = upsertSessionInsightsMock.mock.calls[0][2];
      expect(summary).toMatchObject({
        incomplete: true,
        crisis_flagged: true,
        peak_severity: 'high',
        peak_risk_score: 88,
      });
      expect(summary.safety).toBe(
        'Safety: this session recorded a crisis flag, highest severity high, peak risk score 88. Review the session record.',
      );
    });

    it('a crisis-flagged session gets the deterministic safety line when the model leaves it empty', async () => {
      getSessionRiskPeakMock.mockResolvedValue({ crisis_flagged: true, peak_severity: 'medium', peak_risk_score: 55 });
      createMock.mockResolvedValue(llmResponse({ summary: { ...BASIC_SUMMARY, safety: '' }, soap: BASIC_SOAP }));
      await generateSessionInsights('s1');
      // The row flag reaches the summarizer even with no crisis_events rows.
      const userMessage = createMock.mock.calls[0][0].messages[1].content as string;
      expect(userMessage).toContain('SAFETY EVENTS');
      expect(userMessage).toContain('session crisis flag (severity: medium) (risk score: 55)');
      expect(upsertSessionInsightsMock.mock.calls[0][2].safety).toMatch(/crisis flag, highest severity medium/);
    });

    it('a stored fallback row is not final: the next run regenerates over it', async () => {
      getSessionInsightsMock.mockResolvedValue({ summary: { headline: INCOMPLETE_HEADLINE, incomplete: true } });
      createMock.mockResolvedValue(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP }));
      await generateSessionInsights('s1');
      expect(upsertSessionInsightsMock.mock.calls[0][2]).toEqual(BASIC_SUMMARY);
    });

    it('bounds a very long session: opening plus the end, middle omitted', async () => {
      const long = Array.from({ length: 400 }, (_, i) => [
        { role: 'user', content: `participant turn ${i} ${'x'.repeat(40)}` },
        { role: 'assistant', content: `assistant turn ${i}` },
      ]).flat();
      getSessionMessagesMock.mockResolvedValue(long);
      createMock.mockResolvedValue(llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP }));
      await generateSessionInsights('s1');
      const content = createMock.mock.calls[0][0].messages[1].content as string;
      expect(content.length).toBeLessThan(12200);
      expect(content).toContain('participant turn 0 ');
      expect(content).toContain('assistant turn 399');
      expect(content).toMatch(/characters from the middle of the session omitted/);
    });
  });

  describe('safety context (ai-therapist-256)', () => {
    const AT = new Date('2026-09-20T14:35:00Z');
    const FULL_SAFETY = {
      crisisEvents: [{ event_type: 'crisis_flagged', severity: 'high', created_at: AT }],
      escalations: [
        { source: 'tool', reason: 'domestic violence disclosure', urgency: 'urgent', status: null, created_at: AT },
      ],
      resourceCards: [{ tool_name: 'show_resource_card', resource_type: 'domestic_violence', created_at: AT }],
      adverseEvents: [
        {
          report_id: 77,
          severity: 'high',
          category: 'crisis',
          status: 'draft',
          summary: 'DV disclosure',
          created_at: AT,
        },
      ],
    };

    it('injects crisis events, escalations, resource cards and AE drafts into the LLM context', async () => {
      getSessionSafetyContextMock.mockResolvedValue(FULL_SAFETY);
      createMock.mockResolvedValue(
        llmResponse({
          summary: {
            ...BASIC_SUMMARY,
            safety: 'High-severity crisis flag after a DV disclosure; resources shown and escalated.',
          },
          soap: BASIC_SOAP,
        }),
      );

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

      expect(upsertSessionInsightsMock.mock.calls[0][2].safety).toMatch(
        /^Safety: this session recorded 1 crisis event/,
      );
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
      createMock.mockResolvedValue(
        llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP, case_profile: freshProfile }),
      );

      await generateSessionInsights('s1');

      const userMessage = createMock.mock.calls[0][0].messages[1].content as string;
      expect(userMessage).not.toContain('PRIOR CASE PROFILE');
      expect(createMock.mock.calls[0][0].response_format.json_schema.schema.required).toContain('case_profile');
      expect(upsertUserCaseProfileMock).toHaveBeenCalledWith(42, freshProfile);
    });

    it('passes the existing profile to the model and stores the MERGED result (not appended)', async () => {
      getUserMemoryEnabledMock.mockResolvedValue(true);
      const priorProfile = {
        presenting_concerns: ['sleep'],
        coping_repertoire: [{ technique: 'breathing', helpfulness: 'helped' }],
      };
      getUserCaseProfileMock.mockResolvedValue({ user_id: 42, profile: priorProfile, updated_at: new Date() });
      const mergedProfile = {
        presenting_concerns: ['sleep', 'work stress'],
        coping_repertoire: [{ technique: 'breathing', helpfulness: 'helped' }],
      };
      createMock.mockResolvedValue(
        llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP, case_profile: mergedProfile }),
      );

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
      createMock.mockResolvedValue(
        llmResponse({ summary: BASIC_SUMMARY, soap: BASIC_SOAP, case_profile: { presenting_concerns: [] } }),
      );

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
      { turn: 'x', valence: 0.1, arousal: 0.1 }, // bad turn
      { turn: 2, valence: 'high', arousal: 0.5 }, // bad valence
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
