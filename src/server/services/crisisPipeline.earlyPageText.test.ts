// ai-therapist-369 item 2, with the real paging layer and the real graduated
// response: the page a turn sends the moment it scores is, word for word, the
// page the graduated response would have sent after the turn's reads; it is
// sent once; it is recorded even when the rest of the turn's writes fail; and
// a later request for the same incident folds into it, even when the paging
// layer could not tell whose session it was the first time.
//
// The pool, the scorer's verdict, the pager and the voice sideband are fakes.
// Nothing here can page anyone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({
  verdict: { value: {} as Record<string, unknown> },
  pager: vi.fn(async (_message: string) => true),
  query: vi.fn(),
  connect: vi.fn(),
  analyzeMessageRisk: vi.fn(),
}));

vi.mock('../config/db.js', () => ({ pool: { query: m.query, connect: m.connect } }));
vi.mock('./crisisDetection.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crisisDetection.service.js')>()),
  analyzeMessageRisk: m.analyzeMessageRisk,
}));
vi.mock('./crisisAlert.service.js', async () =>
  (await import('../testing/alertMock.js')).alertModuleMock((message: string) => m.pager(message)),
);
vi.mock('./sidebandManager.service.js', () => ({
  sidebandManager: {
    getActiveConnections: () => [] as string[],
    isConnected: () => false,
    injectMessage: vi.fn(async () => undefined),
    tryInject: vi.fn(async () => false),
  },
}));
vi.mock('../utils/sessionAutoTerminate.js', () => ({
  liftLimitForCrisis: vi.fn(() => ({ lifted: false, previousLimitMinutes: null, ceilingMinutes: 60 })),
  getSessionTimeStatus: vi.fn(() => null),
}));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: vi.fn(async () => null) }));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: vi.fn(async () => null) }));

const { runCrisisPipeline, _resetEarlyPageStateForTests } = await import('./crisisPipeline.service.js');
const { executeGraduatedResponse } = await import('./crisisIntervention.service.js');
const paging = await import('./crisisPaging.service.js');
const { clearCrisisResourceState } = await import('./crisisResources.js');
const { _settleBackgroundForTests } = await import('../utils/backgroundWork.js');
const { rememberSessionAccount, _forgetSessionAccountsForTests } = await import('../utils/sessionAccounts.js');

const SESSION = 'live_text_0123456789';
type Subject = 'own' | 'third_party' | 'harm_to_others';
type Level = { name: string; score: number; acute?: 'plan_or_time' | 'attempt' };
const SUBJECTS: Subject[] = ['own', 'third_party', 'harm_to_others'];
const LEVELS: Level[] = [
  { name: 'high', score: 75 },
  { name: 'critical', score: 95 },
  { name: 'stated time or plan', score: 85, acute: 'plan_or_time' },
  { name: 'attempt', score: 80, acute: 'attempt' },
];

const sqlOf = (sql: unknown): string =>
  typeof sql === 'string' ? sql : String((sql as { text?: string })?.text ?? '');
const okClient = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };

/** The INSERTs of 'crisis_sms_alert' rows the pool was asked for. */
const pageRecords = () =>
  m.query.mock.calls.filter(
    ([sql, params]) =>
      sqlOf(sql).includes('INSERT INTO intervention_actions') &&
      Array.isArray(params) &&
      params[1] === 'crisis_sms_alert',
  );

/** Paging decisions folded into an earlier page. */
const foldedRecords = () =>
  m.query.mock.calls.filter(
    ([sql, params]) =>
      sqlOf(sql).includes('INSERT INTO intervention_actions') &&
      Array.isArray(params) &&
      String(params[2]).includes('folded_into_recent_page'),
  );

beforeEach(() => {
  vi.clearAllMocks();
  paging._resetPagingStateForTests();
  _resetEarlyPageStateForTests();
  _forgetSessionAccountsForTests();
  clearCrisisResourceState();
  rememberSessionAccount(SESSION, 'participant');
  (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit: vi.fn() })) };
  m.query.mockResolvedValue({ rows: [], rowCount: 0 });
  m.connect.mockResolvedValue(okClient);
  m.analyzeMessageRisk.mockImplementation(
    async (_msg: unknown, _history: unknown, hooks?: { onScored?: (r: unknown) => void }) => {
      hooks?.onScored?.(m.verdict.value);
      return m.verdict.value;
    },
  );
});
afterEach(async () => {
  await _settleBackgroundForTests();
  paging._resetPagingStateForTests();
});

