// Assessor health tracker (ai-therapist-190): one record per session, one
// signal per incident, and nothing that can throw into the scoring path.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OpenAIErrorInfo } from '../utils/openaiErrors.js';

const { logInterventionActionMock, reportOutageMock, broadcastMock } = vi.hoisted(() => ({
  logInterventionActionMock: vi.fn(),
  reportOutageMock: vi.fn(),
  broadcastMock: vi.fn(),
}));

vi.mock('./crisisDetection.service.js', () => ({ logInterventionAction: logInterventionActionMock }));
vi.mock('./crisisAlert.service.js', () => ({ reportRiskAssessorOutage: reportOutageMock }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: broadcastMock }));

const { noteAssessorFailure, noteAssessorSuccess, assessorIncidentOpen, _resetAssessorHealthForTests } = await import(
  './riskAssessorHealth.service.js'
);

const failure = (kind: OpenAIErrorInfo['kind'], code: string | null = null): OpenAIErrorInfo => ({
  kind,
  code,
  status: null,
  retryAfterMs: null,
});
const TIMEOUT = failure('timeout');
const QUOTA = failure('quota', 'organization_spend_limit_exceeded');

const emitMock = vi.fn();
const toMock = vi.fn(() => ({ emit: emitMock }));
/** Let the fire-and-forget page settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));
const systemEvents = (event: string) => emitMock.mock.calls.filter((c) => c[0] === event);

beforeEach(() => {
  _resetAssessorHealthForTests();
  vi.clearAllMocks();
  logInterventionActionMock.mockResolvedValue(undefined);
  reportOutageMock.mockResolvedValue(true);
  broadcastMock.mockResolvedValue(undefined);
  (global as unknown as { io: unknown }).io = { to: toMock };
});

describe('per-session record', () => {
  it('writes one intervention row and one session event on the first failure in a session', async () => {
    await noteAssessorFailure('sess-a', TIMEOUT);

    expect(logInterventionActionMock).toHaveBeenCalledTimes(1);
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      'sess-a',
      // An existing action type: no migration (the column has a CHECK constraint).
      'external_api_called',
      expect.objectContaining({ degraded: 'risk_assessor', reason: 'timeout' }),
    );
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.anything(),
      'session:risk-assessment-degraded',
      expect.objectContaining({ sessionId: 'sess-a', component: 'risk_assessor', reason: 'timeout' }),
      'sess-a',
      'summary',
    );
  });

  it('does not repeat the row for later failures in the same session', async () => {
    for (let i = 0; i < 6; i++) await noteAssessorFailure('sess-a', TIMEOUT);
    expect(logInterventionActionMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('records each session the outage touches', async () => {
    await noteAssessorFailure('sess-a', TIMEOUT);
    await noteAssessorFailure('sess-b', TIMEOUT);
    expect(logInterventionActionMock.mock.calls.map((c) => c[0])).toEqual(['sess-a', 'sess-b']);
  });

  it('records the session again in a later, separate outage', async () => {
    await noteAssessorFailure('sess-a', TIMEOUT);
    noteAssessorSuccess();
    await noteAssessorFailure('sess-a', TIMEOUT);
    expect(logInterventionActionMock).toHaveBeenCalledTimes(2);
  });

  it('carries no transcript text and no participant identity in the row', async () => {
    await noteAssessorFailure('sess-a', failure('other', 'model_not_found'));
    expect(Object.keys(logInterventionActionMock.mock.calls[0][2]).sort()).toEqual([
      'code',
      'degraded',
      'detail',
      'reason',
      'status',
    ]);
  });
});

describe('per-incident signal', () => {
  it('is not an incident after a single failed assessment', async () => {
    await noteAssessorFailure('sess-a', TIMEOUT);
    await flush();
    expect(assessorIncidentOpen()).toBe(false);
    expect(reportOutageMock).not.toHaveBeenCalled();
    expect(systemEvents('system:risk-assessment-degraded')).toHaveLength(0);
  });

  it('opens on the second consecutive failure: one page and one researcher-room event', async () => {
    await noteAssessorFailure('sess-a', TIMEOUT);
    await noteAssessorFailure('sess-a', TIMEOUT);
    await flush();

    expect(assessorIncidentOpen()).toBe(true);
    expect(reportOutageMock).toHaveBeenCalledTimes(1);
    expect(reportOutageMock).toHaveBeenCalledWith('timeout', null, 2);
    expect(toMock).toHaveBeenCalledWith('admin-broadcast');
    expect(systemEvents('system:risk-assessment-degraded')).toHaveLength(1);
  });

  it('does not page again however long the outage lasts', async () => {
    for (let i = 0; i < 40; i++) {
      await noteAssessorFailure(`sess-${i % 4}`, TIMEOUT);
      await flush();
    }
    expect(reportOutageMock).toHaveBeenCalledTimes(1);
    expect(systemEvents('system:risk-assessment-degraded')).toHaveLength(1);
  });

  it('counts failures with no session (the caseworker message scan) toward the incident', async () => {
    await noteAssessorFailure(null, TIMEOUT);
    await noteAssessorFailure(null, TIMEOUT);
    await flush();
    expect(reportOutageMock).toHaveBeenCalledTimes(1);
    expect(logInterventionActionMock).not.toHaveBeenCalled();
  });

  it('leaves the spend cap to its own page: a quota incident is broadcast but not paged twice', async () => {
    await noteAssessorFailure('sess-a', QUOTA);
    await noteAssessorFailure('sess-a', QUOTA);
    await flush();
    expect(assessorIncidentOpen()).toBe(true);
    expect(reportOutageMock).not.toHaveBeenCalled();
    expect(systemEvents('system:risk-assessment-degraded')).toHaveLength(1);
  });

  it('a success closes the incident, says so once, and a later outage is a new incident', async () => {
    await noteAssessorFailure('sess-a', TIMEOUT);
    await noteAssessorFailure('sess-a', TIMEOUT);
    await flush();

    noteAssessorSuccess();
    noteAssessorSuccess();
    expect(assessorIncidentOpen()).toBe(false);
    expect(systemEvents('system:risk-assessment-restored')).toHaveLength(1);

    await noteAssessorFailure('sess-a', TIMEOUT);
    await noteAssessorFailure('sess-a', TIMEOUT);
    await flush();
    // The health tracker asks again; whether a second page goes out within the
    // hour is crisisAlert's throttle (see crisisAlert.service.test.ts).
    expect(reportOutageMock).toHaveBeenCalledTimes(2);
  });

  it('one failure between successes never becomes an incident', async () => {
    for (let i = 0; i < 10; i++) {
      await noteAssessorFailure('sess-a', TIMEOUT);
      noteAssessorSuccess();
    }
    await flush();
    expect(reportOutageMock).not.toHaveBeenCalled();
    expect(systemEvents('system:risk-assessment-restored')).toHaveLength(0);
  });

  it('tries the page again on the next failure when it could not be delivered', async () => {
    reportOutageMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    await noteAssessorFailure('sess-a', TIMEOUT);
    await noteAssessorFailure('sess-a', TIMEOUT);
    await flush();
    await noteAssessorFailure('sess-a', TIMEOUT);
    await flush();
    await noteAssessorFailure('sess-a', TIMEOUT);
    await flush();
    expect(reportOutageMock).toHaveBeenCalledTimes(2);
    // The researcher-room event is still sent once.
    expect(systemEvents('system:risk-assessment-degraded')).toHaveLength(1);
  });
});

describe('never throws into the scoring path', () => {
  it('survives a failing intervention insert, a failing broadcast and a failing pager', async () => {
    logInterventionActionMock.mockRejectedValue(new Error('db down'));
    reportOutageMock.mockRejectedValue(new Error('pager down'));
    toMock.mockImplementationOnce(() => {
      throw new Error('socket down');
    });
    await expect(noteAssessorFailure('sess-a', TIMEOUT)).resolves.toBeUndefined();
    await expect(noteAssessorFailure('sess-a', TIMEOUT)).resolves.toBeUndefined();
    await flush();
    expect(() => noteAssessorSuccess()).not.toThrow();
  });

  it('works with no socket server at all', async () => {
    (global as unknown as { io: unknown }).io = undefined;
    await noteAssessorFailure('sess-a', TIMEOUT);
    await noteAssessorFailure('sess-a', TIMEOUT);
    await flush();
    noteAssessorSuccess();
    expect(reportOutageMock).toHaveBeenCalledTimes(1);
  });
});
