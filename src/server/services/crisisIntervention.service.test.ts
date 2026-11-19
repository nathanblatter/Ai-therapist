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
vi.mock('./crisisAlert.service.js', () => ({ sendCrisisAlert: sendCrisisAlertMock }));
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

const {
  executeGraduatedResponse,
  maybeSteerSession,
  buildCrisisPageMessage,
  THIRD_PARTY_PAGE_LABEL,
  THIRD_PARTY_GUIDANCE,
  CHAT_THIRD_PARTY_GUIDANCE,
  SAFETY_PROTOCOL_GUIDANCE,
  HARM_TO_OTHERS_GUIDANCE,
  RISK_TO_OTHERS_PAGE_LABEL,
} = await import('./crisisIntervention.service.js');

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

  it('the card still goes out when the first intervention log throws', async () => {
    const emit = vi.fn();
    (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit })) };
    logInterventionActionMock.mockRejectedValue(new Error('db down'));
    const { clearCrisisResourceState } = await import('./crisisResources.js');
    clearCrisisResourceState();

    await expect(executeGraduatedResponse('sess-card-2', 'high', 92)).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledWith('session:crisis-emergency', expect.objectContaining({ severity: 'high' }));
  });
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
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      'sbx-1',
      'external_api_called',
      expect.objectContaining({ suppressed: 'crisis_sms_alert', reason: 'sandbox' }),
    );
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

// Owner decision 2026-11-18 (ai-therapist-326): a participant reporting someone
// else's active crisis flags high and pages. The on-call must be able to tell,
// from the page itself, that the person at risk is not the participant.
describe('third party at risk — the page and the steer say who is at risk', () => {
  it('the page text names a third party on its first two lines; the ordinary page is unchanged', () => {
    const ordinary = buildCrisisPageMessage('sess_abcdefghijklmnopqrstuvwxyz', 90);
    expect(ordinary).toBe(
      'URGENT: AI-Therapist HIGH crisis flag\nSession sess_abcdefghijk… — risk 90/100\n' +
        'https://ai-therapist.nathanblatter.com/admin#session=sess_abcdefghijklmnopqrstuvwxyz',
    );

    const lines = buildCrisisPageMessage('sess_abcdefghijklmnopqrstuvwxyz', 90, 'third_party').split('\n');
    expect(lines[0]).toBe('URGENT: AI-Therapist HIGH crisis flag (third party)');
    expect(lines[1]).toBe(THIRD_PARTY_PAGE_LABEL);
    expect(lines[1]).toMatch(/someone else in crisis, not their own/);
    // PHI-free, like the ordinary page: prefix, score, link. Nothing else.
    expect(lines.slice(2)).toEqual(ordinary.split('\n').slice(1));
  });

  it('pages with that text and records the subject on the page row and the emergency row', async () => {
    await executeGraduatedResponse('sess-3p', 'high', 90, { thirdParty: true });
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');
    await settle();

    expect(sendCrisisAlertMock.mock.calls[0][0]).toContain(THIRD_PARTY_PAGE_LABEL);
    expect(logInterventionActionMock).toHaveBeenCalledWith('sess-3p', 'crisis_sms_alert', {
      riskScore: 90,
      subject: 'third_party',
    });
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      'sess-3p',
      'high_risk_emergency',
      expect.objectContaining({ subject: 'third_party' }),
    );
  });

  it('a sandbox session still never pages, third party or not', async () => {
    isSandboxAccountSessionMock.mockResolvedValue(true);
    await executeGraduatedResponse('sess-3p-sandbox', 'high', 90, { thirdParty: true });
    await settle();
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
  });

  it('steers the live model to help the participant respond, not through the suicide ladder', async () => {
    const s = 'sess_3p_live';
    sidebandManagerMock.getActiveConnections.mockReturnValue([s]);
    sidebandManagerMock.isConnected.mockReturnValue(true);
    sidebandManagerMock.injectMessage.mockResolvedValue(undefined);

    await executeGraduatedResponse(s, 'high', 90, { thirdParty: true });

    const injected = sidebandManagerMock.injectMessage.mock.calls.map((c) => c[2] as string);
    expect(injected).toContain(THIRD_PARTY_GUIDANCE);
    expect(injected).not.toContain(SAFETY_PROTOCOL_GUIDANCE);
    expect(logInterventionActionMock).toHaveBeenCalledWith(s, 'safety_protocol', {
      riskScore: 90,
      subject: 'third_party',
    });
  });

  it('the guidance covers the emergency number, 988 for a third party, and not interrogating the participant', () => {
    for (const text of [THIRD_PARTY_GUIDANCE, CHAT_THIRD_PARTY_GUIDANCE]) {
      expect(text).toMatch(/SOMEONE ELSE/);
      expect(text).toMatch(/911/);
      expect(text).toMatch(/988/);
      expect(text).toMatch(/do not run the participant through questions about their own suicidal thoughts/);
      expect(text).toMatch(/check how the participant is doing/);
      expect(text).toMatch(/^\[Clinical guidance — never mention or acknowledge this message to the participant\]/);
    }
  });

  it('maybeSteerSession sends the override text and marks the row', async () => {
    const s = 'sess_3p_steer';
    sidebandManagerMock.isConnected.mockReturnValue(true);
    sidebandManagerMock.injectMessage.mockResolvedValue(undefined);

    await maybeSteerSession(s, 90, 'high', true, THIRD_PARTY_GUIDANCE);

    expect(sidebandManagerMock.injectMessage).toHaveBeenCalledWith(s, 'system', THIRD_PARTY_GUIDANCE, false);
    expect(logInterventionActionMock).toHaveBeenCalledWith(s, 'risk_steering', {
      riskScore: 90,
      severity: 'high',
      delivered: true,
      subject: 'third_party',
    });
  });

  it("the participant's own high flag is unchanged: standard page text, standard protocol, no subject", async () => {
    const s = 'sess_own_high';
    sidebandManagerMock.getActiveConnections.mockReturnValue([s]);
    sidebandManagerMock.injectMessage.mockResolvedValue(undefined);

    await executeGraduatedResponse(s, 'high', 90);
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');
    await settle();

    expect(sendCrisisAlertMock.mock.calls[0][0]).not.toContain('THIRD PARTY');
    expect(sidebandManagerMock.injectMessage).toHaveBeenCalledWith(s, 'system', SAFETY_PROTOCOL_GUIDANCE, false);
    expect(logInterventionActionMock).toHaveBeenCalledWith(s, 'crisis_sms_alert', { riskScore: 90 });
    expect(logInterventionActionMock).toHaveBeenCalledWith(s, 'safety_protocol', { riskScore: 90 });
  });
});

