import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db barrel so buildMemoryBlock's composition can be tested without
// Postgres. Individual block-builder functions (buildCaseProfileBlock etc.)
// are pure and tested directly against fixtures.
const {
  getRecentUserSummariesMock,
  countUserEndedSessionsMock,
  getUserMemoryEnabledMock,
  getUserMemoriesMock,
  getUserCaseProfileMock,
  getUserScaleHistoryMock,
  getUserMoodTrajectoryMock,
  getUserLatestSafetyPlanMock,
  getUserLatestThoughtRecordMock,
  getLatestClinicianNoteMock,
  getUserRiskContextEnabledMock,
  getUserPriorCrisisFlagsMock,
} = vi.hoisted(() => ({
  getRecentUserSummariesMock: vi.fn(),
  countUserEndedSessionsMock: vi.fn(),
  getUserMemoryEnabledMock: vi.fn(),
  getUserMemoriesMock: vi.fn(),
  getUserCaseProfileMock: vi.fn(),
  getUserScaleHistoryMock: vi.fn(),
  getUserMoodTrajectoryMock: vi.fn(),
  getUserLatestSafetyPlanMock: vi.fn(),
  getUserLatestThoughtRecordMock: vi.fn(),
  getLatestClinicianNoteMock: vi.fn(),
  getUserRiskContextEnabledMock: vi.fn(),
  getUserPriorCrisisFlagsMock: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getRecentUserSummaries: getRecentUserSummariesMock,
  countUserEndedSessions: countUserEndedSessionsMock,
  getUserMemoryEnabled: getUserMemoryEnabledMock,
  getUserMemories: getUserMemoriesMock,
  getUserCaseProfile: getUserCaseProfileMock,
  getUserScaleHistory: getUserScaleHistoryMock,
  getUserMoodTrajectory: getUserMoodTrajectoryMock,
  getUserLatestSafetyPlan: getUserLatestSafetyPlanMock,
  getUserLatestThoughtRecord: getUserLatestThoughtRecordMock,
  getLatestClinicianNote: getLatestClinicianNoteMock,
  getUserRiskContextEnabled: getUserRiskContextEnabledMock,
  getUserPriorCrisisFlags: getUserPriorCrisisFlagsMock,
}));

const {
  buildMemoryBlock,
  buildCaseProfileBlock,
  buildReturningSignalsBlock,
  buildClinicianNoteBlock,
  buildRiskHistoryBlock,
  buildToolGuidanceBlock,
} = await import('./promptContext.js');

beforeEach(() => {
  getRecentUserSummariesMock.mockReset().mockResolvedValue([]);
  countUserEndedSessionsMock.mockReset().mockResolvedValue(0);
  getUserMemoryEnabledMock.mockReset().mockResolvedValue(true);
  getUserMemoriesMock.mockReset().mockResolvedValue([]);
  getUserCaseProfileMock.mockReset().mockResolvedValue(null);
  getUserScaleHistoryMock.mockReset().mockResolvedValue([]);
  getUserMoodTrajectoryMock.mockReset().mockResolvedValue([]);
  getUserLatestSafetyPlanMock.mockReset().mockResolvedValue(null);
  getUserLatestThoughtRecordMock.mockReset().mockResolvedValue(null);
  getLatestClinicianNoteMock.mockReset().mockResolvedValue(null);
  getUserRiskContextEnabledMock.mockReset().mockResolvedValue(false);
  getUserPriorCrisisFlagsMock.mockReset().mockResolvedValue([]);
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

  it('never throws — a DB failure yields an empty block so the session can still start', async () => {
    getUserMemoryEnabledMock.mockRejectedValue(new Error('db down'));
    await expect(buildMemoryBlock(42)).resolves.toBe('');
  });
});
