// getUserProfileBundle (ai-therapist-110): shape, consent gating, and limit
// passthrough. This is the shared fan-out behind both buildMemoryBlock and the
// admin participant-profile page, so its gating rules matter clinically.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRecentUserSummaries: vi.fn(),
  countUserEndedSessions: vi.fn(),
  getUserMemoryEnabled: vi.fn(),
  getLatestClinicianNote: vi.fn(),
  getUserMemoriesWithDates: vi.fn(),
  getUserCaseProfile: vi.fn(),
  getUserScaleHistory: vi.fn(),
  getUserMoodTrajectory: vi.fn(),
  getUserLatestSafetyPlan: vi.fn(),
  getUserLatestThoughtRecord: vi.fn(),
  getUserRiskContextEnabled: vi.fn(),
  getUserPriorCrisisFlags: vi.fn(),
}));

vi.mock('./insights.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRecentUserSummaries: mocks.getRecentUserSummaries,
  countUserEndedSessions: mocks.countUserEndedSessions,
  getUserMemoryEnabled: mocks.getUserMemoryEnabled,
  getLatestClinicianNote: mocks.getLatestClinicianNote,
}));
vi.mock('./tools.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserMemoriesWithDates: mocks.getUserMemoriesWithDates,
}));
vi.mock('./caseProfile.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserCaseProfile: mocks.getUserCaseProfile,
}));
vi.mock('./returningContext.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserScaleHistory: mocks.getUserScaleHistory,
  getUserMoodTrajectory: mocks.getUserMoodTrajectory,
  getUserLatestSafetyPlan: mocks.getUserLatestSafetyPlan,
  getUserLatestThoughtRecord: mocks.getUserLatestThoughtRecord,
}));
vi.mock('./crisis.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserRiskContextEnabled: mocks.getUserRiskContextEnabled,
  getUserPriorCrisisFlags: mocks.getUserPriorCrisisFlags,
}));

const { getUserProfileBundle } = await import('./participantProfile.queries.js');

beforeEach(() => {
  mocks.getRecentUserSummaries.mockReset().mockResolvedValue([]);
  mocks.countUserEndedSessions.mockReset().mockResolvedValue(0);
  mocks.getUserMemoryEnabled.mockReset().mockResolvedValue(true);
  mocks.getLatestClinicianNote.mockReset().mockResolvedValue(null);
  mocks.getUserMemoriesWithDates.mockReset().mockResolvedValue([]);
  mocks.getUserCaseProfile.mockReset().mockResolvedValue(null);
  mocks.getUserScaleHistory.mockReset().mockResolvedValue([]);
  mocks.getUserMoodTrajectory.mockReset().mockResolvedValue([]);
  mocks.getUserLatestSafetyPlan.mockReset().mockResolvedValue(null);
  mocks.getUserLatestThoughtRecord.mockReset().mockResolvedValue(null);
  mocks.getUserRiskContextEnabled.mockReset().mockResolvedValue(false);
  mocks.getUserPriorCrisisFlags.mockReset().mockResolvedValue([]);
});

describe('getUserProfileBundle', () => {
  it('returns the full structured bundle', async () => {
    const fact = { fact: 'Has a dog named Milo', session_id: 's1', created_at: new Date('2026-07-01') };
    mocks.getUserMemoriesWithDates.mockResolvedValue([fact]);
    mocks.countUserEndedSessions.mockResolvedValue(4);
    mocks.getUserCaseProfile.mockResolvedValue({ user_id: 42, profile: { presenting_concerns: ['anxiety'] }, updated_at: new Date() });

    const bundle = await getUserProfileBundle(42);

    expect(bundle).toMatchObject({
      memory_enabled: true,
      risk_context_share_enabled: false,
      summaries: [],
      ended_session_count: 4,
      memories: [fact],
      scale_history: [],
      mood_trajectory: [],
      safety_plan: null,
      thought_record: null,
      clinician_note: null,
      prior_crisis_flags: [],
    });
    expect(bundle.case_profile?.profile.presenting_concerns).toEqual(['anxiety']);
  });

  it('never fetches prior crisis flags unless risk-context sharing is enabled', async () => {
    mocks.getUserRiskContextEnabled.mockResolvedValue(false);
    const bundle = await getUserProfileBundle(42);
    expect(bundle.prior_crisis_flags).toEqual([]);
    expect(mocks.getUserPriorCrisisFlags).not.toHaveBeenCalled();
  });

  it('fetches prior crisis flags with the exclusion session when sharing is enabled', async () => {
    mocks.getUserRiskContextEnabled.mockResolvedValue(true);
    const flag = { session_id: 's0', severity: 'high', flagged_at: new Date(), unflagged_at: null, unflagged_by: null };
    mocks.getUserPriorCrisisFlags.mockResolvedValue([flag]);

    const bundle = await getUserProfileBundle(42, { sessionId: 's-current', crisisFlagsLimit: 3 });

    expect(bundle.prior_crisis_flags).toEqual([flag]);
    expect(mocks.getUserPriorCrisisFlags).toHaveBeenCalledWith(42, 's-current', 3);
  });

  it('passes explicit prompt-sized limits through to each query', async () => {
    await getUserProfileBundle(42, {
      summariesLimit: 3,
      memoriesLimit: 8,
      scalePerScale: 2,
      moodLimit: 6,
    });
    expect(mocks.getRecentUserSummaries).toHaveBeenCalledWith(42, 3);
    expect(mocks.getUserMemoriesWithDates).toHaveBeenCalledWith(42, 8);
    expect(mocks.getUserScaleHistory).toHaveBeenCalledWith(42, 2);
    expect(mocks.getUserMoodTrajectory).toHaveBeenCalledWith(42, 6);
  });
});
