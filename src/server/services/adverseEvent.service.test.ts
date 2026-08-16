import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every collaborator so the assembler runs without a DB or network.
const {
  getLatestCrisisEventIdMock,
  getRiskCheckStepsMock,
  getSessionInterventionActionsMock,
  getSessionAeSnapshotMock,
  getRecentSessionMessagesMock,
  insertAdverseEventDraftMock,
  getSessionCrisisEventsMock,
  redactPHIBatchMock,
} = vi.hoisted(() => ({
  getLatestCrisisEventIdMock: vi.fn(),
  getRiskCheckStepsMock: vi.fn(),
  getSessionInterventionActionsMock: vi.fn(),
  getSessionAeSnapshotMock: vi.fn(),
  getRecentSessionMessagesMock: vi.fn(),
  insertAdverseEventDraftMock: vi.fn(),
  getSessionCrisisEventsMock: vi.fn(),
  redactPHIBatchMock: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getLatestCrisisEventId: getLatestCrisisEventIdMock,
  getRiskCheckSteps: getRiskCheckStepsMock,
  getSessionInterventionActions: getSessionInterventionActionsMock,
  getSessionAeSnapshot: getSessionAeSnapshotMock,
  getRecentSessionMessages: getRecentSessionMessagesMock,
  insertAdverseEventDraft: insertAdverseEventDraftMock,
}));
vi.mock('./crisisDetection.service.js', () => ({ getSessionCrisisEvents: getSessionCrisisEventsMock }));
vi.mock('./redaction.service.js', () => ({ redactPHIBatch: redactPHIBatchMock }));

const { draftAdverseEventFromCrisis, draftAdverseEventFromEligibility } = await import('./adverseEvent.service.js');

const OCCURRED = new Date('2026-07-31T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  getSessionAeSnapshotMock.mockResolvedValue({
    session_id: 'sess-1', user_id: 42, crisis_severity: 'high', crisis_risk_score: 88, crisis_flagged_at: OCCURRED,
    is_demo: false,
  });
  getLatestCrisisEventIdMock.mockResolvedValue(7);
  getSessionCrisisEventsMock.mockResolvedValue([
    { created_at: OCCURRED, event_type: 'flagged', severity: 'high', risk_score: 88 },
  ]);
  getRiskCheckStepsMock.mockResolvedValue([
    { created_at: OCCURRED, step: 'ideation', risk_band: 'high', answer: 'RAW SECRET ANSWER' },
  ]);
  getSessionInterventionActionsMock.mockResolvedValue([
    { action_id: 1, action_type: 'high_risk_emergency', performed_at: OCCURRED, performed_by: 'system', risk_score: 88 },
  ]);
  getRecentSessionMessagesMock.mockResolvedValue([
    { role: 'user', content: 'RAW PHI my name is John', content_redacted: 'my name is [REDACTED: NAME]' },
    { role: 'assistant', content: 'RAW how can I help', content_redacted: null },
  ]);
  redactPHIBatchMock.mockResolvedValue(new Map([[1, 'how can I help [clean]']]));
  insertAdverseEventDraftMock.mockResolvedValue(101);
});

