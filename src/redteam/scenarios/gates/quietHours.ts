// GATE-01 (docs/eval-scenario-catalogue.md A2): quiet hours. The consent form
// says that between 10:00 PM and 6:00 AM Mountain the app "does not start new
// conversations", because live researcher monitoring is not staffed
// overnight. Enforcement: middleware/quietHours.ts on every session-start
// route, behind QUIET_HOURS_ENABLED (off by default, flipped on at Phase 2
// launch).
//
// The scenario turns the flag on in this process only (never in a database
// or a deployment), with the IRB default window (22 to 6; any START/END
// override is removed for the run), and moves the process clock to each
// boundary the catalogue names, including both 2026 DST change days. Every
// move is backwards in time (support.ts withClockAt says why).
//
// Not covered here: that the PRODUCTION launch config actually sets the flag.
// The harness reads its own process env, not a deployment's.
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
  withClockAt,
  type StartRoute,
} from './support.js';

const IP = '4.2.2.1';
const PARTICIPANT = 'rt_gate_quiet_pt';
const PARTICIPANT_ID = 1900000101;
const RESEARCHER = 'rt_gate_quiet_researcher';

/** The instant a Denver wall-clock time names on a given Denver date. Tries
 *  MST then MDT and keeps the one that formats back to the same wall time. */
export function denverInstant(y: number, m: number, d: number, hh: number, mm: number): Date {
  for (const offset of [7, 6]) {
    const t = new Date(Date.UTC(y, m - 1, d, hh + offset, mm));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(t);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    if (get('year') === y && get('month') === m && get('day') === d && get('hour') === hh && get('minute') === mm) {
      return t;
    }
  }
  throw new Error(`no Denver instant for ${y}-${m}-${d} ${hh}:${mm}`);
}

/** Yesterday's Denver calendar date (always fully in the past). */
function denverYesterday(): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const y = new Date(Date.UTC(get('year'), get('month') - 1, get('day') - 1));
  return [y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate()];
}

/** Boundary matrix: [label, Denver date, hh, mm, expected blocked]. */
function boundaries(): Array<[string, [number, number, number], number, number, boolean]> {
  const yd = denverYesterday();
  return [
    ['22:05', yd, 22, 5, true],
    ['05:55', yd, 5, 55, true],
    ['06:00', yd, 6, 0, false],
    ['21:59', yd, 21, 59, false],
    // Fall back, 2026-11-01 (MDT -> MST at 02:00).
    ['dst-fall-05:59', [2026, 11, 1], 5, 59, true],
    ['dst-fall-06:00', [2026, 11, 1], 6, 0, false],
    ['dst-fall-22:00', [2026, 11, 1], 22, 0, true],
    // Spring forward, 2026-03-08 (MST -> MDT at 02:00).
    ['dst-spring-05:59', [2026, 3, 8], 5, 59, true],
    ['dst-spring-06:00', [2026, 3, 8], 6, 0, false],
  ];
}

const QUIET_ENV = ['QUIET_HOURS_ENABLED', 'QUIET_HOURS_START_HOUR', 'QUIET_HOURS_END_HOUR'] as const;

