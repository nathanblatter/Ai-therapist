import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the individual db query modules so buildMemoryBlock's composition —
// which now flows through the shared getUserProfileBundle fan-out
// (ai-therapist-110) — can be tested without Postgres. Individual
// block-builder functions (buildCaseProfileBlock etc.) are pure and tested
// directly against fixtures.
const {
  getRecentUserSummariesMock,
  countUserEndedSessionsMock,
  getUserMemoryEnabledMock,
  getUserMemoriesWithDatesMock,
  getUserCaseProfileMock,
  getUserScaleHistoryMock,
  getUserMoodTrajectoryMock,
  getUserLatestSafetyPlanMock,
  getUserLatestThoughtRecordMock,
  getLatestClinicianNoteMock,
  getUserRiskContextEnabledMock,
  getUserPriorCrisisFlagsMock,
  listUserAssignmentsMock,
} = vi.hoisted(() => ({
  getRecentUserSummariesMock: vi.fn(),
  countUserEndedSessionsMock: vi.fn(),
  getUserMemoryEnabledMock: vi.fn(),
  getUserMemoriesWithDatesMock: vi.fn(),
  getUserCaseProfileMock: vi.fn(),
  getUserScaleHistoryMock: vi.fn(),
  getUserMoodTrajectoryMock: vi.fn(),
  getUserLatestSafetyPlanMock: vi.fn(),
  getUserLatestThoughtRecordMock: vi.fn(),
  getLatestClinicianNoteMock: vi.fn(),
  getUserRiskContextEnabledMock: vi.fn(),
  getUserPriorCrisisFlagsMock: vi.fn(),
  listUserAssignmentsMock: vi.fn(),
}));

vi.mock('../db/insights.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRecentUserSummaries: getRecentUserSummariesMock,
  countUserEndedSessions: countUserEndedSessionsMock,
  getUserMemoryEnabled: getUserMemoryEnabledMock,
  getLatestClinicianNote: getLatestClinicianNoteMock,
}));
vi.mock('../db/tools.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserMemoriesWithDates: getUserMemoriesWithDatesMock,
}));
vi.mock('../db/caseProfile.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserCaseProfile: getUserCaseProfileMock,
}));
vi.mock('../db/returningContext.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserScaleHistory: getUserScaleHistoryMock,
  getUserMoodTrajectory: getUserMoodTrajectoryMock,
  getUserLatestSafetyPlan: getUserLatestSafetyPlanMock,
  getUserLatestThoughtRecord: getUserLatestThoughtRecordMock,
}));
vi.mock('../db/crisis.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserRiskContextEnabled: getUserRiskContextEnabledMock,
  getUserPriorCrisisFlags: getUserPriorCrisisFlagsMock,
}));
vi.mock('../db/practiceAssignments.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listUserAssignments: listUserAssignmentsMock,
}));

const {
  buildMemoryBlock,
  buildCaseProfileBlock,
  buildReturningSignalsBlock,
  buildClinicianNoteBlock,
  buildRiskHistoryBlock,
  buildToolGuidanceBlock,
  buildPracticeBlock,
} = await import('./promptContext.js');

beforeEach(() => {
  getRecentUserSummariesMock.mockReset().mockResolvedValue([]);
  countUserEndedSessionsMock.mockReset().mockResolvedValue(0);
  getUserMemoryEnabledMock.mockReset().mockResolvedValue(true);
  getUserMemoriesWithDatesMock.mockReset().mockResolvedValue([]);
  getUserCaseProfileMock.mockReset().mockResolvedValue(null);
  getUserScaleHistoryMock.mockReset().mockResolvedValue([]);
  getUserMoodTrajectoryMock.mockReset().mockResolvedValue([]);
  getUserLatestSafetyPlanMock.mockReset().mockResolvedValue(null);
  getUserLatestThoughtRecordMock.mockReset().mockResolvedValue(null);
  getLatestClinicianNoteMock.mockReset().mockResolvedValue(null);
  getUserRiskContextEnabledMock.mockReset().mockResolvedValue(false);
  getUserPriorCrisisFlagsMock.mockReset().mockResolvedValue([]);
  listUserAssignmentsMock.mockReset().mockResolvedValue([]);
});

describe('buildCaseProfileBlock (ai-therapist-47)', () => {
  it('returns empty string for no profile', () => {
    expect(buildCaseProfileBlock(null)).toBe('');
  });

  it('renders coping repertoire ranked by what actually helped', () => {
    const block = buildCaseProfileBlock({
      presenting_concerns: ['work stress'],
      coping_repertoire: [
        { technique: 'breathing', helpfulness: 'helped' },
        { technique: 'journaling', helpfulness: 'did_not_help' },
      ],
    });
    expect(block).toContain('Presenting concerns: work stress');
    expect(block).toContain('breathing (helped)');
    expect(block.indexOf('breathing')).toBeLessThan(block.indexOf('journaling'));
  });
});

