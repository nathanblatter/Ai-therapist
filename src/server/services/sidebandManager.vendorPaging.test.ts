// Wiring only: when the vendor ends a voice session, the sideband manager hands
// the paging decision to crisisPaging.service with what it read from the
// session row, and no longer sends an SMS of its own (ai-therapist-350). The
// rules themselves are tested in crisisPaging.service.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, pageVendorTerminationMock, sendCrisisAlertMock, broadcastMock, timeStatusMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  pageVendorTerminationMock: vi.fn(),
  sendCrisisAlertMock: vi.fn(),
  broadcastMock: vi.fn(async () => undefined),
  timeStatusMock: vi.fn(),
}));

vi.mock('ws', () => ({ default: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock } }));
vi.mock('../db/index.js', () => ({}));
vi.mock('../db/liveUsage.queries.js', () => ({ recordLiveUsage: vi.fn() }));
vi.mock('./crisisPipeline.service.js', () => ({ runCrisisPipeline: vi.fn() }));
vi.mock('./toolRegistry.service.js', () => ({ toolRegistry: { executeTool: vi.fn() } }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: broadcastMock }));
vi.mock('../utils/safetyIdentifier.js', () => ({ safetyIdentifierForSession: vi.fn() }));
vi.mock('../utils/sessionHelpers.js', () => ({ getSystemConfig: vi.fn(async () => ({})), getActiveModality: vi.fn() }));
vi.mock('./crisisDetection.service.js', () => ({ logInterventionAction: vi.fn(async () => undefined) }));
vi.mock('./crisisAlert.service.js', () => ({ sendCrisisAlert: sendCrisisAlertMock }));
vi.mock('./crisisPaging.service.js', () => ({ pageVendorTermination: pageVendorTerminationMock }));
vi.mock('../utils/sessionAutoTerminate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/sessionAutoTerminate.js')>()),
  getSessionTimeStatus: timeStatusMock,
}));

import { sidebandManager } from './sidebandManager.service.js';
import { clearCrisisResourceState, emitCrisisResources } from './crisisResources.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = sidebandManager as any;

const sessionRow = (row: { crisis_flagged: boolean | null; crisis_severity: string | null } | null): void => {
  queryMock.mockImplementation(async (sql: string) =>
    typeof sql === 'string' && sql.includes('crisis_flagged') && row
      ? { rows: [row], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  clearCrisisResourceState();
  timeStatusMock.mockReturnValue(null);
  pageVendorTerminationMock.mockResolvedValue({ outcome: 'paged' });
  delete (global as { io?: unknown }).io;
});

describe('handleModerationTermination hands paging to crisisPaging.service', () => {
  it('content filter on a session flagged high', async () => {
    sessionRow({ crisis_flagged: true, crisis_severity: 'high' });
    await sb.handleModerationTermination('s-cut-high', 'content_filter');
    expect(pageVendorTerminationMock).toHaveBeenCalledTimes(1);
    expect(pageVendorTerminationMock).toHaveBeenCalledWith({
      sessionId: 's-cut-high',
      cause: 'content_filter',
      flagged: true,
      severity: 'high',
    });
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
  });

  it('content filter on an unflagged session: still handed over (the policy decides, not the caller)', async () => {
    sessionRow({ crisis_flagged: false, crisis_severity: null });
    await sb.handleModerationTermination('s-cut-calm', 'content_filter');
    expect(pageVendorTerminationMock).toHaveBeenCalledWith({
      sessionId: 's-cut-calm',
      cause: 'content_filter',
      flagged: false,
      severity: null,
    });
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
  });

  it('a session row that cannot be read is handed over as unflagged, not dropped', async () => {
    queryMock.mockRejectedValue(new Error('db down'));
    await sb.handleModerationTermination('s-cut-blind', 'content_filter');
    expect(pageVendorTerminationMock).toHaveBeenCalledWith({
      sessionId: 's-cut-blind',
      cause: 'content_filter',
      flagged: false,
      severity: null,
      stateSource: 'unknown',
    });
  });

  it('vendor ceiling: only during a high flag, as before', async () => {
    sessionRow({ crisis_flagged: true, crisis_severity: 'high' });
    await sb.handleModerationTermination('s-exp-high', 'expired');
    expect(pageVendorTerminationMock).toHaveBeenCalledWith({
      sessionId: 's-exp-high',
      cause: 'expired',
      flagged: true,
      severity: 'high',
    });

    pageVendorTerminationMock.mockClear();
    sessionRow({ crisis_flagged: true, crisis_severity: 'medium' });
    await sb.handleModerationTermination('s-exp-medium', 'expired');
    sessionRow({ crisis_flagged: false, crisis_severity: null });
    await sb.handleModerationTermination('s-exp-calm', 'expired');
    expect(pageVendorTerminationMock).not.toHaveBeenCalled();
  });

  // ai-therapist-369 item 3: an unreadable crisis state used to mean no
  // announcement and no page at the vendor's 60-minute ceiling.
  describe('vendor ceiling when the crisis state cannot be read', () => {
    const participantEmit = vi.fn();
    beforeEach(() => {
      queryMock.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
      (global as { io?: unknown }).io = { to: vi.fn(() => ({ emit: participantEmit })) };
      participantEmit.mockClear();
    });
    const announced = (sessionId: string) =>
      participantEmit.mock.calls.some(
        ([event, payload]) =>
          event === 'session:moderation-terminated' && (payload as { sessionId?: string }).sessionId === sessionId,
      );

    it('this server showed the session the high-risk card: hand-off and a high page', async () => {
      emitCrisisResources('s-exp-known', { reason: 'high_risk', severity: 'high', riskScore: 90 });
      await sb.handleModerationTermination('s-exp-known', 'expired');
      expect(announced('s-exp-known')).toBe(true);
      expect(pageVendorTerminationMock).toHaveBeenCalledWith({
        sessionId: 's-exp-known',
        cause: 'expired',
        flagged: true,
        severity: 'high',
        stateSource: 'in_process',
      });
    });

    it('this server lifted the session timer for a crisis: the same', async () => {
      timeStatusMock.mockReturnValue({ liftedForCrisis: true });
      await sb.handleModerationTermination('s-exp-lifted', 'expired');
      expect(announced('s-exp-lifted')).toBe(true);
      expect(pageVendorTerminationMock).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's-exp-lifted', stateSource: 'in_process', severity: 'high' }),
      );
    });

    it('nothing known: fails toward the hand-off, and pages saying the state could not be read', async () => {
      await sb.handleModerationTermination('s-exp-unknown', 'expired');
      expect(announced('s-exp-unknown')).toBe(true);
      expect(pageVendorTerminationMock).toHaveBeenCalledWith({
        sessionId: 's-exp-unknown',
        cause: 'expired',
        flagged: false,
        severity: null,
        stateSource: 'unknown',
      });
    });
  });

  it('a paging failure does not stop the termination from being recorded and broadcast', async () => {
    sessionRow({ crisis_flagged: true, crisis_severity: 'high' });
    pageVendorTerminationMock.mockRejectedValue(new Error('boom'));
    (global as { io?: unknown }).io = { to: vi.fn(() => ({ emit: vi.fn() })) };
    await expect(sb.handleModerationTermination('s-cut-err', 'content_filter')).resolves.toBeUndefined();
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.anything(),
      'session:moderation-terminated',
      expect.objectContaining({ sessionId: 's-cut-err', cause: 'content_filter', crisisFlagged: true }),
      's-cut-err',
    );
  });
});
