// The escalation ladder, end to end (ai-therapist-353).
//
// Measured live by the reviewer of PR 65: "yes" to the ideation question
// scores 65 or 75 depending on the run, "tonight" 85, "I already took the
// pills" 95. The pipeline re-flagged only when a score was MORE than 10 above
// the stored one, and the paging service re-paged inside 15 minutes only at
// 90 and up, so a participant could go ideation -> tonight -> overdose in
// progress and staff got ONE text (first score 65: the 85 re-flagged but its
// page folded; 95 is not more than 85 + 10, so no flag and no text).
//
// These tests run the REAL pipeline (crisisPipeline), the REAL high-risk
// response (crisisIntervention) and the REAL paging policy (crisisPaging)
// together. Only the assessor's verdicts, the database and the pager are
// fakes: nothing here can page a person or touch a table.
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface ActionRow {
  action_id: number;
  session_id: string;
  action_type: string;
  action_details: Record<string, unknown>;
  performed_at: Date;
}

const { db, analyzeMock, sendCrisisAlertMock } = vi.hoisted(() => ({
  db: {
    state: { crisis_flagged: false, crisis_severity: null as string | null, crisis_risk_score: null as number | null },
    actions: [] as ActionRow[],
    flags: [] as Array<{ severity: string; riskScore: number; factors: string[]; notes: string }>,
    nextId: 1,
  },
  analyzeMock: vi.fn(),
  sendCrisisAlertMock: vi.fn(),
}));

function addAction(sessionId: string, type: string, details: Record<string, unknown>): number {
  const id = db.nextId++;
  db.actions.push({
    action_id: id,
    session_id: sessionId,
    action_type: type,
    action_details: details,
    performed_at: new Date(),
  });
  return id;
}

vi.mock('../config/db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('./crisisDetection.service.js', () => ({
  analyzeMessageRisk: analyzeMock,
  flagSessionCrisis: vi.fn(
    async (
      _sessionId: string,
      severity: string,
      riskScore: number,
      _by: string,
      _method: string,
      _messageId: unknown,
      factors: string[],
      notes: string,
    ) => {
      db.state = { crisis_flagged: true, crisis_severity: severity, crisis_risk_score: riskScore };
      db.flags.push({ severity, riskScore, factors, notes });
    },
  ),
  logInterventionAction: vi.fn(async (sessionId: string, type: string, details: Record<string, unknown>) => {
    addAction(sessionId, type, details);
  }),
}));
vi.mock('../db/index.js', () => ({
  getRecentSessionMessages: vi.fn(async () => []),
  getSessionCheckin: vi.fn(async () => null),
  getSessionCrisisState: vi.fn(async () => ({ ...db.state })),
  getSessionAccessInfo: vi.fn(async () => ({ status: 'active', user_id: null, session_type: 'chat' })),
  getSessionHighFlagSubjects: vi.fn(async () =>
    db.actions
      .filter((a) => a.action_type === 'auto_flag' && a.action_details['severity'] === 'high')
      .map((a) => (a.action_details['subject'] as string | undefined) ?? null),
  ),
  getSessionFlagEscalations: vi.fn(async () =>
    db.actions
      .filter(
        (a) =>
          a.action_type === 'auto_flag' &&
          a.action_details['severity'] === 'high' &&
          typeof a.action_details['escalation'] === 'string',
      )
      .map((a) => ({
        escalation: a.action_details['escalation'] as string,
        subject: (a.action_details['subject'] as string | undefined) ?? null,
      })),
  ),
  // A session with a real high flag: nothing to record (PR 70).
  recordRecoveryDisclosure: vi.fn(async () => ({ recorded: false, eventId: null, stampedScore: null })),
  incidentHasCrisisAdverseEvent: vi.fn(async () => true),
  isDemoAccountSession: vi.fn(async () => false),
  isSandboxAccountSession: vi.fn(async () => false),
  sessionHasRiskCheck: vi.fn(async () => true),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));
vi.mock('../db/paging.queries.js', () => ({
  getPagingParticipantUserId: vi.fn(async () => null),
  getRecentPagingRecords: vi.fn(async (sessionId: string, _userId: number | null, since: Date) =>
    db.actions
      .filter(
        (r) =>
          r.session_id === sessionId && r.performed_at.getTime() >= since.getTime() && 'paging' in r.action_details,
      )
      .sort((a, b) => b.performed_at.getTime() - a.performed_at.getTime()),
  ),
  getIncidentChainSessionIds: vi.fn(async () => []),
  getParticipantFlagEvents: vi.fn(async () => []),
  getParticipantAssessedRisk: vi.fn(async () => []),
  participantSpokeSince: vi.fn(async () => true),
  getUnfinishedSilenceChecks: vi.fn(async () => []),
  claimSilenceCheck: vi.fn(async () => false),
  releaseSilenceCheck: vi.fn(async () => undefined),
  finishSilenceCheck: vi.fn(async () => undefined),
  INCIDENT_CHAIN_BACKSTOP_MS: 6 * 60 * 60 * 1000,
  insertPagingRecord: vi.fn(async (sessionId: string, type: string, details: Record<string, unknown>) =>
    addAction(sessionId, type, details),
  ),
}));
vi.mock('./crisisAlert.service.js', async () =>
  (await import('../testing/alertMock.js')).alertModuleMock(sendCrisisAlertMock),
);
vi.mock('./suppression.js', () => ({
  sessionSuppressesSafetyPipeline: vi.fn(async () => false),
  sessionSuppressesCrisisPaging: vi.fn(async () => false),
}));
vi.mock('./sidebandManager.service.js', () => ({
  sidebandManager: {
    getActiveConnections: () => [],
    isConnected: () => false,
    injectMessage: vi.fn(),
    tryInject: vi.fn(async () => false),
  },
}));
vi.mock('./crisisResources.js', () => ({
  emitCrisisResources: vi.fn(),
  hasEmittedHighRiskResources: () => true,
  hasEmittedRiskResources: () => true,
  clearCrisisResourceState: vi.fn(),
}));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: vi.fn(async () => null) }));
vi.mock('../utils/adminBroadcast.js', () => ({
  broadcastAdminEvent: vi.fn(async () => undefined),
  broadcastAdminEventForSession: vi.fn(async () => undefined),
}));
vi.mock('../utils/sessionAutoTerminate.js', () => ({
  liftLimitForCrisis: () => ({ lifted: false, previousLimitMinutes: null, ceilingMinutes: 60 }),
}));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: vi.fn(async () => ({})),
  resolveVendorCeilingMinutes: vi.fn(async () => 60),
}));

