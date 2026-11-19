// The paging policy's SQL against a REAL Postgres (ai-therapist-362 / 363).
// Skipped unless asked for, because the unit tests replace these queries with
// in-memory fakes and so cannot show that the recursive chain walk, the
// row-level claim or the transaction behave as the comments say:
//
//   PAGING_SQL_DATABASE_URL=postgresql://.../rt_scratch_db \
//     npx vitest run src/server/db/paging.queries.live.test.ts
//
// The database must be a THROWAWAY one at the current migration head
// (src/database/scripts/migrateFromScratch.ts). The file refuses any database
// whose name does not start with `rt_` or contain `scratch`, so it cannot be
// pointed at stage by accident. It writes a handful of rows under one
// throwaway user and deletes them afterwards. No pager, no network.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';

const URL_ = process.env.PAGING_SQL_DATABASE_URL ?? '';
const dbName = (() => {
  try {
    return new URL(URL_).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();
const LIVE = URL_ !== '' && (dbName.startsWith('rt_') || dbName.includes('scratch'));

const { holder, sendCrisisAlertMock } = vi.hoisted(() => ({
  holder: { pool: null as unknown },
  sendCrisisAlertMock: vi.fn(async (_message: string) => true),
}));
vi.mock('../config/db.js', () => ({
  get pool() {
    return holder.pool;
  },
}));
// The pager is a mock in every test of this file: nothing here can text anyone.
vi.mock('../services/crisisAlert.service.js', async () =>
  (await import('../testing/alertMock.js')).alertModuleMock(sendCrisisAlertMock),
);

const {
  getIncidentChainSessionIds,
  getParticipantFlagEvents,
  getParticipantAssessedRisk,
  getUnfinishedSilenceChecks,
  claimSilenceCheck,
  releaseSilenceCheck,
  finishSilenceCheck,
  insertPagingRecord,
} = await import('./paging.queries.js');
const { recordRecoveryDisclosure, incidentHasCrisisAdverseEvent } = await import('./crisis.queries.js');

const HOUR = 60 * 60 * 1000;
const tag = `pagesql_${Date.now().toString(36)}`;
let pool: pg.Pool;
let userId = 0;
let otherUserId = 0;
let thirdUserId = 0;

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

async function makeSession(
  suffix: string,
  owner: number | null,
  startedAgoMs: number,
  isDemo = false,
): Promise<string> {
  const id = `${tag}_${suffix}`;
  await q(
    `INSERT INTO therapy_sessions (session_id, user_id, created_at, is_demo)
     VALUES ($1, $2, now() - make_interval(secs => $3::double precision), $4)`,
    [id, owner, startedAgoMs / 1000, isDemo],
  );
  return id;
}

async function flagEvent(
  sessionId: string,
  opts: { type?: string; severity: string; score: number; factors?: string[]; agoMs?: number; method?: string },
): Promise<void> {
  await q(
    `INSERT INTO crisis_events (session_id, event_type, severity, risk_score, triggered_by, trigger_method,
                                risk_factors, created_at)
     VALUES ($1, $2, $3, $4, 'system', $5, $6::jsonb, now() - make_interval(secs => $7::double precision))`,
    [
      sessionId,
      opts.type ?? 'flagged',
      opts.severity,
      opts.score,
      opts.method ?? 'auto',
      JSON.stringify(opts.factors ?? []),
      (opts.agoMs ?? 0) / 1000,
    ],
  );
}

/** What markSessionCrisisContinuation leaves on a recovery session. */
async function stamp(sessionId: string, score: number, agoMs = 0): Promise<void> {
  await q(
    `UPDATE therapy_sessions SET crisis_flagged = TRUE, crisis_severity = 'high', crisis_risk_score = $2
      WHERE session_id = $1`,
    [sessionId, score],
  );
  await flagEvent(sessionId, {
    severity: 'high',
    score,
    factors: ['recovery_continuation'],
    agoMs,
    method: 'system',
  });
}

async function noPageRow(sessionId: string, agoMs: number, check: Record<string, unknown> | null): Promise<number> {
  const id = await insertPagingRecord(
    sessionId,
    'external_api_called',
    {
      suppressed: 'crisis_sms_alert',
      paging: { decision: 'no_page', kind: 'vendor_cut', delivered: false, ...(check ? { silenceCheck: check } : {}) },
    },
    null,
  );
  await q(
    `UPDATE intervention_actions SET performed_at = now() - make_interval(secs => $2::double precision)
      WHERE action_id = $1`,
    [id, agoMs / 1000],
  );
  return id as number;
}

const checkOf = async (actionId: number): Promise<Record<string, unknown>> => {
  const { rows } = await q(
    `SELECT action_details #> '{paging,silenceCheck}' AS c FROM intervention_actions WHERE action_id = $1`,
    [actionId],
  );
  return rows[0].c as Record<string, unknown>;
};

describe.skipIf(!LIVE)('paging SQL against a scratch Postgres', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL_, max: 6 });
    holder.pool = pool;
    const org = await q('SELECT org_id FROM organizations ORDER BY org_id LIMIT 1');
    const orgId = org.rows[0].org_id as number;
    const mk = async (name: string): Promise<number> => {
      const { rows } = await q(
        `INSERT INTO users (username, password, role, organization_id) VALUES ($1, 'x', 'participant', $2)
         RETURNING userid`,
        [`${tag}_${name}`, orgId],
      );
      return rows[0].userid as number;
    };
    userId = await mk('a');
    otherUserId = await mk('b');
    thirdUserId = await mk('c');
  });

  afterAll(async () => {
    if (!pool) return;
    await q(`DELETE FROM adverse_event_reports WHERE session_id LIKE $1`, [`${tag}_%`]);
    await q(`DELETE FROM therapy_sessions WHERE session_id LIKE $1`, [`${tag}_%`]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`${tag}_%`]);
    await pool.end();
  });

  describe('the recovery chain', () => {
    it('follows continuation stamps back to the session the incident started in, past the 2 h lookback', async () => {
      // A real high flag 3 h ago; two recovery sessions since; an unrelated
      // session of the same participant from yesterday.
      const yesterday = await makeSession('chain_old', userId, 26 * HOUR);
      await flagEvent(yesterday, { severity: 'high', score: 91, agoMs: 26 * HOUR });
      const first = await makeSession('chain_1', userId, 3 * HOUR);
      await flagEvent(first, { severity: 'high', score: 82, agoMs: 3 * HOUR - 60_000 });
      const second = await makeSession('chain_2', userId, 2.5 * HOUR);
      await stamp(second, 82, 2.5 * HOUR);
      const third = await makeSession('chain_3', userId, 20 * 60_000);
      await stamp(third, 82, 20 * 60_000);
      // Another participant's session in between must never be picked up.
      const stranger = await makeSession('chain_x', otherUserId, 2.7 * HOUR);
      await flagEvent(stranger, { severity: 'high', score: 99, agoMs: 2.7 * HOUR });

      const chain = await getIncidentChainSessionIds(third, new Date(Date.now() - 12 * HOUR));
      expect(chain).toEqual([third, second, first]);

      // The chain stops at the first session that is not a recovery session:
      // yesterday's is not part of this incident.
      expect(chain).not.toContain(yesterday);
      expect(chain).not.toContain(stranger);

      // The 2 h lookback alone would have missed the flag (3 h old); the chain finds it.
      const twoHours = new Date(Date.now() - 2 * HOUR);
      const byClock = await getParticipantFlagEvents([third], userId, twoHours);
      expect(byClock.filter((e) => e.severity === 'high')).toHaveLength(0);
      const byChain = await getParticipantFlagEvents(chain, userId, twoHours);
      expect(byChain.map((e) => [e.session_id, e.severity, e.risk_score])).toEqual([[first, 'high', 82]]);
    });

    it('a second session opened between the cut and its recovery does not break the chain (two devices)', async () => {
      // Owner with nothing else on record, so start order is fully controlled.
      const { rows } = await q(
        `INSERT INTO users (username, password, role, organization_id)
         SELECT $1, 'x', 'participant', organization_id FROM users WHERE userid = $2 RETURNING userid`,
        [`${tag}_twodev`, userId],
      );
      const u = rows[0].userid as number;
      // Voice session flagged high 2 h 30 min ago, then cut by the vendor.
      const voice = await makeSession('twodev_voice', u, 3 * HOUR);
      await flagEvent(voice, { severity: 'high', score: 85, agoMs: 2.5 * HOUR });
      // A typed chat opened on another device while the voice session ran.
      const chat = await makeSession('twodev_chat', u, 2.8 * HOUR);
      // The recovery session, started the moment the voice session was cut.
      const recovery = await makeSession('twodev_rec', u, 2.7 * HOUR);
      await stamp(recovery, 85, 2.7 * HOUR);
      const cutRow = await insertPagingRecord(
        voice,
        'crisis_sms_alert',
        { paging: { decision: 'paged', kind: 'vendor_cut', delivered: true } },
        85,
      );
      await q(
        `UPDATE intervention_actions SET performed_at = now() - make_interval(secs => $2::double precision)
          WHERE action_id = $1`,
        [cutRow, (2.7 * HOUR) / 1000 + 2],
      );

      const chain = await getIncidentChainSessionIds(recovery, new Date(Date.now() - 12 * HOUR));
      expect(chain).toEqual([recovery, voice]);
      expect(chain).not.toContain(chat);
      const flags = await getParticipantFlagEvents(chain, u, new Date(Date.now() - 2 * HOUR));
      expect(flags.map((e) => [e.session_id, e.severity])).toEqual([[voice, 'high']]);

      // Without the cut row it falls back to start order (the chat session).
      await q(`DELETE FROM intervention_actions WHERE action_id = $1`, [cutRow]);
      expect(await getIncidentChainSessionIds(recovery, new Date(Date.now() - 12 * HOUR))).toEqual([recovery, chat]);
    });

    it('a session that is not a recovery session is a chain of one; a missing row still returns its own id', async () => {
      const plain = await makeSession('plain', userId, 5 * 60_000);
      expect(await getIncidentChainSessionIds(plain, new Date(Date.now() - 12 * HOUR))).toEqual([plain]);
      expect(await getIncidentChainSessionIds(`${tag}_missing`, new Date(Date.now() - 12 * HOUR))).toEqual([
        `${tag}_missing`,
      ]);
    });

    it('the time backstop stops the walk', async () => {
      const u = thirdUserId;
      const a = await makeSession('bs_1', u, 30 * HOUR);
      await flagEvent(a, { severity: 'high', score: 80, agoMs: 30 * HOUR });
      const b = await makeSession('bs_2', u, 29 * HOUR);
      await stamp(b, 80, 29 * HOUR);
      const c = await makeSession('bs_3', u, 60_000);
      await stamp(c, 80, 60_000);
      // c is inside the backstop, so its predecessor b is included; b started
      // before the backstop, so the walk does not go on to a.
      expect(await getIncidentChainSessionIds(c, new Date(Date.now() - 12 * HOUR))).toEqual([c, b]);
    });

    it('a researcher raising the risk by hand counts toward the peak; the stamp never does', async () => {
      const s = await makeSession('manual', null, 10 * 60_000);
      await flagEvent(s, { type: 'risk_score_updated', severity: 'high', score: 85, method: 'manual' });
      await flagEvent(s, { type: 'severity_changed', severity: 'medium', score: 55, method: 'manual' });
      await flagEvent(s, { type: 'unflagged', severity: 'high', score: 85, method: 'manual' });
      await flagEvent(s, { severity: 'high', score: 100, factors: ['recovery_continuation'], method: 'system' });
      const events = await getParticipantFlagEvents([s], null, new Date(Date.now() - 2 * HOUR));
      expect(events.map((e) => [e.severity, e.risk_score]).sort()).toEqual([
        ['high', 85],
        ['medium', 55],
      ]);
    });

    it('assessed scores are read across the chain', async () => {
      const a = await makeSession('assess_1', userId, 5 * HOUR);
      const b = await makeSession('assess_2', userId, 4.9 * HOUR);
      await stamp(b, 100, 4.9 * HOUR);
      await q(
        `INSERT INTO risk_score_history (session_id, risk_score, severity, score_factors, calculated_at)
         VALUES ($1, 78, 'high', '[]'::jsonb, now() - interval '5 hours')`,
        [a],
      );
      const chain = await getIncidentChainSessionIds(b, new Date(Date.now() - 12 * HOUR));
      const assessed = await getParticipantAssessedRisk(chain, userId, new Date(Date.now() - 60_000));
      expect(assessed).toEqual([{ session_id: b, severity: 'high', risk_score: 78 }]);
    });
  });

  // ai-therapist-356 follow-up: the text hand-off's own link rows are the
  // source of truth for the chain; the stamp-and-start-order walk is the
  // fallback for a session without one. The hand-off words its first message
  // from this chain only, so it must not reach an unrelated earlier session.
  describe('the incident chain follows the hand-off link rows', () => {
    const link = async (sessionId: string, event: string, details: Record<string, unknown>) => {
      await q(
        `INSERT INTO intervention_actions (session_id, action_type, action_details)
         VALUES ($1, 'external_api_called', $2::jsonb)`,
        [sessionId, JSON.stringify({ event, ...details })],
      );
    };
    const handoff = (chat: string, voice: string) =>
      Promise.all([
        link(chat, 'voice_cut_text_handoff', { role: 'continuation', from: voice }),
        link(voice, 'voice_cut_text_handoff', { role: 'cut_session', to: chat }),
      ]);
    const backstop = () => new Date(Date.now() - 12 * HOUR);

    it('an ordinary call cut 90 minutes after a high flag elsewhere is a chain of its own', async () => {
      const u = await (async () => {
        const { rows } = await q(
          `INSERT INTO users (username, password, role, organization_id)
           SELECT $1, 'x', 'participant', organization_id FROM users WHERE userid = $2 RETURNING userid`,
          [`${tag}_twohour`, userId],
        );
        return rows[0].userid as number;
      })();
      const earlier = await makeSession('th_earlier', u, 100 * 60_000);
      await flagEvent(earlier, { severity: 'high', score: 82, agoMs: 95 * 60_000 });
      const voice = await makeSession('th_voice', u, 8 * 60_000);
      expect(await getIncidentChainSessionIds(voice, backstop())).toEqual([voice]);
      // Its hand-off chat, stamped high from the earlier flag (look-back), and
      // linked explicitly: the chain is the chat and the cut call, nothing older.
      const chat = await makeSession('th_chat', u, 0);
      await stamp(chat, 82);
      await handoff(chat, voice);
      const chain = await getIncidentChainSessionIds(chat, backstop());
      expect(chain).toEqual([chat, voice]);
      expect(chain).not.toContain(earlier);
      // The chain's own risk reads (userId null: no look-back) see nothing high.
      const flags = await getParticipantFlagEvents(chain, null, new Date());
      expect(flags.filter((e) => e.severity === 'high')).toHaveLength(0);
    });

    it('voice -> chat -> voice again (unstamped) -> cut: the whole chain, through both kinds of link', async () => {
      const v1 = await makeSession('vr_v1', userId, 40 * 60_000);
      await flagEvent(v1, { severity: 'medium', score: 55, agoMs: 39 * 60_000 });
      const c1 = await makeSession('vr_c1', userId, 38 * 60_000);
      await stamp(c1, 55, 38 * 60_000);
      await handoff(c1, v1);
      const v2 = await makeSession('vr_v2', userId, 20 * 60_000);
      await link(v2, 'voice_resumed_from_text', { from: c1 });
      expect(await getIncidentChainSessionIds(v2, backstop())).toEqual([v2, c1, v1]);
    });

    it('the link row wins over start order and over a vendor-cut row on another session', async () => {
      const { rows } = await q(
        `INSERT INTO users (username, password, role, organization_id)
         SELECT $1, 'x', 'participant', organization_id FROM users WHERE userid = $2 RETURNING userid`,
        [`${tag}_linkwins`, userId],
      );
      const u = rows[0].userid as number;
      const voice = await makeSession('lw_voice', u, 30 * 60_000);
      const other = await makeSession('lw_other', u, 10 * 60_000);
      const otherCut = await insertPagingRecord(
        other,
        'external_api_called',
        { paging: { decision: 'no_page', kind: 'vendor_cut', delivered: false } },
        null,
      );
      expect(otherCut).toBeGreaterThan(0);
      const chat = await makeSession('lw_chat', u, 0);
      await stamp(chat, 80);
      await handoff(chat, voice);
      expect(await getIncidentChainSessionIds(chat, backstop())).toEqual([chat, voice]);
    });

    it('an anonymous participant: the link rows alone make the chain', async () => {
      const voice = await makeSession('anon_voice', null, 15 * 60_000);
      const chat = await makeSession('anon_chat', null, 0);
      await handoff(chat, voice);
      expect(await getIncidentChainSessionIds(chat, backstop())).toEqual([chat, voice]);
    });

    it("never follows a link to another participant's session", async () => {
      const theirs = await makeSession('xl_theirs', otherUserId, 15 * 60_000);
      const chat = await makeSession('xl_chat', thirdUserId, 0);
      await link(chat, 'voice_cut_text_handoff', { role: 'continuation', from: theirs });
      expect(await getIncidentChainSessionIds(chat, backstop())).toEqual([chat]);
    });
  });

  describe('recordRecoveryDisclosure', () => {
    it('writes one real high flag for a stamp-only session, and corrects the session row', async () => {
      const s = await makeSession('disc_1', userId, 60_000);
      await stamp(s, 100);
      const msg = await q(
        `INSERT INTO messages (session_id, role, message_type, content) VALUES ($1, 'user', 'text', 'x')
         RETURNING message_id`,
        [s],
      );
      const messageId = msg.rows[0].message_id as string;

      const result = await recordRecoveryDisclosure({
        sessionId: s,
        riskScore: 78,
        messageId,
        factors: ['explicit_intent', 'recovery_continuation'],
      });
      expect(result).toMatchObject({ recorded: true, stampedScore: 100 });

      const { rows } = await q(
        `SELECT severity, risk_score, previous_risk_score, trigger_method, message_id, risk_factors, notes
           FROM crisis_events WHERE event_id = $1`,
        [result.eventId],
      );
      expect(rows[0]).toMatchObject({
        severity: 'high',
        risk_score: 78,
        previous_risk_score: 100,
        trigger_method: 'auto',
        risk_factors: ['explicit_intent'],
      });
      expect(String(rows[0].message_id)).toBe(String(messageId));
      expect(rows[0].notes).toContain('Participant disclosure in a recovery session');

      const session = await q(
        `SELECT crisis_flagged, crisis_severity, crisis_risk_score FROM therapy_sessions WHERE session_id = $1`,
        [s],
      );
      expect(session.rows[0]).toEqual({ crisis_flagged: true, crisis_severity: 'high', crisis_risk_score: 78 });

      // Once per session: the next high turn finds a real high flag.
      expect((await recordRecoveryDisclosure({ sessionId: s, riskScore: 80, messageId, factors: [] })).recorded).toBe(
        false,
      );
    });

    it('two high turns at the same moment record exactly one event', async () => {
      const s = await makeSession('disc_race', userId, 60_000);
      await stamp(s, 88);
      const results = await Promise.all(
        [76, 77, 79, 81].map((riskScore) =>
          recordRecoveryDisclosure({ sessionId: s, riskScore, messageId: null, factors: ['explicit_intent'] }),
        ),
      );
      expect(results.filter((r) => r.recorded)).toHaveLength(1);
      const { rows } = await q(
        `SELECT COUNT(*)::int AS n FROM crisis_events
          WHERE session_id = $1 AND event_type = 'flagged'
            AND NOT COALESCE(risk_factors @> '["recovery_continuation"]'::jsonb, FALSE)`,
        [s],
      );
      expect(rows[0].n).toBe(1);
    });

    it('leaves alone: a session with a real high flag, an unstamped session, a missing session', async () => {
      const real = await makeSession('disc_real', userId, 60_000);
      await stamp(real, 80);
      await flagEvent(real, { severity: 'high', score: 80, factors: ['model_escalation'] });
      const plain = await makeSession('disc_plain', userId, 60_000);
      await flagEvent(plain, { severity: 'high', score: 80 });
      for (const sessionId of [real, plain, `${tag}_nope`]) {
        expect(
          (await recordRecoveryDisclosure({ sessionId, riskScore: 90, messageId: null, factors: [] })).recorded,
        ).toBe(false);
      }
    });

    it('a stamp plus a real MEDIUM flag is still stamp-only at high', async () => {
      const s = await makeSession('disc_medium', userId, 60_000);
      await stamp(s, 100);
      await flagEvent(s, { severity: 'medium', score: 55 });
      expect(
        (await recordRecoveryDisclosure({ sessionId: s, riskScore: 77, messageId: null, factors: [] })).recorded,
      ).toBe(true);
    });

    it('incidentHasCrisisAdverseEvent looks along the chain', async () => {
      const u = otherUserId;
      const first = await makeSession('ae_1', u, 50 * 60_000);
      const recovery = await makeSession('ae_2', u, 40 * 60_000);
      await stamp(recovery, 82, 40 * 60_000);
      expect(await incidentHasCrisisAdverseEvent(recovery)).toBe(false);
      await q(
        `INSERT INTO adverse_event_reports (session_id, session_ref, occurred_at, severity, trigger_source, due_at)
         VALUES ($1, $1, now(), 'high', 'manual', now() + interval '7 days')`,
        [first],
      );
      // A manually filed report is not the incident's crisis-flag report.
      expect(await incidentHasCrisisAdverseEvent(recovery)).toBe(false);
      await q(
        `INSERT INTO adverse_event_reports (session_id, session_ref, occurred_at, severity, trigger_source, due_at)
         VALUES ($1, $1, now(), 'high', 'auto_crisis_flag', now() + interval '7 days')`,
        [first],
      );
      expect(await incidentHasCrisisAdverseEvent(recovery)).toBe(true);
    });
  });

  describe('the silence check owed by a no-page row', () => {
    it('is found while unfinished, claimed by exactly one of several instances, and never again once done', async () => {
      const s = await makeSession('sil_1', userId, 10 * 60_000);
      const actionId = await noPageRow(s, 4 * 60_000, { state: 'pending' });

      const open = await getUnfinishedSilenceChecks(24 * 3600, 60);
      const mine = open.find((r) => r.action_id === actionId);
      expect(mine?.session_id).toBe(s);
      expect(mine?.age_ms).toBeGreaterThan(3.9 * 60_000);
      expect(mine?.age_ms).toBeLessThan(4.5 * 60_000);

      const claims = await Promise.all(
        ['one', 'two', 'three', 'four', 'five'].map((who) => claimSilenceCheck(actionId, who, 60)),
      );
      const won = claims.filter((c) => c !== null);
      expect(won).toHaveLength(1);
      expect(won[0]?.sessionId).toBe(s);
      expect(Date.now() - (won[0]?.cutAt.getTime() ?? 0)).toBeGreaterThan(3.9 * 60_000);
      expect((await checkOf(actionId)).state).toBe('running');

      // Claimed and fresh: not offered to the sweep, not claimable.
      expect((await getUnfinishedSilenceChecks(24 * 3600, 60)).some((r) => r.action_id === actionId)).toBe(false);
      expect(await claimSilenceCheck(actionId, 'late', 60)).toBeNull();

      expect(await finishSilenceCheck(actionId, 'done', { outcome: 'paged', pageActionId: 7 })).toBe(true);
      expect(await checkOf(actionId)).toMatchObject({ state: 'done', outcome: 'paged', pageActionId: 7 });
      expect(await finishSilenceCheck(actionId, 'done', { outcome: 'paged' })).toBe(false);
      expect(await claimSilenceCheck(actionId, 'again', 0)).toBeNull();
      expect((await getUnfinishedSilenceChecks(24 * 3600, 0)).some((r) => r.action_id === actionId)).toBe(false);

      // The rest of the row is untouched by the state changes.
      const { rows } = await q(`SELECT action_details FROM intervention_actions WHERE action_id = $1`, [actionId]);
      expect(rows[0].action_details).toMatchObject({
        suppressed: 'crisis_sms_alert',
        paging: { decision: 'no_page', kind: 'vendor_cut', delivered: false },
      });
    });

    it('a claim whose process died is offered again once it is stale, and only then', async () => {
      const s = await makeSession('sil_stale', userId, 10 * 60_000);
      const actionId = await noPageRow(s, 5 * 60_000, { state: 'pending' });
      expect(await claimSilenceCheck(actionId, 'dies', 60)).not.toBeNull();
      await q(
        `UPDATE intervention_actions
            SET action_details = jsonb_set(action_details, '{paging,silenceCheck,claimedAt}',
                                           to_jsonb(now() - interval '2 minutes'))
          WHERE action_id = $1`,
        [actionId],
      );
      expect((await getUnfinishedSilenceChecks(24 * 3600, 600)).some((r) => r.action_id === actionId)).toBe(false);
      expect((await getUnfinishedSilenceChecks(24 * 3600, 60)).some((r) => r.action_id === actionId)).toBe(true);
      const again = await Promise.all([claimSilenceCheck(actionId, 'b1', 60), claimSilenceCheck(actionId, 'b2', 60)]);
      expect(again.filter((c) => c !== null)).toHaveLength(1);
    });

    it('an undelivered check handed back is pending again, keeps its attempts, and a later claim keeps them', async () => {
      const s = await makeSession('sil_release', userId, 10 * 60_000);
      const actionId = await noPageRow(s, 4 * 60_000, { state: 'pending' });
      expect(await claimSilenceCheck(actionId, 'one', 60)).toMatchObject({ attempts: 0, isDemo: false });
      expect(await releaseSilenceCheck(actionId, { attempts: 1, lastOutcome: 'not_delivered' })).toBe(true);
      expect(await releaseSilenceCheck(actionId, { attempts: 9 })).toBe(false); // only from 'running'
      const released = await checkOf(actionId);
      expect(released).toEqual({ state: 'pending', attempts: 1, lastOutcome: 'not_delivered' });
      const open = await getUnfinishedSilenceChecks(24 * 3600, 60);
      expect(open.find((r) => r.action_id === actionId)).toMatchObject({ attempts: 1 });
      expect(await claimSilenceCheck(actionId, 'two', 60)).toMatchObject({ attempts: 1 });
      expect(await finishSilenceCheck(actionId, 'done', { outcome: 'paged' })).toBe(true);
      expect(await checkOf(actionId)).toMatchObject({ state: 'done', outcome: 'paged', attempts: 1, claimedBy: 'two' });
    });

    it('rows the sweep must not take: no silence check, harness/demo sessions, other paging decisions', async () => {
      const s = await makeSession('sil_skip', userId, 10 * 60_000);
      const legacy = await noPageRow(s, 4 * 60_000, null);
      const demo = await makeSession('sil_demo', userId, 10 * 60_000, true);
      const demoRow = await noPageRow(demo, 4 * 60_000, { state: 'pending' });
      const folded = (await insertPagingRecord(
        s,
        'external_api_called',
        { paging: { decision: 'folded', silenceCheck: { state: 'pending' } } },
        null,
      )) as number;
      const old = await noPageRow(s, 30 * 3600 * 1000, { state: 'pending' });

      const ids = (await getUnfinishedSilenceChecks(24 * 3600, 60)).map((r) => r.action_id);
      for (const id of [legacy, demoRow, folded, old]) expect(ids).not.toContain(id);
      expect(await claimSilenceCheck(legacy, 'x', 60)).toBeNull();
      expect(await claimSilenceCheck(folded, 'x', 60)).toBeNull();
      // The process that recorded a harness cut still runs its own check.
      expect(await claimSilenceCheck(demoRow, 'child', 60)).not.toBeNull();
    });

    it('expiring marks the row once', async () => {
      const s = await makeSession('sil_exp', userId, 60 * 60_000);
      const actionId = await noPageRow(s, 40 * 60_000, { state: 'pending' });
      const marks = await Promise.all([
        finishSilenceCheck(actionId, 'expired', { outcome: 'not_run' }),
        finishSilenceCheck(actionId, 'expired', { outcome: 'not_run' }),
      ]);
      expect(marks.filter(Boolean)).toHaveLength(1);
      expect(await checkOf(actionId)).toMatchObject({ state: 'expired', outcome: 'not_run' });
    });
  });

  // The whole path with the real queries under it: only the pager is a mock.
  describe('crisisPaging.service on real rows', () => {
    it('a no-risk cut, a restart, then the startup sweep: the check runs from the row and is recorded', async () => {
      const paging = await import('../services/crisisPaging.service.js');
      const s = await makeSession('svc_cut', thirdUserId, 10 * 60_000);
      sendCrisisAlertMock.mockClear();

      const decision = await paging.pageVendorTermination({
        sessionId: s,
        cause: 'content_filter',
        flagged: false,
        severity: null,
      });
      expect(decision.outcome).toBe('no_page');
      const actionId = decision.actionId as number;
      expect(await checkOf(actionId)).toEqual({ state: 'pending' });
      expect(sendCrisisAlertMock).not.toHaveBeenCalled();

      // Restart 1 minute in: the timer is gone. The sweep re-arms from the row.
      await q(`UPDATE intervention_actions SET performed_at = now() - interval '1 minute' WHERE action_id = $1`, [
        actionId,
      ]);
      paging._resetPagingStateForTests();
      expect(await paging.sweepSilenceChecks()).toMatchObject({ ran: 0, armed: 1 });
      paging._resetPagingStateForTests(); // a second restart, so the re-armed timer never fires in this test

      // 4 minutes after the cut, the participant silent: the sweep runs it.
      await q(`UPDATE intervention_actions SET performed_at = now() - interval '4 minutes' WHERE action_id = $1`, [
        actionId,
      ]);
      expect(await paging.sweepSilenceChecks()).toMatchObject({ ran: 1 });
      expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
      expect(String(sendCrisisAlertMock.mock.calls[0][0])).toMatch(/then 4 min of silence/);
      const done = await checkOf(actionId);
      expect(done).toMatchObject({ state: 'done', outcome: 'paged' });
      const page = await q(`SELECT action_type, action_details FROM intervention_actions WHERE action_id = $1`, [
        done.pageActionId,
      ]);
      expect(page.rows[0].action_type).toBe('crisis_sms_alert');
      expect(page.rows[0].action_details.paging).toMatchObject({ kind: 'vendor_cut', delivered: true });

      // Never twice.
      expect(await paging.sweepSilenceChecks()).toMatchObject({ ran: 0, armed: 0 });
      expect(await paging.runStoredSilenceCheck(actionId)).toBe('not_claimed');
      expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    });

    it('a recovery session cut 2 h 20 min after a real high flag pages as a HIGH cut', async () => {
      const paging = await import('../services/crisisPaging.service.js');
      const { rows } = await q(
        `INSERT INTO users (username, password, role, organization_id)
         SELECT $1, 'x', 'participant', org_id FROM organizations ORDER BY org_id LIMIT 1 RETURNING userid`,
        [`${tag}_d`],
      );
      const u = rows[0].userid as number;
      const first = await makeSession('svc_chain_1', u, 2 * HOUR + 30 * 60_000);
      await flagEvent(first, { severity: 'high', score: 84, agoMs: 2 * HOUR + 25 * 60_000 });
      const recovery = await makeSession('svc_chain_2', u, 2 * HOUR + 20 * 60_000);
      await stamp(recovery, 84, 2 * HOUR + 20 * 60_000);
      sendCrisisAlertMock.mockClear();

      const decision = await paging.pageVendorTermination({
        sessionId: recovery,
        cause: 'content_filter',
        flagged: true,
        severity: 'high',
      });
      expect(decision).toMatchObject({ outcome: 'paged', kind: 'vendor_cut', level: paging.PAGE_LEVEL.high });
      expect(String(sendCrisisAlertMock.mock.calls[0][0])).toMatch(/HIGH \(84\/100\)/);
    });
  });

  // The eval harness's "the detector paged" assertion reads the same rows.
  describe("the harness's risk-page assertion against real rows", () => {
    it('a vendor-cut page does not satisfy it; a risk page does', async () => {
      const { interventionLogged } = await import('../../redteam/assertions.js');
      const { interventionNotLogged } = await import('../../redteam/crisisAssertions.js');
      const s = await makeSession('harness_kind', userId, 60_000);
      const ctx = { pool, sessionId: s } as never;
      const risk = { pagingKind: 'risk' as const };

      await insertPagingRecord(
        s,
        'crisis_sms_alert',
        { paging: { decision: 'not_delivered', kind: 'vendor_cut' } },
        null,
      );
      expect((await interventionLogged('crisis_sms_alert').run(ctx)).passed).toBe(true);
      expect((await interventionLogged('crisis_sms_alert', risk).run(ctx)).passed).toBe(false);
      expect((await interventionNotLogged('crisis_sms_alert', risk).run(ctx)).passed).toBe(true);

      await insertPagingRecord(s, 'crisis_sms_alert', { paging: { decision: 'not_delivered', kind: 'risk' } }, 80);
      expect((await interventionLogged('crisis_sms_alert', risk).run(ctx)).passed).toBe(true);
      expect((await interventionNotLogged('crisis_sms_alert', risk).run(ctx)).passed).toBe(false);
    });
  });
});
