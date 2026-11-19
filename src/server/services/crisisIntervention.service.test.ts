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
  liftLimitForCrisisMock,
} = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  logInterventionActionMock: vi.fn(),
  sendCrisisAlertMock: vi.fn(),
  isSandboxAccountSessionMock: vi.fn(),
  liftLimitForCrisisMock: vi.fn(
    (): { lifted: boolean; previousLimitMinutes: number | null; ceilingMinutes: number } => ({
      lifted: false,
      previousLimitMinutes: null,
      ceilingMinutes: 60,
    }),
  ),
  sidebandManagerMock: {
    // maybeSteerSession gates on isConnected(), not getActiveConnections():
    // map membership reports true while the socket is still CONNECTING or
    // already CLOSING, and injectMessage throws unless it is OPEN. Both are
    // mocked so a test that sets one and not the other fails loudly rather
    // than silently exercising the wrong gate.
    getActiveConnections: vi.fn(() => [] as string[]),
    isConnected: vi.fn(() => false),
    injectMessage: vi.fn(),
    tryInject: vi.fn(),
  },
}));

vi.mock('../config/db.js', () => ({ pool: { query: poolQueryMock } }));
vi.mock('./crisisDetection.service.js', () => ({ logInterventionAction: logInterventionActionMock }));
vi.mock('./crisisAlert.service.js', async () =>
  (await import('../testing/alertMock.js')).alertModuleMock(sendCrisisAlertMock),
);
vi.mock('./sidebandManager.service.js', () => ({ sidebandManager: sidebandManagerMock }));
vi.mock('../utils/sessionAutoTerminate.js', () => ({ liftLimitForCrisis: liftLimitForCrisisMock }));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: vi.fn(async () => ({})),
  resolveVendorCeilingMinutes: vi.fn(async () => 60),
}));
vi.mock('../db/index.js', () => ({
  isSandboxAccountSession: isSandboxAccountSessionMock,
  // Transitive imports of utils/adminBroadcast.js:
  getSessionAccessInfo: vi.fn(),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));

const { executeGraduatedResponse, maybeSteerSession } = await import('./crisisIntervention.service.js');
const { _resetPagingStateForTests } = await import('./crisisPaging.service.js');

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
/** Paging-decision rows crisisPaging.service wrote through the mocked pool:
 *  [session_id, action_type, action_details (parsed), risk_score]. */
const pagingRows = () =>
  poolQueryMock.mock.calls
    .filter((c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO intervention_actions'))
    .map((c) => {
      const [sessionId, actionType, details, riskScore] = c[1] as [string, string, string, number | null];
      return { sessionId, actionType, details: JSON.parse(details) as Record<string, unknown>, riskScore };
    });

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
  _resetPagingStateForTests();
});

describe('executeGraduatedResponse — session timer (ai-therapist-281)', () => {
  it('lifts the duration limit to the vendor ceiling and logs it when something was lifted', async () => {
    liftLimitForCrisisMock.mockReturnValueOnce({ lifted: true, previousLimitMinutes: 15, ceilingMinutes: 60 });
    await executeGraduatedResponse('sess-t', 'high', 95);
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert'); // let the fire-and-forget page land here, not in the next test
    expect(liftLimitForCrisisMock).toHaveBeenCalledWith('sess-t', 60);
    expect(logInterventionActionMock).toHaveBeenCalledWith('sess-t', 'crisis_timer_extended', {
      riskScore: 95,
      previousLimitMinutes: 15,
      ceilingMinutes: 60,
    });
  });

  it('logs nothing when there was no limit to lift', async () => {
    await executeGraduatedResponse('sess-u', 'high', 95);
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');
    expect(liftLimitForCrisisMock).toHaveBeenCalledWith('sess-u', 60);
    expect(logInterventionActionMock).not.toHaveBeenCalledWith('sess-u', 'crisis_timer_extended', expect.anything());
  });
});

describe('executeGraduatedResponse — crisis resources go first (ai-therapist-293)', () => {
  it('sends the participant the resource card before the first intervention log, the page and the steer', async () => {
    const order: string[] = [];
    const emit = vi.fn((event: string) => {
      order.push(`emit:${event}`);
    });
    (global as unknown as { io: unknown }).io = {
      to: vi.fn((room: string) => ({ emit: room.startsWith('session:') ? emit : vi.fn() })),
    };
    logInterventionActionMock.mockImplementation(async (_id: string, action: string) => {
      order.push(`log:${action}`);
    });
    sendCrisisAlertMock.mockImplementation(async () => {
      order.push('page');
    });
    const { clearCrisisResourceState } = await import('./crisisResources.js');
    clearCrisisResourceState();

    await executeGraduatedResponse('sess-card', 'high', 92);
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');

    expect(order[0]).toBe('emit:session:crisis-emergency');
    expect(order).toContain('log:high_risk_emergency');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('session:crisis-emergency', {
      sessionId: 'sess-card',
      severity: 'high',
      riskScore: 92,
      reason: 'high_risk',
    });
  });

  it('the card and the page still go out when the first intervention log throws', async () => {
    const emit = vi.fn();
    (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit })) };
    logInterventionActionMock.mockRejectedValue(new Error('db down'));
    const { clearCrisisResourceState } = await import('./crisisResources.js');
    clearCrisisResourceState();

    await expect(executeGraduatedResponse('sess-card-2', 'high', 92)).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledWith('session:crisis-emergency', expect.objectContaining({ severity: 'high' }));
    // The page is requested before that log (ai-therapist-366); it used to be
    // lost with it.
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');
  });
});

