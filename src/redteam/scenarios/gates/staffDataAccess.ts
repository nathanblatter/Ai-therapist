// STAFF-10 (docs/eval-scenario-catalogue.md A13): live-monitoring and
// data-access controls. "A pilot therapist cannot open a study session, send
// a message into it or trigger a tool on it; every transcript view, recording
// playback and export writes a data_access_log row." The protocol: "clinical-
// pilot staff have no access to study-participant data".
//
// World: a clinical-pilot organization (kind practice) with a therapist and a
// caseworker whose caseload is one pilot client; an irb-study participant
// with a study session carrying a canary phrase; an irb-study researcher.
// Both sessions are seeded ENDED with content_redacted filled, so no sweep or
// post-session job can pick them up (no model call even if a gate regresses).
//
// Not covered: recording playback audit. The stream route logs only after the
// object store answers, and the harness has no object store; the denial half
// (pilot staff get 404 on the recording routes) is covered.
import type { DbLike, Scenario } from '../../types.js';
import { ensureGateAccounts, loginFrom, probeAssert, ProbeRecorder, show } from './support.js';

const IP = '4.2.2.5';
const RESEARCHER = 'rt_gate_staff_researcher';
const PILOT_THERAPIST = 'rt_gate_pilot_therapist';
const PILOT_CASEWORKER = 'rt_gate_pilot_caseworker';
const STUDY_PT = 'rt_gate_study_pt';
const STUDY_PT_ID = 1900000107;
const PILOT_CLIENT = 'rt_gate_pilot_client';
const PILOT_CLIENT_ID = 1900000108;
const STUDY_SESSION = 'redteam_gate_study_session';
const PILOT_SESSION = 'redteam_gate_pilot_session';
const STUDY_CANARY = "the cartographer's silver kite";
const PILOT_CANARY = "the beekeeper's copper bell";

/** Steps the pilot staff ran against study data, by caller. */
const PILOT_CALLERS = ['therapist', 'caseworker'] as const;

async function seedSession(pool: DbLike, sessionId: string, userId: number, text: string): Promise<number> {
  await pool.query(
    `INSERT INTO therapy_sessions (session_id, user_id, status, session_type, created_at, ended_at, ended_by, is_demo,
                                   crisis_flagged)
     VALUES ($1, $2, 'ended', 'chat', now() - interval '3 hours', now() - interval '2 hours', 'user', true, false)
     ON CONFLICT (session_id) DO UPDATE SET status = 'ended', crisis_flagged = false, crisis_severity = NULL`,
    [sessionId, userId],
  );
  await pool.query(`DELETE FROM messages WHERE session_id = $1`, [sessionId]);
  const { rows } = await pool.query(
    `INSERT INTO messages (session_id, role, message_type, content, content_redacted)
     VALUES ($1, 'user', 'text', $2, $2) RETURNING message_id`,
    [sessionId, `I keep thinking about ${text}.`],
  );
  return Number(rows[0].message_id);
}

/** logDataAccess is fire-and-forget: wait (bounded) for the rows to land. */
async function accessRows(
  pool: DbLike,
  since: Date,
): Promise<Array<{ accessed_by: number; role: string; action: string; session_id: string | null }>> {
  let last: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 20; i++) {
    const { rows } = await pool.query(
      `SELECT accessed_by, role, action, session_id FROM data_access_log WHERE created_at >= $1 ORDER BY id`,
      [since],
    );
    if (rows.length === last.length && i > 2) break;
    last = rows;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last as Array<{ accessed_by: number; role: string; action: string; session_id: string | null }>;
}

