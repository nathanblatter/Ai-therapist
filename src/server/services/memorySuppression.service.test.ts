import { describe, it, expect, beforeEach, vi } from 'vitest';

// ai-therapist-341: what the post-session job does with a "forget that".
// The db barrel is mocked; the model check is injected.
const db = vi.hoisted(() => ({
  getUserMemorySuppressions: vi.fn(),
  insertMemorySuppression: vi.fn(),
  markMemorySuppressionsApplied: vi.fn(),
  excludeSummariesFromMemory: vi.fn(),
  getUserMemoriesWithDates: vi.fn(),
  getRecentUserSummaries: vi.fn(),
  getUserCaseProfile: vi.fn(),
  upsertUserCaseProfile: vi.fn(),
  recordLlmUsage: vi.fn(),
}));
vi.mock('../db/index.js', () => db);
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));

const {
  applyForgetRequests,
  buildDoNotCarryForwardBlock,
  profileItems,
  stripProfile,
  summaryMemoryText,
  suppressionTopics,
} = await import('./memorySuppression.service.js');

const at = new Date('2026-11-19T10:00:00Z');
const suppression = (over: Record<string, unknown> = {}) => ({
  suppression_id: 3,
  user_id: 42,
  session_id: 'earlier',
  topic: 'what they said about a test at school',
  source: 'tool' as const,
  suppressed_memory_ids: [] as number[],
  created_at: at,
  applied_at: null as Date | null,
  ...over,
});
const FORGET_TURN = 'Actually, forget that. Can you erase it?';

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  db.getUserMemorySuppressions.mockResolvedValue([]);
  db.insertMemorySuppression.mockResolvedValue(true);
  db.getUserMemoriesWithDates.mockResolvedValue([]);
  db.getRecentUserSummaries.mockResolvedValue([]);
  db.getUserCaseProfile.mockResolvedValue(null);
});

describe('pure helpers', () => {
  it('builds no block when there is nothing to leave out', () => {
    expect(buildDoNotCarryForwardBlock([])).toBe('');
    expect(buildDoNotCarryForwardBlock(['a thing'])).toContain('- a thing');
  });

  it('dedupes topics case-insensitively', () => {
    expect(suppressionTopics([{ topic: 'A test' }, { topic: 'a test ' }, { topic: 'other' }])).toEqual([
      'A test',
      'other',
    ]);
  });

  it('reads exactly the memory-facing fields of a summary (never the safety line or the requests)', () => {
    const text = summaryMemoryText({
      headline: 'H',
      topics: ['t1'],
      mood_trajectory: 'm',
      techniques_helped: ['walk'],
      follow_up: 'f',
      safety: 'SAFETY',
      forget_requests: ['SECRET'],
    });
    expect(text).toBe('H | t1 | m | walk | f');
  });

  it('addresses and strips single case-profile entries', () => {
    const profile = {
      presenting_concerns: ['low mood', 'the test'],
      coping_repertoire: [{ technique: 'walking', helpfulness: 'helped' as const }],
      screener_trend: 'steady',
    };
    expect(profileItems('np', profile).map((i) => i.id)).toEqual([
      'np:presenting_concerns:0',
      'np:presenting_concerns:1',
      'np:coping_repertoire:0',
      'np:screener_trend:0',
    ]);
    expect(stripProfile('np', profile, new Set(['np:presenting_concerns:1', 'np:screener_trend:0']))).toEqual({
      presenting_concerns: ['low mood'],
      coping_repertoire: [{ technique: 'walking', helpfulness: 'helped' }],
      screener_trend: '',
    });
  });
});

