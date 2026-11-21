// GATE-06 (docs/eval-scenario-catalogue.md A2): non-US IP. Pass: participant
// routes denied, staff routes unaffected, unknown geolocation denied.
// Enforcement: middleware/ipFilter.ts, app-wide, on req.ip (`trust proxy` 1,
// so the harness sets the client address with X-Forwarded-For exactly as
// the Cloudflare tunnel does).
//
// "Staff" here is every staff role the admin app serves: researcher,
// therapist and caseworker. Each is probed on an /admin route and on the two
// non-/admin routes the admin app itself calls on load (/api/auth/status and
// /api/admin/messaging/inbox).
import type { Scenario } from '../../types.js';
import {
  acceptActiveConsent,
  agentFrom,
  closeSessionsQuietly,
  ensureGateAccounts,
  loginFrom,
  loginFromRefusedAddress,
  passedAllGates,
  postStart,
  probeAssert,
  ProbeRecorder,
  show,
  UK_IP,
  UNKNOWN_GEO_IP,
  US_IP,
} from './support.js';

const PARTICIPANT = 'rt_gate_geo_pt';
const PARTICIPANT_ID = 1900000106;
const STAFF = {
  researcher: 'rt_gate_geo_researcher',
  therapist: 'rt_gate_geo_therapist',
  caseworker: 'rt_gate_geo_caseworker',
} as const;
type StaffRole = keyof typeof STAFF;
const ROLES = Object.keys(STAFF) as StaffRole[];

const restricted = (s: { status: number; body: unknown } | undefined) =>
  s?.status === 403 && (s.body as { error?: string })?.error === 'Access Restricted';

export const nonUsIpGate: Scenario = {
  id: 'gate-non-us-ip',
  title: 'Non-US and unknown-location participants refused; staff unaffected abroad (GATE-06)',
  catalogueIds: ['GATE-06'],
  pipeline: 'http',
  personaSystem: '',
  beats: [],
  runJudge: false,
  setup: async (pool) => {
    await ensureGateAccounts(pool, [
      { username: PARTICIPANT, role: 'participant', userid: PARTICIPANT_ID },
      ...ROLES.map((role) => ({ username: STAFF[role], role })),
    ]);
  },
  // Only reached when the filter regresses and a refused-address start works.
  teardown: async (pool) => {
    await closeSessionsQuietly(pool, [PARTICIPANT_ID]);
  },
  httpProbe: async ({ client }) => {
    const rec = new ProbeRecorder();

    // Control from a US address: the participant reaches the app and passes
    // every gate.
    const us = await loginFrom(client, US_IP, PARTICIPANT);
    await acceptActiveConsent(us);
    await rec.step('us:live', postStart(us, 'live'));

    // Same account from abroad and from an address with no geolocation. The
    // login route itself is exempt (staff abroad must be able to sign in).
    for (const [label, ip] of [
      ['uk', UK_IP],
      ['unknown', UNKNOWN_GEO_IP],
    ] as const) {
      const pt = await loginFromRefusedAddress(client, ip, PARTICIPANT);
      await rec.step(`${label}:consent-status`, pt.get('/api/consent/status'));
      await rec.step(`${label}:live`, postStart(pt, 'live'));
      await rec.step(`${label}:chat`, postStart(pt, 'chat'));
    }
    await rec.step('uk:anonymous', agentFrom(client, UK_IP).get('/api/consent/status'));

    for (const role of ROLES) {
      // Not loginFrom: its /api/auth/status check is itself what is under test.
      const staff = await loginFromRefusedAddress(client, UK_IP, STAFF[role]);
      await rec.step(`${role}:admin`, staff.get('/admin/api/sessions'));
      await rec.step(`${role}:auth-status`, staff.get('/api/auth/status'));
      await rec.step(`${role}:inbox`, staff.get('/api/admin/messaging/inbox'));
    }
    return rec.record;
  },
  assertFinal: [
    probeAssert('control-us-participant-passes', 'from a US address the participant passes every gate', (r) =>
      passedAllGates(r.steps['us:live']) ? null : `US participant refused: ${show(r.steps['us:live'])}`,
    ),
    probeAssert(
      'non-us-participant-refused',
      'from a UK address every participant route answers 403 Access Restricted',
      (r) => {
        const wrong = ['uk:consent-status', 'uk:live', 'uk:chat', 'uk:anonymous']
          .filter((k) => !restricted(r.steps[k]))
          .map((k) => `${k}: ${show(r.steps[k])}`);
        return wrong.length ? wrong.join('; ') : null;
      },
    ),
    probeAssert(
      'unknown-geolocation-refused',
      'from an address with no geolocation every participant route is refused',
      (r) => {
        const wrong = ['unknown:consent-status', 'unknown:live', 'unknown:chat']
          .filter((k) => !restricted(r.steps[k]))
          .map((k) => `${k}: ${show(r.steps[k])}`);
        return wrong.length ? wrong.join('; ') : null;
      },
    ),
    probeAssert(
      'staff-admin-routes-unaffected-abroad',
      'researcher, therapist and caseworker reach /admin/api/sessions from abroad',
      (r) => {
        const wrong = ROLES.filter((role) => r.steps[`${role}:admin`]?.status !== 200).map(
          (role) => `${role}: ${show(r.steps[`${role}:admin`])}`,
        );
        return wrong.length ? wrong.join('; ') : null;
      },
    ),
    probeAssert(
      'staff-app-shell-unaffected-abroad',
      'every staff role reaches /api/auth/status and /api/admin/messaging/inbox from abroad',
      (r) => {
        const wrong = ROLES.flatMap((role) => [`${role}:auth-status`, `${role}:inbox`])
          .filter((k) => !r.steps[k] || restricted(r.steps[k]))
          .map((k) => `${k}: ${show(r.steps[k])}`);
        return wrong.length ? wrong.join('; ') : null;
      },
    ),
  ],
};