const { runCrisisPipeline, _resetEarlyPageStateForTests } = await import('./crisisPipeline.service.js');
const paging = await import('./crisisPaging.service.js');

const SESSION = 'chat_ladder_1';
let messageId = 0;

/** One participant turn with the verdict the assessor would give it. */
async function turn(riskScore: number, acute?: 'plan_or_time' | 'attempt', extra: Record<string, unknown> = {}) {
  analyzeMock.mockResolvedValueOnce({
    riskScore,
    severity: riskScore >= 65 ? 'high' : riskScore >= 50 ? 'medium' : 'low',
    factors: ['ideation'],
    breakdown: {},
    contextWake: true,
    ...(acute ? { acute } : {}),
    ...extra,
  });
  const result = await runCrisisPipeline({ sessionId: SESSION, messageId: ++messageId, content: 'x' }, 'chat');
  await settle();
  return result;
}

/** The page is fire-and-forget behind dynamic imports: wait until the paging
 *  decisions in flight have been written. */
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

const texts = (): string[] => sendCrisisAlertMock.mock.calls.map((c) => String(c[0]));
const pagingRows = () =>
  db.actions
    .filter((a) => 'paging' in a.action_details)
    .map((a) => a.action_details['paging'] as Record<string, unknown>);

beforeEach(() => {
  paging._resetPagingStateForTests();
  // Message ids restart at 1 in every test: forget the turns flagged in the
  // last one (ai-therapist-373 remembers each flagged turn for 5 minutes).
  _resetEarlyPageStateForTests();
  db.state = { crisis_flagged: false, crisis_severity: null, crisis_risk_score: null };
  db.actions.length = 0;
  db.flags.length = 0;
  db.nextId = 1;
  messageId = 0;
  analyzeMock.mockReset();
  sendCrisisAlertMock.mockReset().mockResolvedValue(true);
  (global as unknown as { io: unknown }).io = undefined;
});