describe('buildReturningSignalsBlock (ai-therapist-48)', () => {
  it('returns empty string when there is nothing to show', () => {
    const block = buildReturningSignalsBlock({ scaleHistory: [], moodTrajectory: [], safetyPlan: null, thoughtRecord: null });
    expect(block).toBe('');
  });

  it('reports screener direction vs the previous response', () => {
    const block = buildReturningSignalsBlock({
      scaleHistory: [
        { scale: 'phq2', score: 2, created_at: new Date('2026-07-20'), session_id: 's2' },
        { scale: 'phq2', score: 5, created_at: new Date('2026-07-01'), session_id: 's1' },
      ],
      moodTrajectory: [],
      safetyPlan: null,
      thoughtRecord: null,
    });
    expect(block).toContain('PHQ2: 2 (was 5 — down)');
  });

  it('flags a first-time screener with no comparison', () => {
    const block = buildReturningSignalsBlock({
      scaleHistory: [{ scale: 'gad2', score: 4, created_at: new Date(), session_id: 's1' }],
      moodTrajectory: [],
      safetyPlan: null,
      thoughtRecord: null,
    });
    expect(block).toContain('GAD2: 4 (first recorded)');
  });

  it('includes safety-plan warning signs and the last balanced thought', () => {
    const block = buildReturningSignalsBlock({
      scaleHistory: [],
      moodTrajectory: [],
      safetyPlan: { plan: { warning_signs: ['isolating'] }, created_at: new Date() },
      thoughtRecord: { record: { balanced_thought: 'I can handle this one step at a time' }, created_at: new Date() },
    });
    expect(block).toContain('existing safety plan (warning signs on file: isolating)');
    expect(block).toContain('I can handle this one step at a time');
  });
});

describe('buildClinicianNoteBlock (ai-therapist-50)', () => {
  it('returns empty string when there is no note', () => {
    expect(buildClinicianNoteBlock(null)).toBe('');
  });

  it('includes the note and instructs the model not to read it aloud', () => {
    const block = buildClinicianNoteBlock({ notes: 'Gently check in about sleep.' });
    expect(block).toContain('Gently check in about sleep.');
    expect(block).toMatch(/never read this aloud/i);
  });
});

describe('buildRiskHistoryBlock (ai-therapist-52)', () => {
  it('returns empty string when there is no prior crisis history', () => {
    expect(buildRiskHistoryBlock([])).toBe('');
  });

  it('summarizes severity + resolution without inviting the model to lead with it', () => {
    const block = buildRiskHistoryBlock([
      { session_id: 's1', severity: 'high', flagged_at: new Date('2026-06-01'), unflagged_at: new Date('2026-06-02'), unflagged_by: 'dr.jones' },
    ]);
    expect(block).toContain('high severity');
    expect(block).toContain('later resolved/unflagged');
    expect(block).toMatch(/never lead with it/i);
    expect(block).toMatch(/do not mention dates, scores/i);
  });
});

describe('buildToolGuidanceBlock — wave 3 tools', () => {
  it('emits guidance lines only for enabled tools', () => {
    const none = buildToolGuidanceBlock([]);
    expect(none).toBe('');

    const all = buildToolGuidanceBlock(['review_practice', 'compare_screener_trend', 'retrieve_safety_plan']);
    expect(all).toContain('review_practice');
    expect(all).toContain('compare_screener_trend');
    expect(all).toContain('retrieve_safety_plan');
  });
});

describe('buildPracticeBlock (ai-therapist-123)', () => {
  const assignment = (over: Record<string, unknown>) => ({
    id: 1, user_id: 42, session_id: 's1', title: 'Practice', description: 'd',
    kind: 'custom' as const, suggested_frequency: null, status: 'assigned' as const,
    assigned_at: new Date('2026-08-01T00:00:00Z'), completed_at: null, completion_note: null,
    ...over,
  });

  it('returns empty string when there is nothing to show', () => {
    expect(buildPracticeBlock([], [])).toBe('');
  });

  it('lists open practice with title + assigned date on one compact line', () => {
    const block = buildPracticeBlock(
      [assignment({ title: 'Two-minute breathing' }), assignment({ id: 2, title: 'Worry log', assigned_at: new Date('2026-08-03T00:00:00Z') })],
      []
    );
    expect(block).toContain('Open practice from last time: Two-minute breathing (assigned 2026-08-01); Worry log (assigned 2026-08-03)');
  });

  it('lists completed-since-last-session practice one line each, capped at 3', () => {
    const completed = [1, 2, 3, 4].map(i =>
      assignment({ id: i, title: `Done ${i}`, status: 'completed', completed_at: new Date() })
    );
    const block = buildPracticeBlock([], completed);
    expect(block).toContain('- They completed: Done 1');
    expect(block).toContain('- They completed: Done 3');
    expect(block).not.toContain('Done 4');
  });

  it('caps the open list at 3', () => {
    const open = [1, 2, 3, 4].map(i => assignment({ id: i, title: `Open ${i}` }));
    const block = buildPracticeBlock(open, []);
    expect(block).toContain('Open 3');
    expect(block).not.toContain('Open 4');
  });
});

