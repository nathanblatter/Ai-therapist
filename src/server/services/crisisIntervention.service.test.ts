// High-risk paging path (finding: sandbox suppression must FAIL TOWARD
// PAGING). The sandbox check is isolated so a transient lookup error can
// never swallow a real on-call page, and suppression logging stays out of
// the paging critical path.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  poolQueryMock,
  logInterventionActionMock,
  sendCrisisAlertMock,
  isSandboxAccountSessionMock,
  sidebandManagerMock,
} = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  logInterventionActionMock: vi.fn(),
  sendCrisisAlertMock: vi.fn(),
  isSandboxAccountSessionMock: vi.fn(),
  sidebandManagerMock: {
    getActiveConnections: vi.fn(() => [] as string[]),
    injectMessage: vi.fn(),
    tryInject: vi.fn(),
  },
}));

vi.mock('../config/db.js', () => ({ pool: { query: poolQueryMock } }));
vi.mock('./crisisDetection.service.js', () => ({ logInterventionAction: logInterventionActionMock }));
vi.mock('./crisisAlert.service.js', () => ({ sendCrisisAlert: sendCrisisAlertMock }));
vi.mock('./sidebandManager.service.js', () => ({ sidebandManager: sidebandManagerMock }));
vi.mock('../db/index.js', () => ({
  isSandboxAccountSession: isSandboxAccountSessionMock,
  // Transitive imports of utils/adminBroadcast.js:
  getSessionAccessInfo: vi.fn(),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));

const { executeGraduatedResponse } = await import('./crisisIntervention.service.js');

const flush = async () => {
  // The paging chain is fire-and-forget (import().then...); drain it.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  vi.clearAllMocks();
  (global as unknown as { io: unknown }).io = undefined;
  poolQueryMock.mockResolvedValue({ rows: [] });
  logInterventionActionMock.mockResolvedValue(undefined);
  sendCrisisAlertMock.mockResolvedValue(undefined);
  isSandboxAccountSessionMock.mockResolvedValue(false);
});

describe('executeGraduatedResponse — high-risk paging', () => {
  it('pages the on-call for a real session and logs crisis_sms_alert', async () => {
    await executeGraduatedResponse('sess-1', 'high', 90);
    await flush();
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(logInterventionActionMock).toHaveBeenCalledWith('sess-1', 'crisis_sms_alert', { riskScore: 90 });
  });

  it('suppresses the page only on an affirmative sandbox=true (suppression logged out-of-band)', async () => {
    isSandboxAccountSessionMock.mockResolvedValue(true);
    await executeGraduatedResponse('sbx-1', 'high', 90);
    await flush();
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    expect(logInterventionActionMock).toHaveBeenCalledWith('sbx-1', 'external_api_called',
      expect.objectContaining({ suppressed: 'crisis_sms_alert', reason: 'sandbox' }));
  });

  it('FAILS TOWARD PAGING: a throwing sandbox lookup still sends the real page', async () => {
    isSandboxAccountSessionMock.mockRejectedValue(new Error('db blip'));
    await executeGraduatedResponse('sess-1', 'high', 90);
    await flush();
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('a throwing suppression log cannot resurrect or break anything (sandbox path)', async () => {
    isSandboxAccountSessionMock.mockResolvedValue(true);
    logInterventionActionMock.mockRejectedValue(new Error('log down'));
    await expect(executeGraduatedResponse('sbx-1', 'high', 90)).resolves.toBeUndefined();
    await flush();
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
  });

  it('non-high severity never pages', async () => {
    await executeGraduatedResponse('sess-1', 'medium', 55);
    await flush();
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
  });
});