describe('ideation -> "tonight" -> attempt in progress: three flag events, three texts, each saying what changed', () => {
  it.each([65, 75, 85])('first score %i', async (first) => {
    // "yes" to "are you having thoughts of suicide?"
    await turn(first);
    expect(db.flags).toHaveLength(1);
    expect(texts()).toHaveLength(1);

    // "tonight"
    await turn(85, 'plan_or_time');
    expect(db.flags, 'the stated time must write a flag event whatever the stored score').toHaveLength(2);
    expect(db.flags[1].notes).toContain('What changed: stated intent with a time, a plan or the means at hand');
    expect(texts(), 'and page: REPAGE_ON_STATED_TIME_OR_PLAN defaults to true').toHaveLength(2);
    expect(texts()[1]).toContain('WHAT CHANGED: STATED INTENT WITH A TIME OR PLAN');
    expect(texts()[1]).toContain('Follow-up for the same participant');

    // "I already took the pills"
    await turn(95, 'attempt');
    expect(db.flags, 'an attempt in progress always writes a flag event').toHaveLength(3);
    expect(db.flags[2].notes).toContain('What changed: ATTEMPT IN PROGRESS');
    expect(texts(), 'and always pages').toHaveLength(3);
    expect(texts()[2]).toContain('WHAT CHANGED: ATTEMPT IN PROGRESS');
    expect(texts()[2]).toContain('(ESCALATED)');

    // Each flag is on the audit trail with its stage.
    const flagRows = db.actions.filter((a) => a.action_type === 'auto_flag').map((a) => a.action_details);
    expect(flagRows.map((d) => d['escalation'] ?? null)).toEqual([null, 'plan_or_time', 'attempt']);
  });

  it('an attempt scored below 90 still pages at the top level: the words decide, not the number', async () => {
    await turn(75);
    await turn(85, 'attempt');
    expect(db.flags).toHaveLength(2);
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain('ATTEMPT IN PROGRESS');
    expect(pagingRows().at(-1)).toMatchObject({ level: paging.PAGE_LEVEL.critical, stage: 2, delivered: true });
  });

  it('the assessor omits the observation: a score crossing into 90+ still flags and pages', async () => {
    await turn(75);
    await turn(85);
    // 85 is not more than 75 + 10 and says nothing new: no flag, no text.
    expect(db.flags).toHaveLength(1);
    expect(texts()).toHaveLength(1);

    await turn(95);
    expect(db.flags).toHaveLength(2);
    expect(db.flags[1].notes).toContain('the risk score rose into the critical range');
    expect(texts()).toHaveLength(2);
  });
});

describe('what does NOT page again', () => {
  it('the same stage repeated: "tonight" twice is one flag and one text for it', async () => {
    await turn(75);
    await turn(85, 'plan_or_time');
    await turn(85, 'plan_or_time');
    await turn(80, 'plan_or_time');
    expect(db.flags).toHaveLength(2);
    expect(texts()).toHaveLength(2);
    // The repeats are on record as folded, not invisible.
    expect(pagingRows().filter((p) => p['decision'] === 'folded').length).toBeGreaterThanOrEqual(1);
  });

  it('after an attempt has been paged, a repeat of it or a later "tonight" is folded', async () => {
    await turn(75);
    await turn(95, 'attempt');
    expect(texts()).toHaveLength(2);
    await turn(95, 'attempt');
    await turn(85, 'plan_or_time');
    expect(db.flags).toHaveLength(2);
    expect(texts()).toHaveLength(2);
  });

  it('ordinary high turns after a page stay one text', async () => {
    await turn(75);
    await turn(75);
    await turn(80);
    expect(db.flags).toHaveLength(1);
    expect(texts()).toHaveLength(1);
  });
});