describe('draftAdverseEventFromCrisis', () => {
  it('skips auto-drafts for non-study (demo/harness) sessions', async () => {
    getSessionAeSnapshotMock.mockResolvedValueOnce({
      session_id: 'sess-1', user_id: 42, crisis_severity: 'high', crisis_risk_score: 88, crisis_flagged_at: OCCURRED,
      is_demo: true,
    });
    const id = await draftAdverseEventFromCrisis('sess-1');
    expect(id).toBeNull();
    expect(insertAdverseEventDraftMock).not.toHaveBeenCalled();
  });

  it('assembles a draft using only redacted text — no raw content or ladder answers leak', async () => {
    const id = await draftAdverseEventFromCrisis('sess-1');
    expect(id).toBe(101);

    const input = insertAdverseEventDraftMock.mock.calls[0][0];
    const serialized = JSON.stringify(input);
    // Raw message content and raw ladder answers must never appear.
    expect(serialized).not.toContain('RAW');
    expect(serialized).not.toContain('SECRET');
    // Redacted excerpt uses content_redacted where present and redactPHIBatch output otherwise.
    expect(input.transcriptExcerpt).toContain('[REDACTED: NAME]');
    expect(input.transcriptExcerpt).toContain('how can I help [clean]');
    // Timeline carries the ladder band, not the answer text.
    expect(input.timeline.some((t: { detail: string }) => t.detail === 'ideation: high')).toBe(true);
    // Provenance + deadline.
    expect(input.crisisEventId).toBe(7);
    expect(input.severity).toBe('high');
    expect(input.dueAt.getTime()).toBe(OCCURRED.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(input.participantRef).toBe('user 42');
  });

  it('only redacts messages that lack a stored redacted form', async () => {
    await draftAdverseEventFromCrisis('sess-1');
    // Just the assistant message (no content_redacted) is sent to redactPHIBatch.
    expect(redactPHIBatchMock).toHaveBeenCalledTimes(1);
    const batchArg = redactPHIBatchMock.mock.calls[0][0];
    expect(batchArg).toHaveLength(1);
  });

  it('is idempotent per crisis event (returns null when a draft already exists)', async () => {
    insertAdverseEventDraftMock.mockResolvedValueOnce(null);
    const id = await draftAdverseEventFromCrisis('sess-1');
    expect(id).toBeNull();
  });

  it('drafts manually with crisis_event_id=null and manual trigger source', async () => {
    await draftAdverseEventFromCrisis('sess-1', { triggerSource: 'manual', createdBy: 'nathan' });
    const input = insertAdverseEventDraftMock.mock.calls[0][0];
    expect(input.crisisEventId).toBeNull();
    expect(input.triggerSource).toBe('manual');
    expect(input.createdBy).toBe('nathan');
    // Manual path does not consult the auto crisis-event linkage.
    expect(getLatestCrisisEventIdMock).not.toHaveBeenCalled();
  });

  it('never throws — swallows collaborator errors and returns null', async () => {
    getSessionInterventionActionsMock.mockRejectedValueOnce(new Error('db down'));
    await expect(draftAdverseEventFromCrisis('sess-1')).resolves.toBeNull();
  });

  it('returns null when the session does not exist', async () => {
    getSessionAeSnapshotMock.mockResolvedValueOnce(null);
    expect(await draftAdverseEventFromCrisis('missing')).toBeNull();
    expect(insertAdverseEventDraftMock).not.toHaveBeenCalled();
  });
});

describe('draftAdverseEventFromEligibility', () => {
  it('drafts an eligibility_violation AE — category, trigger, medium severity, redacted excerpt only', async () => {
    const id = await draftAdverseEventFromEligibility('sess-1', { statedAge: 15, messageId: 9 });
    expect(id).toBe(101);

    const input = insertAdverseEventDraftMock.mock.calls[0][0];
    expect(input.category).toBe('eligibility_violation');
    expect(input.triggerSource).toBe('auto_eligibility');
    expect(input.severity).toBe('medium');
    expect(input.crisisEventId).toBeNull();
    expect(input.summary).toContain('stated age 15');
    // Redacted-only excerpt (no raw content).
    expect(JSON.stringify(input)).not.toContain('RAW');
    expect(input.transcriptExcerpt).toContain('[REDACTED: NAME]');
    // Does not consult the crisis-event linkage.
    expect(getLatestCrisisEventIdMock).not.toHaveBeenCalled();
  });

  it('summary handles unknown stated age', async () => {
    await draftAdverseEventFromEligibility('sess-1', { statedAge: null });
    expect(insertAdverseEventDraftMock.mock.calls[0][0].summary).toContain('stated age unknown');
  });

  it('is idempotent per session (returns null when a draft already exists)', async () => {
    insertAdverseEventDraftMock.mockResolvedValueOnce(null);
    expect(await draftAdverseEventFromEligibility('sess-1', { statedAge: 16 })).toBeNull();
  });

  it('never throws — swallows collaborator errors and returns null', async () => {
    getSessionInterventionActionsMock.mockRejectedValueOnce(new Error('db down'));
    await expect(draftAdverseEventFromEligibility('sess-1', { statedAge: 15 })).resolves.toBeNull();
  });

  it('returns null when the session does not exist', async () => {
    getSessionAeSnapshotMock.mockResolvedValueOnce(null);
    expect(await draftAdverseEventFromEligibility('missing', { statedAge: 15 })).toBeNull();
    expect(insertAdverseEventDraftMock).not.toHaveBeenCalled();
  });
});
