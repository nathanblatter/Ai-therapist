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

const { executeGraduatedResponse, maybeSteerSession } = await import('./crisisIntervention.service.js');

/**
 * Wait until a fire-and-forget spy has been called.
 *
 * The paging chain is fire-and-forget through dynamic `import()`, whose
 * resolution timing is nondeterministic. Draining a FIXED number of ticks
 * (the previous approach) passed locally and on a warm runner but flaked on a
 * cold CI runner, where module resolution took longer than the budget — a
 * flaky test on the crisis-paging path is worse than no test, because it
 * trains you to re-run instead of read it.
 *
 * Polling until the call actually lands is deterministic in the success case
 * and still fails loudly, with a useful message, if paging genuinely regresses.
 */
const waitForCall = async (spy: { mock: { calls: unknown[] } }, times = 1, label = 'spy') => {
  const deadline = Date.now() + 2000;
  while (spy.mock.calls.length < times) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after 2000ms waiting for ${label} to be called ${times} time(s); ` +
        `it was called ${spy.mock.calls.length} time(s).`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

/**
 * Let the fire-and-forget chain settle before asserting something did NOT
 * happen. Polling cannot prove a negative, so this is necessarily a fixed
 * budget — kept deliberately generous, since a too-short settle here produces a
 * FALSE PASS (the page hadn't been attempted yet) rather than a visible failure.
 */
const settle = async () => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 2));
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
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(logInterventionActionMock).toHaveBeenCalledWith('sess-1', 'crisis_sms_alert', { riskScore: 90 });
  });

  it('suppresses the page only on an affirmative sandbox=true (suppression logged out-of-band)', async () => {
    isSandboxAccountSessionMock.mockResolvedValue(true);
    await executeGraduatedResponse('sbx-1', 'high', 90);
    await settle();
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    expect(logInterventionActionMock).toHaveBeenCalledWith('sbx-1', 'external_api_called',
      expect.objectContaining({ suppressed: 'crisis_sms_alert', reason: 'sandbox' }));
  });

  it('FAILS TOWARD PAGING: a throwing sandbox lookup still sends the real page', async () => {
    isSandboxAccountSessionMock.mockRejectedValue(new Error('db blip'));
    await executeGraduatedResponse('sess-1', 'high', 90);
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('a throwing suppression log cannot resurrect or break anything (sandbox path)', async () => {
    isSandboxAccountSessionMock.mockResolvedValue(true);
    logInterventionActionMock.mockRejectedValue(new Error('log down'));
    await expect(executeGraduatedResponse('sbx-1', 'high', 90)).resolves.toBeUndefined();
    await settle();
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
  });

  it('non-high severity never pages', async () => {
    await executeGraduatedResponse('sess-1', 'medium', 55);
    await settle();
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
  });
});


// Crisis steering is delivered over the sideband. When no sideband is attached
// the guidance cannot reach the model — that used to be a bare `return`, so an
// audit of "did we intervene?" counted a steer that never happened. These pin
// the visibility fix (ai-therapist-195).
describe('maybeSteerSession — undeliverable steering must be recorded, not silent', () => {
  const SESSION = 'sess_no_sideband_1';

  it('records an UNDELIVERED risk_steering action when no sideband is attached', async () => {
    sidebandManagerMock.getActiveConnections.mockReturnValue([]);
    await maybeSteerSession(SESSION, 80, 'high');

    expect(sidebandManagerMock.injectMessage).not.toHaveBeenCalled();
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      SESSION, 'risk_steering',
      expect.objectContaining({ delivered: false, reason: 'no_sideband', riskScore: 80 }),
    );
  });

  it('records the suppression only ONCE per session, not once per risky turn', async () => {
    sidebandManagerMock.getActiveConnections.mockReturnValue([]);
    const s = 'sess_no_sideband_dedupe';
    await maybeSteerSession(s, 70, 'medium');
    await maybeSteerSession(s, 85, 'high');
    await maybeSteerSession(s, 90, 'high');

    const calls = logInterventionActionMock.mock.calls.filter(c => c[0] === s);
    expect(calls).toHaveLength(1);
  });

  it('marks delivered:true when the sideband IS attached', async () => {
    const s = 'sess_with_sideband';
    sidebandManagerMock.getActiveConnections.mockReturnValue([s]);
    sidebandManagerMock.injectMessage.mockResolvedValue(undefined);
    await maybeSteerSession(s, 80, 'high');

    expect(sidebandManagerMock.injectMessage).toHaveBeenCalled();
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      s, 'risk_steering', expect.objectContaining({ delivered: true }),
    );
  });

  it('stays silent below the steering threshold regardless of sideband state', async () => {
    sidebandManagerMock.getActiveConnections.mockReturnValue([]);
    await maybeSteerSession('sess_low_risk', 5, 'none');
    expect(logInterventionActionMock).not.toHaveBeenCalled();
  });
});