describe('who is at risk stays part of the fold rule', () => {
  it("a third party's attempt (95) does not absorb the participant's own disclosure (75) minutes later", async () => {
    await turn(95, 'attempt', { subject: 'third_party', thirdParty: true });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('THIRD PARTY AT RISK');

    await turn(75);
    expect(db.flags).toHaveLength(2);
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain("PARTICIPANT'S OWN RISK");
    expect(texts()[1]).not.toContain('THIRD PARTY AT RISK:');
  });

  it("the participant's own stated plan after a third-party page is its own escalation, not a repeat", async () => {
    await turn(90, 'plan_or_time', { subject: 'third_party', thirdParty: true });
    await turn(85, 'plan_or_time');
    expect(db.flags).toHaveLength(2);
    expect(texts()).toHaveLength(2);
  });

  it('own risk with harm to others in the same message: one page that names both', async () => {
    await turn(85, undefined, { alsoSubject: 'harm_to_others' });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('URGENT: AI-Therapist HIGH crisis flag\n');
    expect(texts()[0]).toContain('ALSO: the same message describes thoughts of harming another person.');
    expect(db.flags[0].notes).toContain('Also in the same message: risk to others');
  });
});

describe('the paging rules behind it (pure)', () => {
  const NOW = 1_800_000_000_000;
  const prior = (level: 1 | 2 | 3, stage: 0 | 1 | 2, subject: 'own' | 'third_party' = 'own') => ({
    at: NOW - 60_000,
    level,
    kinds: ['risk' as const],
    subject,
    stage,
  });

  it('a page is covered only by one at least as far along, about the same person', () => {
    const { pageCovers, PAGE_LEVEL } = paging;
    // ideation page, then "tonight" at the same level: not covered.
    expect(pageCovers(prior(2, 0), { kind: 'risk', level: PAGE_LEVEL.high, escalation: 'plan_or_time' }, NOW)).toBe(
      false,
    );
    // "tonight" page, then "tonight" again: covered.
    expect(pageCovers(prior(2, 1), { kind: 'risk', level: PAGE_LEVEL.high, escalation: 'plan_or_time' }, NOW)).toBe(
      true,
    );
    // a critical page by score alone does not cover an attempt.
    expect(pageCovers(prior(3, 0), { kind: 'risk', level: PAGE_LEVEL.critical, escalation: 'attempt' }, NOW)).toBe(
      false,
    );
    // an attempt page covers a later plain high turn about the same person, not about another.
    expect(pageCovers(prior(3, 2), { kind: 'risk', level: PAGE_LEVEL.high }, NOW)).toBe(true);
    expect(pageCovers(prior(3, 2, 'third_party'), { kind: 'risk', level: PAGE_LEVEL.high, subject: 'own' }, NOW)).toBe(
      false,
    );
  });

  it('an attempt is the top page level whatever its score; the stated-plan switch is on by default', () => {
    expect(paging.riskPageLevel(70, 'attempt')).toBe(paging.PAGE_LEVEL.critical);
    expect(paging.riskPageLevel(85, 'plan_or_time')).toBe(paging.PAGE_LEVEL.high);
    expect(paging.riskPageLevel(90)).toBe(paging.PAGE_LEVEL.critical);
    expect(paging.REPAGE_ON_STATED_TIME_OR_PLAN).toBe(true);
    expect(paging.pageStage('plan_or_time')).toBe(1);
    expect(paging.pageStage('attempt')).toBe(2);
    expect(paging.pageStage(null)).toBe(0);
  });
});

describe('vendor-cut pages say whose risk was high', () => {
  it('a cut during a third-party flag does not say "their risk before the cut was HIGH"', () => {
    const text = paging.buildVendorCutMessage(
      'live_abc',
      { severity: 'high', riskScore: 90, subject: 'third_party', ownSeverity: 'none' },
      { previousPage: null, now: Date.now() },
    );
    expect(text).toContain('during a HIGH crisis flag (third party)');
    expect(text).toContain('about SOMEONE ELSE the participant was reporting on');
    expect(text).toContain("No risk of the participant's own was flagged.");
    expect(text).not.toMatch(/their risk before the cut was HIGH/i);
  });

  it("names the participant's own level when there was one, and risk to others when that was the flag", () => {
    const text = paging.buildVendorCutMessage(
      'live_abc',
      { severity: 'high', riskScore: 85, subject: 'harm_to_others', ownSeverity: 'medium' },
      { previousPage: null, now: Date.now() },
    );
    expect(text).toContain('(risk to others)');
    expect(text).toContain('HARMING ANOTHER PERSON');
    expect(text).toContain("The participant's own assessed risk was MEDIUM.");
  });

  it("the participant's own high risk reads as before, with the possessive made explicit", () => {
    const text = paging.buildVendorCutMessage(
      'live_abc',
      { severity: 'high', riskScore: 80 },
      { previousPage: null, now: Date.now() },
    );
    expect(text).toContain("the participant's own risk before the cut was HIGH (80/100).");
    expect(text).not.toContain('third party');
  });

  it('the silence page after a third-party flag says so too', () => {
    const text = paging.buildVendorCutSilenceMessage(
      'live_abc',
      4 * 60_000,
      { previousPage: null, now: Date.now() },
      { severity: 'high', riskScore: 90, subject: 'third_party', ownSeverity: 'none' },
    );
    expect(text).toContain('at HIGH risk (third party)');
    expect(text).toContain('about SOMEONE ELSE');
    expect(text).not.toMatch(/Their risk is HIGH/);
  });
});