export const staffDataAccess: Scenario = {
  id: 'staff-data-access-controls',
  title: 'Clinical-pilot staff cannot open or act on a study session; views and exports are audited (STAFF-10)',
  catalogueIds: ['STAFF-10'],
  pipeline: 'http',
  personaSystem: '',
  beats: [],
  runJudge: false,
  setup: async (pool) => {
    const ids = await ensureGateAccounts(pool, [
      { username: RESEARCHER, role: 'researcher' },
      { username: PILOT_THERAPIST, role: 'therapist', org: 'pilot' },
      { username: PILOT_CASEWORKER, role: 'caseworker', org: 'pilot' },
      { username: STUDY_PT, role: 'participant', userid: STUDY_PT_ID },
      { username: PILOT_CLIENT, role: 'participant', userid: PILOT_CLIENT_ID, org: 'pilot' },
    ]);
    // A thread left by an earlier run that broke the gate would fail this one.
    await pool.query(`DELETE FROM message_threads WHERE client_id = $1`, [STUDY_PT_ID]);
    await pool.query(`DELETE FROM therapist_clients WHERE therapist_id = ANY($1::int[])`, [
      [ids[PILOT_THERAPIST], ids[PILOT_CASEWORKER]],
    ]);
    await pool.query(
      `INSERT INTO therapist_clients (therapist_id, client_id, member_role) VALUES ($1, $3, 'therapist'), ($2, $3, 'caseworker')`,
      [ids[PILOT_THERAPIST], ids[PILOT_CASEWORKER], PILOT_CLIENT_ID],
    );
  },
  httpProbe: async ({ client, pool }) => {
    const rec = new ProbeRecorder();
    const studyMessageId = await seedSession(pool, STUDY_SESSION, STUDY_PT_ID, STUDY_CANARY);
    await seedSession(pool, PILOT_SESSION, PILOT_CLIENT_ID, PILOT_CANARY);
    const { rows: users } = await pool.query(`SELECT userid, username FROM users WHERE username = ANY($1::text[])`, [
      [RESEARCHER, PILOT_THERAPIST, PILOT_CASEWORKER],
    ]);
    const idOf = Object.fromEntries(users.map((u) => [String(u.username), Number(u.userid)]));
    rec.fact('ids', idOf);
    const { rows: nowRows } = await pool.query(`SELECT now() AS t`);
    const since = nowRows[0].t as Date;

    const S = encodeURIComponent(STUDY_SESSION);
    for (const role of PILOT_CALLERS) {
      const agent = await loginFrom(client, IP, role === 'therapist' ? PILOT_THERAPIST : PILOT_CASEWORKER);
      const p = (k: string) => `${role}:${k}`;
      // Open it.
      await rec.step(p('transcript'), agent.get(`/admin/api/sessions/${S}`));
      await rec.step(p('recording-info'), agent.get(`/admin/api/sessions/${S}/recording-info`));
      await rec.step(p('recording'), agent.get(`/admin/api/sessions/${S}/recording`));
      await rec.step(p('risk-check'), agent.get(`/admin/api/sessions/${S}/risk-check`));
      await rec.step(p('export'), agent.get(`/admin/api/export?sessionId=${S}&format=json`));
      await rec.step(p('list'), agent.get('/admin/api/sessions'));
      await rec.step(p('active'), agent.get('/admin/api/sessions/active'));
      // Send something into it or act on it.
      await rec.step(
        p('instructions'),
        agent.post(`/admin/api/sessions/${S}/update-instructions`).send({ instructions: 'redteam probe' }),
      );
      await rec.step(p('flag'), agent.post(`/admin/api/sessions/${S}/crisis/flag`).send({ severity: 'low' }));
      await rec.step(p('edit-message'), agent.put(`/admin/api/messages/${studyMessageId}`).send({ content: 'edited' }));
      await rec.step(p('thread'), agent.post('/api/admin/messaging/threads').send({ client_id: STUDY_PT_ID }));
      // Positive control: their own pilot client.
      await rec.step(p('own-client-transcript'), agent.get(`/admin/api/sessions/${encodeURIComponent(PILOT_SESSION)}`));
    }

    const researcher = await loginFrom(client, IP, RESEARCHER);
    await rec.step('researcher:transcript', researcher.get(`/admin/api/sessions/${S}`));
    await rec.step('researcher:export', researcher.get(`/admin/api/export?sessionId=${S}&format=json`));
    await rec.step('researcher:dataset', researcher.get('/admin/api/export/dataset?includeTranscripts=false'));

    rec.fact('accessLog', await accessRows(pool, since));
    const { rows: state } = await pool.query(
      `SELECT s.crisis_flagged, m.content FROM therapy_sessions s JOIN messages m ON m.session_id = s.session_id
        WHERE s.session_id = $1`,
      [STUDY_SESSION],
    );
    rec.fact('studyState', state[0]);
    const { rows: threads } = await pool.query(`SELECT COUNT(*)::int AS n FROM message_threads WHERE client_id = $1`, [
      STUDY_PT_ID,
    ]);
    rec.fact('studyThreads', Number(threads[0].n));
    return rec.record;
  },
  assertFinal: [
    probeAssert(
      'control-pilot-staff-see-own-client',
      "the pilot therapist opens their own client's session (200)",
      (r) =>
        r.steps['therapist:own-client-transcript']?.status === 200
          ? null
          : `pilot therapist cannot open their own client: ${show(r.steps['therapist:own-client-transcript'])}`,
    ),
    probeAssert(
      'pilot-staff-cannot-open-study-session',
      'transcript, recording, risk check and export of the study session are refused (403/404)',
      (r) => {
        const wrong = PILOT_CALLERS.flatMap((role) =>
          ['transcript', 'recording-info', 'recording', 'risk-check', 'export'].map((k) => `${role}:${k}`),
        )
          .filter((k) => ![403, 404].includes(r.steps[k]?.status ?? 0))
          .map((k) => `${k}: ${show(r.steps[k])}`);
        return wrong.length ? wrong.join('; ') : null;
      },
    ),
    probeAssert(
      'pilot-staff-cannot-act-on-study-session',
      'instructions, crisis flag, message edit and a new thread to the study participant are refused',
      (r) => {
        const wrong = PILOT_CALLERS.flatMap((role) =>
          ['instructions', 'flag', 'edit-message', 'thread'].map((k) => `${role}:${k}`),
        )
          .filter((k) => ![403, 404].includes(r.steps[k]?.status ?? 0))
          .map((k) => `${k}: ${show(r.steps[k])}`);
        const st = r.facts.studyState as { crisis_flagged?: boolean; content?: string } | undefined;
        if (st?.crisis_flagged) wrong.push('study session is now crisis-flagged');
        if (!st?.content?.includes(STUDY_CANARY)) wrong.push(`study message content changed: ${String(st?.content)}`);
        if (r.facts.studyThreads !== 0)
          wrong.push(`${String(r.facts.studyThreads)} message thread(s) to the study participant`);
        return wrong.length ? wrong.join('; ') : null;
      },
    ),
    probeAssert(
      'pilot-staff-see-nothing-of-the-study',
      'no pilot-staff response names the study session or carries its text',
      (r) => {
        const missing = PILOT_CALLERS.flatMap((role) => [`${role}:list`, `${role}:active`]).filter((k) => !r.steps[k]);
        if (missing.length) return `not probed: ${missing.join(', ')}`;
        const wrong = Object.entries(r.steps)
          .filter(([k]) => k.startsWith('therapist:') || k.startsWith('caseworker:'))
          .filter(([, s]) => {
            const text = JSON.stringify(s.body ?? '');
            return text.includes(STUDY_SESSION) || text.includes(STUDY_CANARY) || text.includes(STUDY_PT);
          })
          .map(([k]) => k);
        return wrong.length ? `study data in: ${wrong.join(', ')}` : null;
      },
    ),
    probeAssert(
      'transcript-views-audited',
      'researcher and pilot-therapist transcript views each wrote a transcript_view row',
      (r) => {
        const ids = r.facts.ids as Record<string, number>;
        const log = (r.facts.accessLog ?? []) as Array<{
          accessed_by: number;
          action: string;
          session_id: string | null;
        }>;
        const has = (who: number, action: string, session: string | null) =>
          log.some((l) => l.accessed_by === who && l.action === action && l.session_id === session);
        const missing: string[] = [];
        if (!has(ids[RESEARCHER], 'transcript_view', STUDY_SESSION)) missing.push('researcher transcript_view');
        if (!has(ids[PILOT_THERAPIST], 'transcript_view', PILOT_SESSION))
          missing.push('pilot therapist transcript_view');
        if (r.steps['researcher:transcript']?.status !== 200)
          missing.push(`researcher view ${show(r.steps['researcher:transcript'])}`);
        return missing.length ? `missing: ${missing.join(', ')}` : null;
      },
    ),
    probeAssert('exports-audited', 'the researcher session export and dataset export each wrote a row', (r) => {
      const ids = r.facts.ids as Record<string, number>;
      const log = (r.facts.accessLog ?? []) as Array<{
        accessed_by: number;
        action: string;
        session_id: string | null;
      }>;
      const missing: string[] = [];
      if (r.steps['researcher:export']?.status !== 200) missing.push(`export ${show(r.steps['researcher:export'])}`);
      else if (
        !log.some((l) => l.accessed_by === ids[RESEARCHER] && l.action === 'export' && l.session_id === STUDY_SESSION)
      )
        missing.push('export row');
      if (r.steps['researcher:dataset']?.status !== 200) missing.push(`dataset ${show(r.steps['researcher:dataset'])}`);
      else if (!log.some((l) => l.accessed_by === ids[RESEARCHER] && l.action === 'dataset_export'))
        missing.push('dataset_export row');
      return missing.length ? `missing: ${missing.join(', ')}` : null;
    }),
    probeAssert(
      'refused-access-leaves-no-access-row',
      'no data_access_log row for pilot staff on the study session',
      (r) => {
        const ids = r.facts.ids as Record<string, number> | undefined;
        const log = r.facts.accessLog as Array<{ accessed_by: number; action: string; session_id: string | null }>;
        if (!ids || !Array.isArray(log)) return 'access log not read';
        const bad = log.filter(
          (l) =>
            [ids[PILOT_THERAPIST], ids[PILOT_CASEWORKER]].includes(l.accessed_by) && l.session_id === STUDY_SESSION,
        );
        return bad.length ? `${bad.length} access row(s): ${JSON.stringify(bad)}` : null;
      },
    ),
  ],
};
