// ai-therapist-373 item 4: a chat start that fails after minting its session
// id still screens the check-in, and a risk check-in pages. That session has
// no row, so the paging layer could not find its participant: the page was
// keyed by a session nobody else uses (the participant's retry paged again)
// and its link opened a session that does not exist. The route now records
// the participant it knows (utils/sessionAccounts rememberSessionParticipant).
// Pager and database are fakes; nothing here can page a person.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { db, pager } = vi.hoisted(() => ({
  db: {
    /** session id -> owner, for sessions whose row exists. */
    sessions: new Map<string, number>(),
    failLookups: false,
    lookups: 0,
  },
  pager: vi.fn(async (_message: string) => true),
}));

vi.mock('../db/paging.queries.js', () => ({
  getPagingParticipantUserId: vi.fn(async (sessionId: string) => {
    db.lookups++;
    if (db.failLookups) throw new Error('timeout exceeded when trying to connect');
    return db.sessions.get(sessionId) ?? null;
  }),
  getRecentPagingRecords: vi.fn(async () => {
    if (db.failLookups) throw new Error('timeout exceeded when trying to connect');
    return [];
  }),
  // A session with no row cannot hold a paging record (foreign key).
  insertPagingRecord: vi.fn(async (sessionId: string) => {
    if (!db.sessions.has(sessionId)) throw new Error('violates foreign key constraint');
    return 1;
  }),
  getIncidentChainSessionIds: vi.fn(async () => []),
  getParticipantFlagEvents: vi.fn(async () => []),
  getParticipantAssessedRisk: vi.fn(async () => []),
  participantSpokeSince: vi.fn(async () => false),
  getUnfinishedSilenceChecks: vi.fn(async () => []),
  claimSilenceCheck: vi.fn(async () => false),
  releaseSilenceCheck: vi.fn(async () => undefined),
  finishSilenceCheck: vi.fn(async () => undefined),
  INCIDENT_CHAIN_BACKSTOP_MS: 12 * 60 * 60 * 1000,
}));
vi.mock('./suppression.js', () => ({ sessionSuppressesCrisisPaging: vi.fn(async () => false) }));
vi.mock('./crisisAlert.service.js', async () =>
  (await import('../testing/alertMock.js')).alertModuleMock((m: string) => pager(m)),
);
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn(async () => undefined) }));

const paging = await import('./crisisPaging.service.js');
const { rememberSessionParticipant, _forgetSessionAccountsForTests } = await import('../utils/sessionAccounts.js');
const { splitPageForSms } = await import('../utils/smsText.js');

const BASE = 'https://ai-therapist.nathanblatter.com';

beforeEach(() => {
  paging._resetPagingStateForTests();
  _forgetSessionAccountsForTests();
  db.sessions.clear();
  db.failLookups = false;
  db.lookups = 0;
  pager.mockClear();
  delete process.env.APP_BASE_URL;
});