describe('executeGraduatedResponse — high-risk paging', () => {
  it('pages the on-call for a real session and logs crisis_sms_alert', async () => {
    await executeGraduatedResponse('sess-1', 'high', 90);
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    // The page text says WHY: a risk score, as opposed to a vendor cut.
    expect(String(sendCrisisAlertMock.mock.calls[0][0])).toMatch(/RISK SCORE 90\/100/);
    await settle();
    expect(pagingRows()).toEqual([
      expect.objectContaining({
        sessionId: 'sess-1',
        actionType: 'crisis_sms_alert',
        riskScore: 90,
        details: expect.objectContaining({ riskScore: 90, paging: expect.objectContaining({ kind: 'risk' }) }),
      }),
    ]);
    expect(String(sendCrisisAlertMock.mock.calls[0][0])).toMatch(/from what the participant said/);
  });

  // PR #64 review: the model's escalate tool flags at a fixed score; nothing
  // the participant said was scored, and the page must not say so.
  it("a flag raised by the model's escalate tool is paged without claiming the participant's words were scored", async () => {
    await executeGraduatedResponse('sess-esc', 'high', 80, 'model_escalation');
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');
    const text = String(sendCrisisAlertMock.mock.calls[0][0]);
    expect(text).toMatch(/RISK SCORE 80\/100 set by the ASSISTANT asking for a human \(escalate tool\)/);
    expect(text).not.toMatch(/from what the participant said/);
    await settle();
    expect(pagingRows()[0]).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          paging: expect.objectContaining({ kind: 'risk', source: 'model_escalation' }),
        }),
      }),
    );
  });

  it('suppresses the page only on an affirmative sandbox=true (suppression logged out-of-band)', async () => {
    isSandboxAccountSessionMock.mockResolvedValue(true);
    await executeGraduatedResponse('sbx-1', 'high', 90);
    await settle();
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    expect(pagingRows()).toEqual([
      expect.objectContaining({
        sessionId: 'sbx-1',
        actionType: 'external_api_called',
        details: expect.objectContaining({ suppressed: 'crisis_sms_alert', reason: 'sandbox' }),
      }),
    ]);
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
    poolQueryMock.mockRejectedValue(new Error('log down'));
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

// ai-therapist-366: the pool now rejects (acquire timeout, statement timeout)
// where it used to wait forever. A high flag must still show resources and
// page, and the page must not queue behind the first database write.
describe('executeGraduatedResponse — database timeouts fail toward paging (ai-therapist-366)', () => {
  const acquireTimeout = () => new Error('timeout exceeded when trying to connect');
  const statementTimeout = () =>
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

  it('requests the page before the first intervention log, so a stalled write cannot hold it back', async () => {
    // A write that has not answered (up to the statement timeout in prod).
    logInterventionActionMock.mockImplementation(() => new Promise(() => undefined));
    void executeGraduatedResponse('sess-stall', 'high', 90);
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('every pool query rejects with the acquire timeout: resources shown and the on-call paged', async () => {
    const emit = vi.fn();
    (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit })) };
    poolQueryMock.mockRejectedValue(acquireTimeout());
    isSandboxAccountSessionMock.mockRejectedValue(acquireTimeout());
    const { clearCrisisResourceState } = await import('./crisisResources.js');
    clearCrisisResourceState();

    await expect(executeGraduatedResponse('sess-acq', 'high', 91)).resolves.toBeUndefined();
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');
    expect(emit).toHaveBeenCalledWith('session:crisis-emergency', expect.objectContaining({ severity: 'high' }));
  });

  it('every pool query rejects with a statement timeout: the on-call is still paged', async () => {
    poolQueryMock.mockRejectedValue(statementTimeout());
    isSandboxAccountSessionMock.mockRejectedValue(statementTimeout());
    await expect(executeGraduatedResponse('sess-stmt', 'high', 88)).resolves.toBeUndefined();
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');
    expect(String(sendCrisisAlertMock.mock.calls[0][0])).toMatch(/RISK SCORE 88\/100/);
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
    sidebandManagerMock.isConnected.mockReturnValue(false);
    await maybeSteerSession(SESSION, 80, 'high');

    expect(sidebandManagerMock.injectMessage).not.toHaveBeenCalled();
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      SESSION,
      'risk_steering',
      expect.objectContaining({ delivered: false, reason: 'no_sideband', riskScore: 80 }),
    );
  });

  it('records the suppression only ONCE per session, not once per risky turn', async () => {
    sidebandManagerMock.getActiveConnections.mockReturnValue([]);
    sidebandManagerMock.isConnected.mockReturnValue(false);
    const s = 'sess_no_sideband_dedupe';
    await maybeSteerSession(s, 70, 'medium');
    await maybeSteerSession(s, 85, 'high');
    await maybeSteerSession(s, 90, 'high');

    const calls = logInterventionActionMock.mock.calls.filter((c) => c[0] === s);
    expect(calls).toHaveLength(1);
  });

  it('marks delivered:true when the sideband IS attached', async () => {
    const s = 'sess_with_sideband';
    sidebandManagerMock.getActiveConnections.mockReturnValue([s]);
    sidebandManagerMock.isConnected.mockReturnValue(true);
    sidebandManagerMock.injectMessage.mockResolvedValue(undefined);
    await maybeSteerSession(s, 80, 'high');

    expect(sidebandManagerMock.injectMessage).toHaveBeenCalled();
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      s,
      'risk_steering',
      expect.objectContaining({ delivered: true }),
    );
  });

  it('stays silent below the steering threshold regardless of sideband state', async () => {
    sidebandManagerMock.getActiveConnections.mockReturnValue([]);
    sidebandManagerMock.isConnected.mockReturnValue(false);
    await maybeSteerSession('sess_low_risk', 5, 'none');
    expect(logInterventionActionMock).not.toHaveBeenCalled();
  });
});