// A carrier SMS is split into parts of at most 300 characters, and carriers do
// not promise their order: part 1 must stand on its own. These run the REAL
// SMS path (composeRiskPage + splitPageForSms, what sendViaAwsSms sends), not
// the plain-text splitter on the bridge text (PR 82 review).
describe('the first SMS part carries who is at risk, what changed and why', () => {
  const previous = (subject: 'own' | 'third_party' | 'harm_to_others') => ({
    actionId: 1,
    sessionId: 'live_previous_session_id',
    at: Date.now() - 120_000,
    level: paging.PAGE_LEVEL.high,
    kinds: ['risk' as const],
    riskScore: 85,
    subject,
    stage: 0 as const,
  });

  it.each([
    ['own', null],
    ['own', 'plan_or_time'],
    ['own', 'attempt'],
    ['third_party', null],
    ['third_party', 'plan_or_time'],
    ['third_party', 'attempt'],
    ['harm_to_others', null],
    ['harm_to_others', 'plan_or_time'],
    ['harm_to_others', 'attempt'],
  ] as const)('%s, escalation %s, as a follow-up at 100', async (subject, escalation) => {
    const { splitPageForSms, gsmLength, SMS_SINGLE_MAX } = await import('../utils/smsText.js');
    const sessionId = 'live_0123456789abcdefghijklmnop';
    const first = splitPageForSms(
      paging.composeRiskPage(
        sessionId,
        100,
        { previousPage: previous(subject), unpagedCut: null, now: Date.now() },
        'participant_turn',
        subject,
        { escalation },
      ),
    )[0];
    expect(gsmLength(first)).toBeLessThanOrEqual(SMS_SINGLE_MAX);
    expect(first).toContain('URGENT: AI-Therapist HIGH crisis flag');
    expect(first).toContain('Why: RISK SCORE 100/100');
    if (subject === 'third_party') expect(first).toContain('THIRD PARTY AT RISK');
    if (subject === 'harm_to_others') expect(first).toContain('RISK TO OTHERS');
    if (escalation === 'plan_or_time') expect(first).toContain('WHAT CHANGED: STATED INTENT WITH A TIME OR PLAN');
    if (escalation === 'attempt') expect(first).toMatch(/WHAT CHANGED: ATTEMPT IN PROGRESS/);
    expect(first).toMatch(
      new RegExp(`admin#session=${sessionId}|Open Crisis Management: session ${sessionId.slice(0, 16)}`),
    );
  });

  it("the participant's own page after a third-party page keeps OWN RISK and the Why line in part 1", async () => {
    const { splitPageForSms } = await import('../utils/smsText.js');
    const first = splitPageForSms(
      paging.composeRiskPage(
        'live_0123456789abcdefghijklmnop',
        75,
        { previousPage: previous('third_party'), unpagedCut: null, now: Date.now() },
        'participant_turn',
        'own',
        { escalation: 'plan_or_time', alsoSubject: 'harm_to_others' },
      ),
    )[0];
    expect(first).toContain("PARTICIPANT'S OWN RISK");
    expect(first).toMatch(/ALSO: .*harming another person/);
    expect(first).toContain('WHAT IT SAYS: STATED INTENT WITH A TIME OR PLAN');
    expect(first).toContain('Why: RISK SCORE 75/100');
  });
});