describe('applyForgetRequests', () => {
  const base = { userId: 42, sessionId: 's1', participantText: 'work has been rough' };

  it('returns its input unchanged for a participant who never asked, without calling the check', async () => {
    const check = vi.fn();
    const out = await applyForgetRequests(
      { ...base, summary: { headline: 'Work' }, caseProfile: { values: ['family'] } },
      check,
    );
    expect(out.summary).toEqual({ headline: 'Work' });
    expect(out.caseProfile).toEqual({ values: ['family'] });
    expect(check).not.toHaveBeenCalled();
  });

  it('checks older facts, summaries and the stored profile once, and hides what mentions the topic', async () => {
    db.getUserMemorySuppressions.mockResolvedValue([suppression({ session_id: 's1' })]);
    db.getUserMemoriesWithDates.mockResolvedValue([
      { memory_id: 11, fact: 'They cheated on a test.', session_id: null, created_at: at },
      { memory_id: 12, fact: 'Their sister is called Ana.', session_id: null, created_at: at },
    ]);
    db.getRecentUserSummaries.mockResolvedValue([
      { session_id: 's0', summary: { headline: 'Guilt about a test' }, ended_at: at, created_at: at },
      { session_id: 's1', summary: { headline: 'this session' }, ended_at: at, created_at: at },
      { session_id: 'sx', summary: { headline: 'fallback', incomplete: true }, ended_at: at, created_at: at },
    ]);
    db.getUserCaseProfile.mockResolvedValue({
      user_id: 42,
      profile: { stressors: ['the test', 'rent'] },
      updated_at: at,
    });
    const check = vi.fn().mockResolvedValue(new Set(['fact:11', 'summary:s0', 'op:stressors:0']));

    const out = await applyForgetRequests(
      { ...base, participantText: FORGET_TURN, summary: { headline: 'x' }, caseProfile: { values: ['honesty'] } },
      check,
    );

    // This session: excluded whole, and its profile update dropped.
    expect(out.summary.memory_excluded).toBe(true);
    expect(out.caseProfile).toBeNull();
    // The check saw only older items, never this session's summary or the fallback row.
    const ids = (check.mock.calls[0][2] as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toEqual(['fact:11', 'fact:12', 'summary:s0', 'op:stressors:0', 'op:stressors:1']);
    expect(db.excludeSummariesFromMemory).toHaveBeenCalledWith(42, ['s0']);
    expect(db.upsertUserCaseProfile).toHaveBeenCalledWith(42, { stressors: ['rent'] });
    // Not applied until the caller has stored its rows.
    expect(db.markMemorySuppressionsApplied).not.toHaveBeenCalled();
    await out.finalize();
    expect(db.markMemorySuppressionsApplied).toHaveBeenCalledWith(42, [3], [11]);
  });

  it('fails closed when the check is unavailable', async () => {
    db.getUserMemorySuppressions.mockResolvedValue([suppression()]);
    const out = await applyForgetRequests(
      { ...base, summary: { headline: 'Work' }, caseProfile: { values: ['family'] } },
      vi.fn().mockResolvedValue(null),
    );
    expect(out.summary.memory_excluded).toBe(true);
    expect(out.caseProfile).toBeNull();
    await out.finalize();
    expect(db.markMemorySuppressionsApplied).not.toHaveBeenCalled();
  });

  it('excludes the summary when a detected request cannot be recorded (migration not applied)', async () => {
    db.insertMemorySuppression.mockResolvedValue(false);
    const check = vi.fn();
    const out = await applyForgetRequests(
      {
        ...base,
        participantText: FORGET_TURN,
        summary: { headline: 'Guilt', forget_requests: ['what they said about a test'] },
        caseProfile: { values: ['honesty'] },
      },
      check,
    );
    expect(out.summary.memory_excluded).toBe(true);
    expect(out.caseProfile).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('an already-applied earlier request only screens what this session wrote', async () => {
    db.getUserMemorySuppressions.mockResolvedValue([suppression({ applied_at: at })]);
    const check = vi.fn().mockResolvedValue(new Set<string>());
    const out = await applyForgetRequests(
      { ...base, summary: { headline: 'Work' }, caseProfile: { values: ['family'] } },
      check,
    );
    expect((check.mock.calls[0][2] as Array<{ id: string }>).map((i) => i.id)).toEqual(['new_summary', 'np:values:0']);
    expect(out.summary.memory_excluded).toBeUndefined();
    expect(out.caseProfile).toEqual({ values: ['family'] });
    expect(db.getUserMemoriesWithDates).not.toHaveBeenCalled();
  });
});
