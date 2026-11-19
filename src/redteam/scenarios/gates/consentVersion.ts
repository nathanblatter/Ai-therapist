// GATE-04 (docs/eval-scenario-catalogue.md A2): the consent version changes.
// Pass: session start is blocked until the new version is accepted, and the
// acceptance stores the version and the hash of the exact text accepted.
//
// The new version is published the way the study publishes one, through the
// researcher-only admin route (it busts the active-consent cache), and
// withdrawn again in teardown so every later scenario sees the original
// version (the harness accepts CURRENT_CONSENT_VERSION by constant). Every
// participant start route is probed, plus /api/sessions/create, which was
// removed (ai-therapist-323) because it skipped the consent and limit gates:
// it must stay gone (no 200, no row).
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
  REMOVED_CREATE_ROUTE,
  show,
  START_ROUTES,
  type StartRoute,
} from './support.js';

const IP = '4.2.2.3';
const PARTICIPANT = 'rt_gate_consent_pt';
const PARTICIPANT_ID = 1900000104;
const RESEARCHER = 'rt_gate_consent_researcher';
/** Prefix of every version this scenario publishes; teardown removes them. */
const VERSION_PREFIX = 'rtgate-';
const NEW_BODY =
  '## Before we begin (red-team gate revision)\n\nThis revision exists only inside a disposable red-team database.';

const ROUTES = Object.keys(START_ROUTES) as StartRoute[];

async function removePublishedVersions(pool: Parameters<NonNullable<Scenario['teardown']>>[0]): Promise<void> {
  await pool.query(`DELETE FROM consent_documents WHERE version LIKE $1`, [`${VERSION_PREFIX}%`]);
  const { invalidateConsentCache } = await import('../../../server/utils/consent.js');
  invalidateConsentCache();
}

export const consentVersionGate: Scenario = {
  id: 'gate-consent-version',
  title: 'New consent version blocks session start until accepted; acceptance stores version and hash (GATE-04)',
  catalogueIds: ['GATE-04'],
  pipeline: 'http',
  personaSystem: '',
  beats: [],
  runJudge: false,
  setup: async (pool) => {
    await removePublishedVersions(pool);
    await ensureGateAccounts(pool, [
      { username: PARTICIPANT, role: 'participant', userid: PARTICIPANT_ID },
      { username: RESEARCHER, role: 'researcher' },
    ]);
  },
  teardown: async (pool) => {
    await closeSessionsQuietly(pool, [PARTICIPANT_ID]);
    await removePublishedVersions(pool);
  },
  httpProbe: async ({ client, pool }) => {
    const rec = new ProbeRecorder();
    const pt = await loginFrom(client, IP, PARTICIPANT);
    const oldVersion = await acceptActiveConsent(pt);
    rec.fact('oldVersion', oldVersion);
    await rec.step('old:live', postStart(pt, 'live'));

    const researcher = await loginFrom(client, IP, RESEARCHER);
    const version = `${VERSION_PREFIX}${Date.now()}`;
    rec.fact('newVersion', version);
    await rec.step('publish', researcher.post('/admin/api/consent/versions').send({ version, body: NEW_BODY }));

    const before = await countSessions(pool, PARTICIPANT_ID);
    for (const route of ROUTES) await rec.step(`stale:${route}`, postStart(pt, route));
    await rec.step('stale:create', pt.post(REMOVED_CREATE_ROUTE).send({}));
    rec.fact('sessionsCreatedWhileStale', (await countSessions(pool, PARTICIPANT_ID)) - before);
    await rec.step('status', pt.get('/api/consent/status'));
    await rec.step('accept-old', pt.post('/api/consent/accept').send({ consentVersion: oldVersion }));
    await rec.step('accept-new', pt.post('/api/consent/accept').send({ consentVersion: version }));
    await rec.step('new:live', postStart(pt, 'live'));

    const { rows } = await pool.query(
      `SELECT pc.consent_version, pc.body_hash, cd.body_hash AS document_hash
         FROM participant_consents pc
         LEFT JOIN consent_documents cd ON cd.version = pc.consent_version
        WHERE pc.user_id = $1 AND pc.consent_version = $2`,
      [PARTICIPANT_ID, version],
    );
    rec.fact('acceptanceRows', rows);
    return rec.record;
  },
  assertFinal: [
    probeAssert('control-current-consent-passes', 'with the current version accepted, every gate passes', (r) =>
      passedAllGates(r.steps['old:live']) ? null : `refused before the change: ${show(r.steps['old:live'])}`,
    ),
    probeAssert('new-version-published', 'the researcher route published the new version (201)', (r) =>
      r.steps.publish?.status === 201 ? null : `publish failed: ${show(r.steps.publish)}`,
    ),
    probeAssert(
      'stale-consent-blocks-start',
      'chat, live and grok answer 412 consent_required with reconsent=true',
      (r) => {
        const wrong = (['chat', 'live', 'grok'] as StartRoute[])
          .map((route) => [route, r.steps[`stale:${route}`]] as const)
          .filter(([, s]) => {
            const b = (s?.body ?? {}) as { error?: string; reconsent?: boolean; currentVersion?: string };
            return (
              s?.status !== 412 ||
              b.error !== 'consent_required' ||
              b.reconsent !== true ||
              b.currentVersion !== r.facts.newVersion
            );
          })
          .map(([route, s]) => `${route}: ${show(s)}`);
        return wrong.length ? wrong.join('; ') : null;
      },
    ),
    probeAssert(
      'no-start-route-creates-a-session-on-stale-consent',
      'no start route created a session row before re-consent',
      (r) => {
        const create = r.steps['stale:create'];
        if (r.facts.sessionsCreatedWhileStale === 0 && create?.status !== 200) return null;
        return `${String(r.facts.sessionsCreatedWhileStale)} session row(s) created while consent was stale; POST /api/sessions/create answered ${show(create)}`;
      },
    ),
    probeAssert(
      'status-asks-for-reconsent',
      'GET /api/consent/status reports reconsentRequired with the new version and body',
      (r) => {
        const b = (r.steps.status?.body ?? {}) as {
          accepted?: boolean;
          reconsentRequired?: boolean;
          currentVersion?: string;
          body?: string;
        };
        return b.accepted === false &&
          b.reconsentRequired === true &&
          b.currentVersion === r.facts.newVersion &&
          b.body === NEW_BODY
          ? null
          : `unexpected status: ${show(r.steps.status)}`;
      },
    ),
    probeAssert(
      'old-version-acceptance-refused',
      'accepting the superseded version answers 409 stale_consent_version',
      (r) => (r.steps['accept-old']?.status === 409 ? null : `stale accept: ${show(r.steps['accept-old'])}`),
    ),
    probeAssert(
      'acceptance-stores-version-and-hash',
      'participant_consents holds the new version with the document hash',
      (r) => {
        const rows = (r.facts.acceptanceRows ?? []) as Array<{
          body_hash: string | null;
          document_hash: string | null;
        }>;
        if (r.steps['accept-new']?.status !== 200) return `accept failed: ${show(r.steps['accept-new'])}`;
        if (rows.length !== 1) return `${rows.length} acceptance rows for the new version (want 1)`;
        return rows[0].body_hash && rows[0].body_hash === rows[0].document_hash
          ? null
          : `body_hash ${rows[0].body_hash} does not match the document hash ${rows[0].document_hash}`;
      },
    ),
    probeAssert('start-unblocked-after-reconsent', 'after accepting the new version every gate passes again', (r) =>
      passedAllGates(r.steps['new:live']) ? null : `still refused: ${show(r.steps['new:live'])}`,
    ),
  ],
};