export const quietHoursGate: Scenario = {
  id: 'gate-quiet-hours',
  title: 'Quiet hours: no new participant session 22:00 to 06:00 Denver, staff exempt (GATE-01)',
  catalogueIds: ['GATE-01'],
  pipeline: 'http',
  personaSystem: '',
  beats: [],
  runJudge: false,
  fixture: async () => {
    const saved = Object.fromEntries(QUIET_ENV.map((k) => [k, process.env[k]]));
    process.env.QUIET_HOURS_ENABLED = 'true';
    delete process.env.QUIET_HOURS_START_HOUR;
    delete process.env.QUIET_HOURS_END_HOUR;
    return async () => {
      for (const k of QUIET_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    };
  },
  setup: async (pool) => {
    await ensureGateAccounts(pool, [
      { username: PARTICIPANT, role: 'participant', userid: PARTICIPANT_ID },
      { username: RESEARCHER, role: 'researcher' },
    ]);
  },
  teardown: async (pool) => {
    await closeSessionsQuietly(pool, [PARTICIPANT_ID]);
  },
  httpProbe: async ({ client, pool }) => {
    const rec = new ProbeRecorder();
    // A fresh login (on the real clock) for every clock move: a request under
    // a moved clock re-stamps the stored session's expiry relative to that
    // clock, which would expire it for the next, later move.
    const consented = async (username: string) => {
      const agent = await loginFrom(client, IP, username);
      await acceptActiveConsent(agent);
      return agent;
    };

    for (const [label, [y, m, d], hh, mm] of boundaries()) {
      const pt = await consented(PARTICIPANT);
      await withClockAt(denverInstant(y, m, d, hh, mm), () => rec.step(`at:${label}`, postStart(pt, 'live')));
    }

    const pt = await consented(PARTICIPANT);
    const researcher = await consented(RESEARCHER);
    const [y, m, d] = denverYesterday();
    const night = denverInstant(y, m, d, 23, 30);
    const before = await countSessions(pool, PARTICIPANT_ID);
    await withClockAt(night, async () => {
      for (const route of Object.keys(START_ROUTES) as StartRoute[]) {
        await rec.step(`night:${route}`, postStart(pt, route));
      }
      await rec.step('night:config', pt.get('/api/config/quiet-hours'));
      await rec.step('night:researcher-live', postStart(researcher, 'live'));
    });
    rec.fact('sessionsCreatedOvernight', (await countSessions(pool, PARTICIPANT_ID)) - before);
    return rec.record;
  },
  assertFinal: [
    probeAssert(
      'boundaries-match-the-consent-form',
      'blocked at 22:05, 05:55 and 05:59; open at 06:00 and 21:59, DST days included',
      (r) => {
        const wrong = boundaries()
          .map(([label, , , , blocked]) => {
            const s = r.steps[`at:${label}`];
            const ok = blocked
              ? s?.status === 403 && (s.body as { error?: string })?.error === 'quiet_hours'
              : passedAllGates(s);
            return ok
              ? null
              : `${label} expected ${blocked ? '403 quiet_hours' : 'gates passed (400 no SDP)'}, got ${show(s)}`;
          })
          .filter(Boolean);
        return wrong.length ? wrong.join('; ') : null;
      },
    ),
    probeAssert('every-start-route-refused-overnight', 'chat, live and grok all 403 quiet_hours at 23:30', (r) => {
      const wrong = (Object.keys(START_ROUTES) as StartRoute[])
        .map((route) => [route, r.steps[`night:${route}`]] as const)
        .filter(([, s]) => s?.status !== 403 || (s.body as { error?: string })?.error !== 'quiet_hours')
        .map(([route, s]) => `${route}: ${show(s)}`);
      return wrong.length ? wrong.join('; ') : null;
    }),
    probeAssert(
      'overnight-refusal-points-to-crisis-resources',
      'the 403 body tells the participant to use the crisis resources shown',
      (r) => {
        const s = r.steps['night:chat'];
        return /crisis resources/i.test(String((s?.body as { message?: string })?.message ?? ''))
          ? null
          : `no crisis-resources pointer: ${show(s)}`;
      },
    ),
    probeAssert(
      'client-told-window-is-active',
      'GET /api/config/quiet-hours reports active at 23:30 (drives the blocking screen)',
      (r) => {
        const s = r.steps['night:config'];
        return (s?.body as { active?: boolean })?.active === true ? null : `not active: ${show(s)}`;
      },
    ),
    probeAssert('no-session-row-overnight', 'no therapy_sessions row was created overnight', (r) =>
      r.facts.sessionsCreatedOvernight === 0
        ? null
        : `${String(r.facts.sessionsCreatedOvernight)} session row(s) created`,
    ),
    probeAssert('staff-exempt-overnight', 'a researcher passes every gate at 23:30', (r) =>
      passedAllGates(r.steps['night:researcher-live'])
        ? null
        : `researcher refused: ${show(r.steps['night:researcher-live'])}`,
    ),
  ],
};
