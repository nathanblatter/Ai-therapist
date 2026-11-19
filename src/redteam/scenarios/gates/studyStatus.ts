// GATE-03 (docs/eval-scenario-catalogue.md A2): a withdrawn or paused
// participant tries to start a session. The consent form says the app
// "collects nothing after you withdraw from the study". Enforcement:
// middleware/studyStatus.ts on every session-start route.
//
// Both accounts are put into their state the way the product does it
// (users.study_status + changed_at + source, the columns the withdrawal
// survey ingest stamps), then every start route is tried. The telemetry half
// of the promise is probed through the always-on client error beacon
// (/api/client-events), which stores the logged-in user's id. The engagement
// beacon is not probed: its streams are off by default (migration 095), so it
// would store nothing for anyone and prove nothing.
import type { Scenario } from '../../types.js';
import {
  acceptActiveConsent,
  closeSessionsQuietly,
  countSessions,
  ensureGateAccounts,
  loginFrom,
  passedAllGates,
  postStart,
  probeAssert,
  ProbeRecorder,
  show,
  START_ROUTES,
  type StartRoute,
} from './support.js';

const IP = '4.2.2.2';
const WITHDRAWN = 'rt_gate_withdrawn_pt';
const WITHDRAWN_ID = 1900000102;
const PAUSED = 'rt_gate_paused_pt';
const PAUSED_ID = 1900000103;

const ROUTES = Object.keys(START_ROUTES) as StartRoute[];

function refusedFor(status: 'withdrawn' | 'paused') {
  return (r: { steps: Record<string, { status: number; body: unknown }> }) => {
    const wrong = ROUTES.map((route) => [route, r.steps[`${status}:${route}`]] as const)
      .filter(([, s]) => {
        const b = (s?.body ?? {}) as { error?: string; studyStatus?: string; message?: string };
        return s?.status !== 403 || b.error !== 'study_status' || b.studyStatus !== status;
      })
      .map(([route, s]) => `${route}: ${show(s)}`);
    return wrong.length ? wrong.join('; ') : null;
  };
}

export const studyStatusGate: Scenario = {
  id: 'gate-study-status',
  title: 'Withdrawn or paused participant cannot start a session; nothing collected after withdrawal (GATE-03)',
  catalogueIds: ['GATE-03'],
  pipeline: 'http',
  personaSystem: '',
  beats: [],
  runJudge: false,
  knownGap: {
    reason:
      'POST /api/client-events stores the logged-in user id with no study-status check, so a withdrawn participant\'s browser telemetry is still collected after withdrawal; the consent form says the app "collects nothing after you withdraw from the study".',
    ref: 'ai-therapist-322',
    assertionIds: ['no-telemetry-after-withdrawal'],
  },
  setup: async (pool) => {
    await ensureGateAccounts(pool, [
      { username: WITHDRAWN, role: 'participant', userid: WITHDRAWN_ID },
      { username: PAUSED, role: 'participant', userid: PAUSED_ID },
    ]);
  },
  teardown: async (pool) => {
    await closeSessionsQuietly(pool, [WITHDRAWN_ID, PAUSED_ID]);
    await pool.query(`UPDATE users SET study_status = 'active' WHERE userid = ANY($1::int[])`, [
      [WITHDRAWN_ID, PAUSED_ID],
    ]);
  },
  httpProbe: async ({ client, pool }) => {
    const rec = new ProbeRecorder();
    const withdrawn = await loginFrom(client, IP, WITHDRAWN);
    await acceptActiveConsent(withdrawn);
    const paused = await loginFrom(client, IP, PAUSED);
    await acceptActiveConsent(paused);

    // Positive control while still active: the gates let them through.
    await rec.step('active:live', postStart(withdrawn, 'live'));

    const stamp = `UPDATE users SET study_status = $2, study_status_changed_at = now(), study_status_source = 'redteam-gate'
                    WHERE userid = $1 RETURNING study_status_changed_at`;
    const { rows } = await pool.query(stamp, [WITHDRAWN_ID, 'withdrawn']);
    const withdrawnAt = rows[0].study_status_changed_at as Date;
    await pool.query(stamp, [PAUSED_ID, 'paused']);
    rec.fact('withdrawnAt', withdrawnAt);

    const before = (await countSessions(pool, WITHDRAWN_ID)) + (await countSessions(pool, PAUSED_ID));
    for (const route of ROUTES) await rec.step(`withdrawn:${route}`, postStart(withdrawn, route));
    for (const route of ROUTES) await rec.step(`paused:${route}`, postStart(paused, route));
    rec.fact(
      'sessionsCreated',
      (await countSessions(pool, WITHDRAWN_ID)) + (await countSessions(pool, PAUSED_ID)) - before,
    );

    // Withdrawal ends collection, not account access (studyStatus.ts header).
    await rec.step('withdrawn:export', withdrawn.get('/api/me/export'));

    // Telemetry from the withdrawn account after the withdrawal timestamp.
    await rec.step(
      'withdrawn:client-event',
      withdrawn.post('/api/client-events').send({ kind: 'js_error', detail: { probe: 'gate-study-status' } }),
    );
    const telemetry = await pool.query(
      `SELECT COUNT(*)::int AS n FROM client_events WHERE user_id = $1 AND created_at >= $2`,
      [WITHDRAWN_ID, withdrawnAt],
    );
    rec.fact('telemetryRowsAfterWithdrawal', Number(telemetry.rows[0].n));
    return rec.record;
  },
  assertFinal: [
    probeAssert('control-active-participant-passes', 'before withdrawal the participant passes every gate', (r) =>
      passedAllGates(r.steps['active:live']) ? null : `active participant refused: ${show(r.steps['active:live'])}`,
    ),
    probeAssert(
      'withdrawn-refused-on-every-start-route',
      'chat, live, grok and create all 403 study_status=withdrawn',
      refusedFor('withdrawn'),
    ),
    probeAssert(
      'paused-refused-on-every-start-route',
      'chat, live, grok and create all 403 study_status=paused',
      refusedFor('paused'),
    ),
    probeAssert(
      'refusal-points-to-crisis-resources',
      'both refusals tell the participant to use the crisis resources shown',
      (r) => {
        const wrong = ['withdrawn:chat', 'paused:chat']
          .map((k) => [k, r.steps[k]] as const)
          .filter(([, s]) => !/crisis resources/i.test(String((s?.body as { message?: string })?.message ?? '')))
          .map(([k, s]) => `${k}: ${show(s)}`);
        return wrong.length ? wrong.join('; ') : null;
      },
    ),
    probeAssert('no-session-row-after-withdrawal', 'no therapy_sessions row was created for either account', (r) =>
      r.facts.sessionsCreated === 0 ? null : `${String(r.facts.sessionsCreated)} session row(s) created`,
    ),
    probeAssert('withdrawn-keeps-data-access', 'a withdrawn participant can still export their own data', (r) =>
      r.steps['withdrawn:export']?.status === 200 ? null : `export refused: ${show(r.steps['withdrawn:export'])}`,
    ),
    probeAssert(
      'no-telemetry-after-withdrawal',
      'no client_events row tied to the withdrawn account after withdrawal',
      (r) =>
        r.facts.telemetryRowsAfterWithdrawal === 0
          ? null
          : `${String(r.facts.telemetryRowsAfterWithdrawal)} client_events row(s) stored with the withdrawn participant's user_id after study_status_changed_at (POST /api/client-events answered ${show(r.steps['withdrawn:client-event'])})`,
    ),
  ],
};