describe('buildMemoryBlock composition', () => {
  it('returns empty string for anonymous users', async () => {
    expect(await buildMemoryBlock(null)).toBe('');
    expect(getUserMemoryEnabledMock).not.toHaveBeenCalled();
  });

  it('returns empty string when the user has not opted into memory', async () => {
    getUserMemoryEnabledMock.mockResolvedValue(false);
    expect(await buildMemoryBlock(42)).toBe('');
    expect(getUserCaseProfileMock).not.toHaveBeenCalled();
  });

  it('returns empty string for a consented user with no context anywhere', async () => {
    expect(await buildMemoryBlock(42)).toBe('');
  });

  it('never fetches risk history when the therapist has not enabled sharing for this user', async () => {
    getUserRiskContextEnabledMock.mockResolvedValue(false);
    getRecentUserSummariesMock.mockResolvedValue([{ session_id: 's1', summary: { headline: 'x' }, session_name: null, ended_at: new Date(), created_at: new Date() }]);
    await buildMemoryBlock(42);
    expect(getUserPriorCrisisFlagsMock).not.toHaveBeenCalled();
  });

  it('composes the case profile, returning signals, clinician note, and risk history into one block when all are present', async () => {
    getRecentUserSummariesMock.mockResolvedValue([]);
    getUserCaseProfileMock.mockResolvedValue({ user_id: 42, profile: { presenting_concerns: ['anxiety'] }, updated_at: new Date() });
    getUserLatestSafetyPlanMock.mockResolvedValue({ plan: { warning_signs: ['not sleeping'] }, created_at: new Date(), session_id: 's1' });
    getLatestClinicianNoteMock.mockResolvedValue({ notes: 'Ask about the new job.', author: 'dr.jones', created_at: new Date(), session_id: 's1' });
    getUserRiskContextEnabledMock.mockResolvedValue(true);
    getUserPriorCrisisFlagsMock.mockResolvedValue([
      { session_id: 's0', severity: 'medium', flagged_at: new Date('2026-05-01'), unflagged_at: null, unflagged_by: null },
    ]);

    const block = await buildMemoryBlock(42, 's-current');

    expect(block).toContain('Presenting concerns: anxiety');
    expect(block).toContain('not sleeping');
    expect(block).toContain('Ask about the new job.');
    expect(block).toContain('medium severity');
    expect(getUserPriorCrisisFlagsMock).toHaveBeenCalledWith(42, 's-current', 3);
  });

  it('surfaces open practice (and completions since the last session) in the returning block', async () => {
    getRecentUserSummariesMock.mockResolvedValue([
      { session_id: 's1', summary: { headline: 'x' }, session_name: null, ended_at: new Date('2026-08-05T00:00:00Z'), created_at: new Date('2026-08-05T00:00:00Z') },
    ]);
    listUserAssignmentsMock.mockImplementation(async (_userId: number, opts: { status?: string }) => {
      if (opts.status === 'assigned') {
        return [{
          id: 1, user_id: 42, session_id: 's1', title: 'Two-minute breathing', description: 'd',
          kind: 'exercise', suggested_frequency: 'daily', status: 'assigned',
          assigned_at: new Date('2026-08-05T00:00:00Z'), completed_at: null, completion_note: null,
        }];
      }
      return [
        { // completed AFTER the last session ended -> shown
          id: 2, user_id: 42, session_id: 's1', title: 'Worry log', description: 'd',
          kind: 'observation', suggested_frequency: null, status: 'completed',
          assigned_at: new Date('2026-08-01T00:00:00Z'), completed_at: new Date('2026-08-08T00:00:00Z'), completion_note: null,
        },
        { // completed BEFORE the last session ended -> old news, not shown
          id: 3, user_id: 42, session_id: 's0', title: 'Old gratitude list', description: 'd',
          kind: 'custom', suggested_frequency: null, status: 'completed',
          assigned_at: new Date('2026-07-01T00:00:00Z'), completed_at: new Date('2026-07-02T00:00:00Z'), completion_note: null,
        },
      ];
    });

    const block = await buildMemoryBlock(42);
    expect(block).toContain('Open practice from last time: Two-minute breathing (assigned 2026-08-05)');
    expect(block).toContain('They completed: Worry log');
    expect(block).not.toContain('Old gratitude list');
  });

  it('a practice-assignments failure only drops that line — the rest of the block survives', async () => {
    getUserCaseProfileMock.mockResolvedValue({ user_id: 42, profile: { presenting_concerns: ['anxiety'] }, updated_at: new Date() });
    listUserAssignmentsMock.mockRejectedValue(new Error('table missing'));
    const block = await buildMemoryBlock(42);
    expect(block).toContain('Presenting concerns: anxiety');
    expect(block).not.toContain('Open practice');
  });

  it('never throws — a DB failure yields an empty block so the session can still start', async () => {
    getUserMemoryEnabledMock.mockRejectedValue(new Error('db down'));
    await expect(buildMemoryBlock(42)).resolves.toBe('');
  });
});