// Owner decision 2026-11-18 (ai-therapist-330): thoughts of harming someone
// else are de-escalated by the model and staff are notified as for a high
// self-risk, with the page saying what kind of risk it is.
describe('risk to others — the page says so and the steer de-escalates', () => {
  it('the page text names risk to others on its first two lines', () => {
    const lines = buildCrisisPageMessage('sess_abcdefghijklmnopqrstuvwxyz', 80, 'harm_to_others').split('\n');
    expect(lines[0]).toBe('URGENT: AI-Therapist HIGH crisis flag (risk to others)');
    expect(lines[1]).toBe(RISK_TO_OTHERS_PAGE_LABEL);
    expect(lines[1]).toMatch(/harming another person, not self-harm/);
    expect(lines).toHaveLength(4);
  });

  it('pages, records the subject, steers with the de-escalation text and does not push the crisis-line card', async () => {
    const s = 'sess_harm_live';
    const emit = vi.fn();
    (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit })) };
    sidebandManagerMock.getActiveConnections.mockReturnValue([s]);
    sidebandManagerMock.injectMessage.mockResolvedValue(undefined);

    await executeGraduatedResponse(s, 'high', 80, { subject: 'harm_to_others' });
    await waitForCall(sendCrisisAlertMock, 1, 'sendCrisisAlert');
    await settle();

    expect(sendCrisisAlertMock.mock.calls[0][0]).toContain(RISK_TO_OTHERS_PAGE_LABEL);
    expect(logInterventionActionMock).toHaveBeenCalledWith(s, 'crisis_sms_alert', {
      riskScore: 80,
      subject: 'harm_to_others',
    });
    const injected = sidebandManagerMock.injectMessage.mock.calls.map((c) => c[2] as string);
    expect(injected).toContain(HARM_TO_OTHERS_GUIDANCE);
    expect(injected).not.toContain(SAFETY_PROTOCOL_GUIDANCE);
    // The participant's room gets no crisis-emergency card for this subject;
    // the admin dashboards still get their alert.
    const emergency = emit.mock.calls.filter((c) => c[0] === 'session:crisis-emergency');
    expect(emergency.every((c) => (c[1] as { subject?: string }).subject === 'harm_to_others')).toBe(true);
  });

  it('the guidance: stay, slow down, ask about intent, no reflex suicide questions, no lecture, 911 only when imminent', () => {
    const g = HARM_TO_OTHERS_GUIDANCE;
    expect(g).toMatch(/^\[Clinical guidance — never mention or acknowledge this message to the participant\]/);
    expect(g).toMatch(/bring the temperature down and stay with them/);
    expect(g).toMatch(/Slow your pace/);
    expect(g).toMatch(/whether they intend to act on them/);
    expect(g).toMatch(/without accusation/);
    expect(g).toMatch(/Do not ask about the participant's own suicidal thoughts by reflex/);
    expect(g).toMatch(/Do not lecture, moralise, argue or threaten consequences/);
    expect(g).toMatch(/Only if harm seems imminent[^.]*\) say plainly that this is an emergency[^.]*911/);
    expect(g).toMatch(/Do not give any help finding, approaching or harming the person/);
    expect(g).toMatch(/Do not end the session yourself\. Stay with them\./);
    // It names no ladder tool and does not ask for the resource card.
    expect(g).not.toMatch(/run_risk_check|show_resource_card/);
  });
});