describe('a page for a session that was never stored', () => {
  it('links to the participant, not to the session', async () => {
    rememberSessionParticipant('chat_phantom', 7, { stored: false });
    await paging.pageHighRisk('chat_phantom', 75, { source: 'participant_turn', turnSource: 'checkin' });
    expect(pager).toHaveBeenCalledTimes(1);
    const text = String(pager.mock.calls[0][0]);
    expect(text).toContain(`${BASE}/admin#participant=7`);
    expect(text).not.toContain('#session=');
    // Everything else on the page is as it was.
    expect(text).toContain('URGENT: AI-Therapist HIGH crisis flag');
    expect(text).toContain('Session chat_phantom...');
  });

  it("the SMS short form of the link names the participant's profile", () => {
    rememberSessionParticipant('chat_phantom_with_a_long_id', 7, { stored: false });
    const message = paging.composeRiskPage(
      'chat_phantom_with_a_long_id',
      95,
      { previousPage: null, unpagedCut: null, now: Date.now(), historyUnread: true },
      'participant_turn',
      'third_party',
      { escalation: 'attempt', alsoSubject: null },
    );
    const parts = splitPageForSms(message);
    // The longest risk page: part 1 carries the participant link (or, with
    // no room for it, its short form), never the session link.
    expect(parts[0]).toMatch(/admin#participant=7|Open the participant's profile: participant 7/);
    expect(parts.join('\n')).toContain(`${BASE}/admin#participant=7`);
    expect(parts.join('\n')).not.toContain('#session=');
    expect(parts[0].length).toBeLessThanOrEqual(306);
  });

  it('every risk page variant: SMS part 1 stays within 306 characters and points at the participant', () => {
    const id = 'chat_1763571234567_abcdefghij';
    rememberSessionParticipant(id, 2147483647, { stored: false });
    const now = Date.now();
    const previous = {
      actionId: 1,
      sessionId: 'chat_earlier',
      at: now - 14 * 60_000,
      level: paging.PAGE_LEVEL.high,
      kinds: ['risk', 'vendor_cut'] as Array<'risk' | 'vendor_cut'>,
      riskScore: 75,
      subject: 'third_party' as const,
    };
    let checked = 0;
    for (const subject of ['own', 'third_party', 'harm_to_others'] as const) {
      for (const escalation of [null, 'plan_or_time', 'attempt'] as const) {
        for (const alsoSubject of [null, 'third_party', 'harm_to_others'] as const) {
          for (const withHistory of [false, true]) {
            for (const withCut of [false, true]) {
              for (const prior of [null, previous]) {
                const parts = splitPageForSms(
                  paging.composeRiskPage(
                    id,
                    100,
                    {
                      previousPage: prior,
                      unpagedCut: withCut ? { sessionId: 'x', at: now - 80_000 } : null,
                      now,
                      historyUnread: withHistory,
                    },
                    'participant_turn',
                    subject,
                    { escalation, alsoSubject },
                  ),
                );
                expect(parts[0].length).toBeLessThanOrEqual(306);
                expect(parts[0]).toMatch(/admin#participant=2147483647|profile: participant 2147483647/);
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(216);
  });

  it("the participant's retry folds into it: one page, not two", async () => {
    rememberSessionParticipant('chat_phantom', 7, { stored: false });
    await paging.pageHighRisk('chat_phantom', 75, { source: 'participant_turn' });
    // The retry starts a real session (its row exists) and screens the same
    // check-in.
    db.sessions.set('chat_retry', 7);
    const decision = await paging.pageHighRisk('chat_retry', 75, { source: 'participant_turn' });
    expect(pager).toHaveBeenCalledTimes(1);
    expect(decision.outcome).toBe('folded');
  });

  it('a retry that also fails before its row folds too (keyed by the participant without a read)', async () => {
    db.failLookups = true;
    rememberSessionParticipant('chat_phantom_1', 7, { stored: false });
    rememberSessionParticipant('chat_phantom_2', 7, { stored: false });
    await paging.pageHighRisk('chat_phantom_1', 75, { source: 'participant_turn' });
    const decision = await paging.pageHighRisk('chat_phantom_2', 75, { source: 'participant_turn' });
    expect(pager).toHaveBeenCalledTimes(1);
    expect(decision.outcome).toBe('folded');
  });

  it('another participant is not folded into it', async () => {
    rememberSessionParticipant('chat_phantom', 7, { stored: false });
    rememberSessionParticipant('chat_other', 8, { stored: false });
    await paging.pageHighRisk('chat_phantom', 75, { source: 'participant_turn' });
    await paging.pageHighRisk('chat_other', 75, { source: 'participant_turn' });
    expect(pager).toHaveBeenCalledTimes(2);
  });

  it('without a recorded participant (anonymous): keyed and linked by the session, as before', async () => {
    await paging.pageHighRisk('chat_anon_1', 75, { source: 'participant_turn' });
    await paging.pageHighRisk('chat_anon_2', 75, { source: 'participant_turn' });
    expect(pager).toHaveBeenCalledTimes(2);
    expect(String(pager.mock.calls[0][0])).toContain(`${BASE}/admin#session=chat_anon_1`);
  });
});

describe('a stored session with a recorded participant', () => {
  it('links to the session, and needs no participant lookup', async () => {
    db.sessions.set('chat_real', 7);
    rememberSessionParticipant('chat_real', 7);
    await paging.pageHighRisk('chat_real', 75, { source: 'participant_turn' });
    expect(String(pager.mock.calls[0][0])).toContain(`${BASE}/admin#session=chat_real`);
    expect(db.lookups).toBe(0);
  });

  it('when the lookups fail, the page is still keyed by the participant', async () => {
    rememberSessionParticipant('chat_a', 7);
    rememberSessionParticipant('chat_b', 7);
    db.failLookups = true;
    await paging.pageHighRisk('chat_a', 75, { source: 'participant_turn' });
    const decision = await paging.pageHighRisk('chat_b', 75, { source: 'participant_turn' });
    expect(decision.outcome).toBe('folded');
  });
});

describe('rememberSessionParticipant', () => {
  it('ignores anything that is not a user id', async () => {
    const { knownSessionParticipant } = await import('../utils/sessionAccounts.js');
    rememberSessionParticipant('s1', null);
    rememberSessionParticipant('s2', undefined);
    rememberSessionParticipant('s3', 1.5);
    rememberSessionParticipant('', 7);
    expect(knownSessionParticipant('s1')).toBeNull();
    expect(knownSessionParticipant('s2')).toBeNull();
    expect(knownSessionParticipant('s3')).toBeNull();
    rememberSessionParticipant('s4', 7);
    expect(knownSessionParticipant('s4')).toEqual({ userId: 7, stored: true });
  });
});