function verdict(subject: Subject, level: Level): Record<string, unknown> {
  return {
    riskScore: level.score,
    severity: 'high',
    factors: ['f'],
    breakdown: {},
    ...(subject === 'third_party' ? { subject, thirdParty: true } : subject === 'harm_to_others' ? { subject } : {}),
    ...(level.acute ? { acute: level.acute } : {}),
  };
}

describe('the early page is the page the turn would have sent', () => {
  for (const subject of SUBJECTS) {
    for (const level of LEVELS) {
      it(`${subject}, ${level.name}: same words, sent once, recorded`, async () => {
        m.verdict.value = verdict(subject, level);
        await runCrisisPipeline({ sessionId: SESSION, messageId: 1, content: 'x' }, 'realtime');
        await _settleBackgroundForTests();
        expect(m.pager).toHaveBeenCalledTimes(1);
        const early = m.pager.mock.calls[0][0];
        expect(pageRecords()).toHaveLength(1);
        // Requested once: the graduated response did not ask again (which
        // would have folded silently into a 'folded_into_recent_page' row).
        expect(foldedRecords()).toHaveLength(0);

        // The page the graduated response sends for the same flag, from a
        // clean paging state (no earlier page to compare with).
        paging._resetPagingStateForTests();
        m.pager.mockClear();
        await executeGraduatedResponse(SESSION, 'high', level.score, {
          ...(subject === 'third_party' ? { thirdParty: true } : subject === 'own' ? {} : { subject }),
          ...(level.acute ? { escalation: level.acute } : {}),
        });
        await _settleBackgroundForTests();
        expect(m.pager).toHaveBeenCalledTimes(1);
        expect(early).toBe(m.pager.mock.calls[0][0]);
      });
    }
  }
});

describe('recorded even if later steps fail', () => {
  it('the flag write and every later write fail: the page went out and its record was written', async () => {
    m.connect.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    m.query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      if (sqlOf(sql).includes('INSERT INTO intervention_actions') && params?.[1] === 'crisis_sms_alert') {
        return { rows: [{ action_id: 11 }], rowCount: 1 };
      }
      if (/^\s*(INSERT|UPDATE)/i.test(sqlOf(sql))) throw new Error('timeout exceeded when trying to connect');
      return { rows: [], rowCount: 0 };
    });
    m.verdict.value = verdict('own', LEVELS[1]);
    const r = await runCrisisPipeline({ sessionId: SESSION, messageId: 1, content: 'x' }, 'realtime');
    await _settleBackgroundForTests();
    expect(r.severity).toBe('high');
    expect(m.pager).toHaveBeenCalledTimes(1);
    expect(pageRecords()).toHaveLength(1);
  });
});

describe('a later request for the same incident folds into the early page', () => {
  it('even when the first request could not tell whose session it was (the participant lookup failed)', async () => {
    let lookups = 0;
    m.query.mockImplementation(async (sql: unknown) => {
      if (sqlOf(sql).includes('SELECT user_id FROM therapy_sessions')) {
        lookups++;
        if (lookups === 1) throw new Error('timeout exceeded when trying to connect');
        return { rows: [{ user_id: 5 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const first = await paging.pageHighRisk(SESSION, 85, { source: 'participant_turn' });
    const second = await paging.pageHighRisk(SESSION, 85, { source: 'participant_turn' });
    expect(first.outcome).toBe('paged');
    expect(second.outcome).toBe('folded');
    expect(m.pager).toHaveBeenCalledTimes(1);
  });

  it('a worse request after it still pages (escalation is never folded)', async () => {
    await paging.pageHighRisk(SESSION, 75, { source: 'participant_turn' });
    const worse = await paging.pageHighRisk(SESSION, 80, { source: 'participant_turn', escalation: 'attempt' });
    expect(worse.outcome).toBe('paged');
    expect(m.pager).toHaveBeenCalledTimes(2);
  });

  it('a page sent without the stored history says so plainly', async () => {
    m.query.mockImplementation(async (sql: unknown) => {
      if (sqlOf(sql).includes('SELECT user_id FROM therapy_sessions')) {
        throw new Error('timeout exceeded when trying to connect');
      }
      return { rows: [], rowCount: 0 };
    });
    await paging.pageHighRisk(SESSION, 85, { source: 'participant_turn', subject: 'third_party' });
    const text = m.pager.mock.calls[0][0];
    expect(text).toContain(paging.HISTORY_UNREAD_LINE);
    // The label still comes from the verdict, never from a read.
    expect(text).toContain(paging.PAGE_SUBJECT_LABEL.third_party!);
  });
});
