// The alliance-rating job against a REAL Postgres (ai-therapist-173). Every
// statement the feature runs is executed here, none of it mocked: which
// sessions are eligible, which messages the judge reads (redacted text only,
// nothing waiting for leak review), what is stored for each outcome, the
// CHECK constraints of migration 134, stale ratings and their re-rating, the
// upsert rule (a failed attempt never replaces an answer), the per-session
// claim, the export row with its as-of and stale handling, the study-week SQL
// of surveys_scored.csv, and that the rating goes when the session goes.
//
// Runs in CI: the `sql-tests` job of .github/workflows/pr-verify.yml migrates
// an empty Postgres to head and runs this file against it. In the plain unit
// run (`npm test`, no database) it is skipped. Locally:
//
//   ALLIANCE_SQL_DATABASE_URL=postgresql://.../ai_therapist_rt_alliance \
//     npx vitest run src/server/services/allianceRating.live.test.ts
//
// The database must be a THROWAWAY one at the migration head
// (scripts/redteam-db-setup.sh). The file refuses any database whose name
// does not start with `rt_` or contain `_rt_` or `scratch`. It writes rows
// under one throwaway organisation and deletes them afterwards. No OpenAI
// call: the judge is a fake client.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';

const URL_ = process.env.ALLIANCE_SQL_DATABASE_URL ?? '';
const dbName = (() => {
  try {
    return new URL(URL_).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();
const LIVE = URL_ !== '' && (dbName.startsWith('rt_') || dbName.includes('_rt_') || dbName.includes('scratch'));

const { holder } = vi.hoisted(() => ({ holder: { pool: null as unknown } }));
vi.mock('../config/db.js', () => ({
  get pool() {
    return holder.pool;
  },
}));

const { rateSessionAlliance, backfillAllianceRatings, getAllianceMarkersConfig } = await import(
  './allianceRating.service.js'
);
const { ALLIANCE_JUDGE_VERSION, LEVEL_LABELS } = await import('./allianceMarkers.js');
const {
  EMPTY_TRANSCRIPT_FINGERPRINT,
  getAllianceRating,
  getLatestAllianceRating,
  getLeakReviewStateForMessage,
  getSessionsNeedingAllianceRating,
  getTranscriptForAlliance,
  isSessionAllianceEligible,
  upsertAllianceRating,
  withAllianceRatingClaim,
} = await import('../db/allianceRatings.queries.js');
const { getAllianceRatingsExport } = await import('../db/datasetExport.queries.js');
const { getSurveyAnswersForExport } = await import('../db/qualtricsResponses.queries.js');
const { recordRedactionApproval, updateRedactedContent } = await import('../db/redaction.queries.js');

const stamp = Date.now().toString(36);
const tag = `alli_${stamp}`;
let pool: pg.Pool;
let orgId = 0;
const users: Record<string, number> = {};
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const RAW = 'RAWSECRET my name is Zebediah';
const REDACTED =
  'my name is [REDACTED: NAME] and I want to sleep better, the plan we made is helping and I trust this process';

function goodResponse() {
  const answers: unknown[] = [];
  for (const s of ['task', 'bond', 'goal']) {
    answers.push({ type: 'predicate', name: `${s}_rateable`, probability: s === 'goal' ? 0.1 : 0.9 });
    answers.push({
      type: 'score',
      name: `${s}_score`,
      probabilities: LEVEL_LABELS.map((label, i) => ({
        label,
        value: i,
        probability: i === 3 ? 0.75 : i === 4 ? 0.25 : 0,
      })),
    });
  }
  return { model: 'gpt-6-luna', answers, usage: { input_tokens: 1234, output_tokens: 0 } };
}

function fakeClient(impl: () => Promise<unknown> = async () => goodResponse()) {
  const create = vi.fn(impl);
  return { client: { decisions: { create } }, create };
}

/** The transcript text of the n-th judge call of a fake client. */
function transcriptSent(create: ReturnType<typeof vi.fn>, call = 0): string {
  const body = (create.mock.calls[call] as unknown as [{ input: Array<{ content: string }> }])[0];
  return body.input[1].content;
}

async function addSession(
  name: string,
  opts: { status?: string; isDemo?: boolean; userId?: number | null; createdAt?: string } = {},
): Promise<string> {
  const id = `${tag}_${name}`;
  await q(
    `INSERT INTO therapy_sessions (session_id, user_id, status, is_demo, created_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))`,
    [
      id,
      opts.userId === undefined ? users.p : opts.userId,
      opts.status ?? 'ended',
      opts.isDemo ?? false,
      opts.createdAt ?? null,
    ],
  );
  return id;
}

async function addTurns(sessionId: string, n: number, opts: { redacted?: boolean; lastPending?: boolean } = {}) {
  for (let i = 0; i < n; i++) {
    const pending = opts.redacted === false || (opts.lastPending && i === n - 1);
    await q(
      `INSERT INTO messages (session_id, role, message_type, content, content_redacted, created_at)
       VALUES ($1, $2, 'text', $3, $4, now() + ($5 || ' seconds')::interval)`,
      [sessionId, i % 2 ? 'user' : 'assistant', RAW, pending ? null : REDACTED, String(i)],
    );
  }
}

/** One extra message, later than every addTurns row. Returns its id. */
async function addMessage(
  sessionId: string,
  redacted: string | null,
  metadata: Record<string, unknown> | null = null,
  offsetSeconds = 500,
): Promise<string> {
  const { rows } = await q(
    `INSERT INTO messages (session_id, role, message_type, content, content_redacted, metadata, created_at)
     VALUES ($1, 'user', 'text', $2, $3, $4::jsonb, now() + ($5 || ' seconds')::interval)
     RETURNING message_id`,
    [sessionId, RAW, redacted, metadata ? JSON.stringify(metadata) : null, String(offsetSeconds)],
  );
  return String(rows[0].message_id);
}

const ratingRows = async (sessionId: string) =>
  (await q(`SELECT * FROM session_alliance_ratings WHERE session_id = $1 ORDER BY rating_id`, [sessionId])).rows;

const waitingMine = async () =>
  (await getSessionsNeedingAllianceRating(ALLIANCE_JUDGE_VERSION)).filter((id) => id.startsWith(tag)).sort();

describe.skipIf(!LIVE)('alliance ratings against a scratch Postgres (ai-therapist-173)', () => {
  const s: Record<string, string> = {};

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL_, max: 4 });
    holder.pool = pool;
    orgId = (
      await q(`INSERT INTO organizations (slug, name, kind) VALUES ($1, $1, 'practice') RETURNING org_id`, [tag])
    ).rows[0].org_id as number;
    const user = async (suffix: string, over: { role?: string; sandbox?: boolean; studyStatus?: string } = {}) => {
      users[suffix] = (
        await q(
          `INSERT INTO users (username, password, role, organization_id, is_sandbox, study_status)
           VALUES ($1, 'x', $2, $3, $4, $5) RETURNING userid`,
          [`${tag}_${suffix}`, over.role ?? 'participant', orgId, over.sandbox ?? false, over.studyStatus ?? 'active'],
        )
      ).rows[0].userid as number;
    };
    await user('p');
    await user('sb', { sandbox: true });
    await user('withdrawn', { studyStatus: 'withdrawn' });
    await user('paused', { studyStatus: 'paused' });
    await user('later'); // withdraws after their session is rated
    await user('therapist', { role: 'therapist' });
    await user('researcher', { role: 'researcher' });
    await user('caseworker', { role: 'caseworker' });
    await user('demo', { role: 'demo' });
    await user('twice'); // two enrollment records: the earliest counts
    await user('nosignup'); // a participant account with no enrollment record

    // p enrolled 10 days before the "good" session: that session is in study week 2.
    await q(
      `INSERT INTO qualtrics_signups (response_id, survey_id, user_id, registered_at) VALUES
         ($1, 'SV_test', $2, '2026-11-01T00:00:00Z'),
         ($3, 'SV_test', $4, '2026-11-05T00:00:00Z'),
         ($5, 'SV_test', $4, '2026-11-01T00:00:00Z')`,
      [`R_${tag}`, users.p, `R_${tag}_t2`, users.twice, `R_${tag}_t1`],
    );
    await q(
      `INSERT INTO research_pseudonyms (entity_type, entity_key, pseudonym) VALUES
         ('participant', $1, $2), ('participant', $3, $4), ('participant', $5, $6)`,
      [String(users.p), `PA${stamp}`, String(users.twice), `PB${stamp}`, String(users.nosignup), `PC${stamp}`],
    );

    s.good = await addSession('good', { createdAt: '2026-11-11T12:00:00Z' });
    await addTurns(s.good, 8);
    s.short = await addSession('short');
    await addTurns(s.short, 2);
    s.pending = await addSession('pending');
    await addTurns(s.pending, 8, { lastPending: true });
    s.unredacted = await addSession('unredacted');
    await addTurns(s.unredacted, 8, { redacted: false });
    s.active = await addSession('active', { status: 'active' });
    await addTurns(s.active, 8);
    s.demo = await addSession('demo', { isDemo: true });
    await addTurns(s.demo, 8);
    s.sandbox = await addSession('sandbox', { userId: users.sb });
    await addTurns(s.sandbox, 8);
    s.empty = await addSession('empty');
    s.wiped = await addSession('wiped');
    await addTurns(s.wiped, 8);
    // After the content wipe the original is gone and only the redaction is left.
    await q(`UPDATE messages SET content = NULL WHERE session_id = $1`, [s.wiped]);
    // A muted-microphone turn (ai-therapist-412) nobody said.
    await q(
      `INSERT INTO messages (session_id, role, message_type, content, content_redacted, metadata, created_at)
       VALUES ($1, 'user', 'text', 'x', 'PHANTOM TURN', '{"unverified_speech": true}'::jsonb, now() + interval '99 seconds')`,
      [s.good],
    );
    // Who owns the session (finding: only enrolled study participants).
    s.withdrawn = await addSession('withdrawn', { userId: users.withdrawn });
    s.paused = await addSession('paused', { userId: users.paused });
    s.later = await addSession('later', { userId: users.later });
    s.therapist = await addSession('therapist', { userId: users.therapist });
    s.researcher = await addSession('researcher', { userId: users.researcher });
    s.caseworker = await addSession('caseworker', { userId: users.caseworker });
    s.demoRole = await addSession('demorole', { userId: users.demo });
    s.anonymous = await addSession('anonymous', { userId: null });
    for (const name of [
      'withdrawn',
      'paused',
      'later',
      'therapist',
      'researcher',
      'caseworker',
      'demoRole',
      'anonymous',
    ]) {
      await addTurns(s[name], 8);
    }
    // Staleness, leak review and the claim each get a session of their own.
    s.late = await addSession('late');
    await addTurns(s.late, 8);
    s.leak = await addSession('leak');
    await addTurns(s.leak, 8);
    s.race = await addSession('race');
    await addTurns(s.race, 8);
  });

  afterAll(async () => {
    if (!pool) return;
    await q(`DELETE FROM therapy_sessions WHERE session_id LIKE $1`, [`${tag}_%`]);
    await q(`DELETE FROM research_pseudonyms WHERE entity_key LIKE $1`, [`${tag}_%`]);
    await q(`DELETE FROM research_pseudonyms WHERE pseudonym IN ($1, $2, $3)`, [
      `PA${stamp}`,
      `PB${stamp}`,
      `PC${stamp}`,
    ]);
    await q(`DELETE FROM qualtrics_signups WHERE response_id LIKE $1`, [`R_${tag}%`]);
    await q(`DELETE FROM qualtrics_responses WHERE response_id LIKE $1`, [`R_${tag}%`]);
    await q(`DELETE FROM redaction_review_log WHERE reviewed_by = $1`, [users.researcher]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`${tag}_%`]);
    await q(`DELETE FROM organizations WHERE slug = $1`, [tag]);
    await pool.end();
  });

  it('the migration seeds the switch off', async () => {
    expect(await getAllianceMarkersConfig()).toEqual({ enabled: false });
  });

  // ---------------------------------------------------------------- eligibility

  it('eligibility: an ended session of an enrolled participant with redaction complete, nothing else', async () => {
    const eligible: Record<string, boolean> = {};
    for (const [name, id] of Object.entries(s)) eligible[name] = await isSessionAllianceEligible(id);
    expect(eligible).toEqual({
      good: true,
      short: true,
      wiped: true,
      late: true,
      leak: true,
      race: true,
      // A paused participant is still enrolled; one who has not withdrawn YET is too.
      paused: true,
      later: true,
      pending: false,
      unredacted: false,
      active: false,
      demo: false,
      sandbox: false,
      empty: false,
      // Withdrawn participants, staff accounts of every role, anonymous sessions.
      withdrawn: false,
      therapist: false,
      researcher: false,
      caseworker: false,
      demoRole: false,
      anonymous: false,
    });
  });

  it('the backfill list is exactly the eligible, unrated sessions', async () => {
    expect(await waitingMine()).toEqual([s.good, s.short, s.wiped, s.late, s.leak, s.race, s.paused, s.later].sort());
  });

  it('an ineligible session is never rated, even when asked for by id with force', async () => {
    const { client, create } = fakeClient();
    for (const name of [
      'pending',
      'unredacted',
      'active',
      'demo',
      'sandbox',
      'empty',
      'withdrawn',
      'therapist',
      'researcher',
      'caseworker',
      'demoRole',
      'anonymous',
    ]) {
      expect(await rateSessionAlliance(s[name], { client, force: true })).toEqual({
        outcome: 'skipped',
        reason: 'not_eligible',
      });
    }
    expect(create).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------- what the judge reads

  it('the judge receives redacted text only: no raw content, no muted-microphone turn', async () => {
    const { client, create } = fakeClient();
    const result = await rateSessionAlliance(s.good, { client });
    expect(result.outcome).toBe('stored');
    const transcript = transcriptSent(create);
    expect(transcript).toContain('[REDACTED: NAME]');
    expect(transcript).not.toContain('RAWSECRET');
    expect(transcript).not.toContain('Zebediah');
    expect(transcript).not.toContain('PHANTOM');
    expect(transcript.split('\n')).toHaveLength(8);
  });

  it('stores numbers per subscale and what the rating was computed from; a not-rateable subscale has no score', async () => {
    const rows = await ratingRows(s.good);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({
      judge_version: ALLIANCE_JUDGE_VERSION,
      status: 'rated',
      task_rateable: true,
      task_level: 4,
      task_distribution: [0, 0, 0, 0.75, 0.25],
      goal_rateable: false,
      goal_score: null,
      goal_level: null,
      goal_distribution: null,
      model: 'gpt-6-luna',
      tokens_in: 1234,
      tokens_out: 0,
      participant_turns: 4,
      transcript_messages: 8,
      transcript_truncated: false,
      error: null,
    });
    expect(r.task_score).toBeCloseTo(4.25, 3);
    expect(r.goal_p_rateable).toBeCloseTo(0.1, 3);
    expect(r.transcript_fingerprint).toMatch(/^[0-9a-f]{32}$/);
    // No column of the row holds transcript text.
    expect(JSON.stringify(r)).not.toContain('REDACTED');
    // The stored fingerprint is the one the staleness check computes: not stale.
    expect((await getLatestAllianceRating(s.good))?.stale).toBe(false);
  });

  it('a message waiting for leak review is withheld from the judge; reviewed and passthrough messages are read', async () => {
    const check = { backend: 'decisions', model: 'gpt-6-luna', checked_at: '2026-11-26T00:00:00.000Z' };
    const flaggedId = await addMessage(s.leak, 'FLAGGEDLEAK Zebediah Smith', {
      redaction_check: { status: 'checked', p_leak: 0.91, flagged: true, ...check },
    });
    await addMessage(s.leak, 'ERROREDLEAK text nobody checked', {
      redaction_check: { status: 'errored', p_leak: -1, flagged: null, ...check, error: 'timeout' },
    });
    // The shape every row of the ai-therapist-284 outage carries.
    await addMessage(s.leak, 'OUTAGELEAK text nobody checked', {
      redaction_check: { p_leak: -1, flagged: false, ...check, error: '400 Missing required parameter' },
    });
    await addMessage(s.leak, 'REVIEWEDOK a researcher approved this', {
      redaction_check: { status: 'checked', p_leak: 0.91, flagged: true, reviewed: true, ...check },
    });
    await addMessage(s.leak, 'PASSTHROUGHOK stored as it stood', {
      redaction_passthrough: true,
      redaction_check: { status: 'checked', p_leak: 0.01, flagged: false, ...check },
    });
    // Flagged messages do not make the session ineligible: they are left out.
    expect(await isSessionAllianceEligible(s.leak)).toBe(true);

    const first = fakeClient();
    expect((await rateSessionAlliance(s.leak, { client: first.client })).outcome).toBe('stored');
    const transcript = transcriptSent(first.create);
    expect(transcript).toContain('REVIEWEDOK');
    expect(transcript).toContain('PASSTHROUGHOK');
    expect(transcript).not.toContain('FLAGGEDLEAK');
    expect(transcript).not.toContain('ERROREDLEAK');
    expect(transcript).not.toContain('OUTAGELEAK');
    expect(transcript.split('\n')).toHaveLength(10);
    expect((await ratingRows(s.leak))[0].transcript_messages).toBe(10);
    expect((await getLatestAllianceRating(s.leak))?.stale).toBe(false);

    // A researcher approves the flagged message (the real review write): it is
    // released to the judge, so the stored rating is stale, and two messages
    // of the session still wait for review.
    expect(await recordRedactionApproval(flaggedId, users.researcher)).toBe(true);
    expect((await getLatestAllianceRating(s.leak))?.stale).toBe(true);
    expect(await getLeakReviewStateForMessage(flaggedId)).toEqual({ sessionId: s.leak, awaitingReview: 2 });
    expect(await waitingMine()).toContain(s.leak);

    // Rated again without force: the released message is now read, the row is replaced.
    const second = fakeClient();
    expect((await rateSessionAlliance(s.leak, { client: second.client })).outcome).toBe('stored');
    expect(transcriptSent(second.create)).toContain('FLAGGEDLEAK');
    expect(transcriptSent(second.create)).not.toContain('ERROREDLEAK');
    const rows = await ratingRows(s.leak);
    expect(rows).toHaveLength(1);
    expect(rows[0].transcript_messages).toBe(11);
    expect((await getLatestAllianceRating(s.leak))?.stale).toBe(false);
    expect(await getLeakReviewStateForMessage('2147483000')).toBeNull();
  });

  // -------------------------------------------------------------- constraints

  it('the table refuses every row shape the job must never write', async () => {
    const dist = '[0,0,0,0.75,0.25]';
    const RATEABLE = (p: string) =>
      `${p}_rateable, ${p}_p_rateable, ${p}_score, ${p}_level, ${p}_confidence, ${p}_distribution`;
    const ok = `TRUE, 0.9, 4.25, 4, 0.75, '${dist}'::jsonb`;
    const insert = (status: string, task: string, bond = ok, goal = ok, error = 'NULL') =>
      q(
        `INSERT INTO session_alliance_ratings
           (session_id, judge_version, status, transcript_messages, transcript_fingerprint, error,
            ${RATEABLE('task')}, ${RATEABLE('bond')}, ${RATEABLE('goal')})
         VALUES ($1, 'constraint-test', '${status}', 8, 'x', ${error}, ${task}, ${bond}, ${goal})`,
        [s.good],
      );
    const none = `NULL, NULL, NULL, NULL, NULL, NULL`;
    const tooShort = `FALSE, NULL, NULL, NULL, NULL, NULL`;
    const bad: Array<[string, () => Promise<unknown>]> = [
      ['a score on a subscale marked not rateable', () => insert('rated', `FALSE, 0.2, 1.0, NULL, NULL, NULL`)],
      ['a level on a subscale marked not rateable', () => insert('rated', `FALSE, 0.2, NULL, 2, NULL, NULL`)],
      ['a confidence on a subscale marked not rateable', () => insert('rated', `FALSE, 0.2, NULL, NULL, 0.5, NULL`)],
      [
        'a distribution on a subscale marked not rateable',
        () => insert('rated', `FALSE, 0.2, NULL, NULL, NULL, '${dist}'`),
      ],
      ['a rateable subscale with no score', () => insert('rated', `TRUE, 0.9, NULL, 4, 0.75, '${dist}'`)],
      ['a rateable subscale with no distribution', () => insert('rated', `TRUE, 0.9, 4.25, 4, 0.75, NULL`)],
      ['a score above 5', () => insert('rated', `TRUE, 0.9, 5.5, 4, 0.75, '${dist}'`)],
      ['a score below 1', () => insert('rated', `TRUE, 0.9, 0.5, 4, 0.75, '${dist}'`)],
      ['a level of 6', () => insert('rated', `TRUE, 0.9, 4.25, 6, 0.75, '${dist}'`)],
      ['a rateable probability above 1', () => insert('rated', `TRUE, 1.2, 4.25, 4, 0.75, '${dist}'`)],
      ['a negative confidence', () => insert('rated', `TRUE, 0.9, 4.25, 4, -0.1, '${dist}'`)],
      ['a distribution of four levels', () => insert('rated', `TRUE, 0.9, 4.25, 4, 0.75, '[0,0,0.75,0.25]'`)],
      ['a distribution that is not an array', () => insert('rated', `TRUE, 0.9, 4.25, 4, 0.75, '{"a":1}'`)],
      ['a rated row with a subscale left blank', () => insert('rated', none)],
      ['a rated row without the rateable probability', () => insert('rated', `FALSE, NULL, NULL, NULL, NULL, NULL`)],
      ['an errored row with scores', () => insert('errored', ok, none, none, `'boom'`)],
      ['an errored row with a rateable flag', () => insert('errored', tooShort, none, none, `'boom'`)],
      ['an errored row with no error text', () => insert('errored', none, none, none)],
      ['a too_short row with scores', () => insert('too_short', ok, tooShort, tooShort)],
      [
        'a too_short row with an invented probability',
        () => insert('too_short', `FALSE, 0, NULL, NULL, NULL, NULL`, tooShort, tooShort),
      ],
      ['a too_short row with a blank flag', () => insert('too_short', none, tooShort, tooShort)],
      ['an error text on a rated row', () => insert('rated', ok, ok, ok, `'boom'`)],
    ];
    for (const [label, attempt] of bad) {
      await expect(attempt(), label).rejects.toThrow(/violates check constraint/);
    }
    // The shapes the job does write are accepted (then removed).
    await insert('rated', ok, `FALSE, 0.2, NULL, NULL, NULL, NULL`);
    await q(`DELETE FROM session_alliance_ratings WHERE judge_version = 'constraint-test'`);
    await insert('too_short', tooShort, tooShort, tooShort);
    await q(`DELETE FROM session_alliance_ratings WHERE judge_version = 'constraint-test'`);
    await insert('errored', none, none, none, `'boom'`);
    await q(`DELETE FROM session_alliance_ratings WHERE judge_version = 'constraint-test'`);
    // The fingerprint is required: a row cannot be written without its basis.
    await expect(
      q(
        `INSERT INTO session_alliance_ratings (session_id, judge_version, status, error) VALUES ($1, 'c2', 'errored', 'x')`,
        [s.good],
      ),
    ).rejects.toThrow(/not-null/);
  });

  // ------------------------------------------------------------------ outcomes

  it('a too-short session is stored as not rateable with no model call and no invented probability', async () => {
    const { client, create } = fakeClient();
    await rateSessionAlliance(s.short, { client });
    expect(create).not.toHaveBeenCalled();
    const rows = await ratingRows(s.short);
    expect(rows[0]).toMatchObject({
      status: 'too_short',
      task_rateable: false,
      bond_rateable: false,
      goal_rateable: false,
      task_p_rateable: null,
      bond_p_rateable: null,
      goal_p_rateable: null,
      task_score: null,
      model: null,
      transcript_messages: 2,
    });
  });

  it('a failed judge call is stored as errored, listed again, and replaced by the next answer', async () => {
    const failing = fakeClient(async () => Promise.reject(new Error('503 upstream')));
    await rateSessionAlliance(s.wiped, { client: failing.client });
    let rows = await ratingRows(s.wiped);
    expect(rows[0]).toMatchObject({ status: 'errored', task_rateable: null, task_score: null, error: '503 upstream' });
    expect(await waitingMine()).toContain(s.wiped);
    expect(
      (await getSessionsNeedingAllianceRating(ALLIANCE_JUDGE_VERSION, { includeErrored: false })).includes(s.wiped),
    ).toBe(false);

    // The backfill goes through every waiting session in the database; only
    // this file's rows exist in a scratch database built for it.
    const ok = fakeClient();
    await backfillAllianceRatings({ client: ok.client });
    rows = await ratingRows(s.wiped);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'rated', error: null, task_level: 4 });
    expect(await waitingMine()).toEqual([]);
  });

  it('a second run rates nothing new', async () => {
    const { client, create } = fakeClient();
    expect(await rateSessionAlliance(s.good, { client })).toEqual({ outcome: 'skipped', reason: 'already_rated' });
    expect(create).not.toHaveBeenCalled();
    const summary = await backfillAllianceRatings({ client });
    expect(summary.candidates).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------- stale ratings (1)

  it('a late turn makes the rating stale once it is redacted, and the session is rated again', async () => {
    const before = (await ratingRows(s.late))[0];
    expect(before).toMatchObject({ status: 'rated', transcript_messages: 8 });

    // The late /logs/batch flush: a turn lands after the session was rated,
    // not redacted yet. Nothing readable has changed; the session waits for
    // the redaction sweep and is not rateable meanwhile.
    const lateId = await addMessage(s.late, null);
    expect((await getLatestAllianceRating(s.late))?.stale).toBe(false);
    const idle = fakeClient();
    expect(await rateSessionAlliance(s.late, { client: idle.client })).toEqual({
      outcome: 'skipped',
      reason: 'not_eligible',
    });

    // The sweep redacts it: the stored rating no longer covers the transcript.
    await q(`UPDATE messages SET content_redacted = 'LATETURN and one more thing I forgot' WHERE message_id = $1`, [
      lateId,
    ]);
    expect((await getLatestAllianceRating(s.late))?.stale).toBe(true);
    expect(await waitingMine()).toEqual([s.late]);

    // The hook's call (no force): rated again, same judge version, the row replaced.
    const again = fakeClient();
    const result = await rateSessionAlliance(s.late, { client: again.client });
    expect(result.outcome).toBe('stored');
    expect(again.create).toHaveBeenCalledTimes(1);
    expect(transcriptSent(again.create)).toContain('LATETURN');
    const rows = await ratingRows(s.late);
    expect(rows).toHaveLength(1);
    expect(rows[0].rating_id).toBe(before.rating_id);
    expect(rows[0]).toMatchObject({ status: 'rated', transcript_messages: 9, participant_turns: 5 });
    expect(rows[0].transcript_fingerprint).not.toBe(before.transcript_fingerprint);
    expect(new Date(rows[0].rated_at).getTime()).toBeGreaterThanOrEqual(new Date(before.rated_at).getTime());
    expect((await getLatestAllianceRating(s.late))?.stale).toBe(false);
    expect(await waitingMine()).toEqual([]);
  });

  it('a re-redaction and a leak-review correction make the rating stale too', async () => {
    const { rows: msgs } = await q(
      `SELECT message_id FROM messages WHERE session_id = $1 ORDER BY created_at, message_id LIMIT 2`,
      [s.late],
    );
    // Re-redaction: same message, new redacted text.
    await q(`UPDATE messages SET content_redacted = content_redacted || ' REREDACTED' WHERE message_id = $1`, [
      msgs[0].message_id,
    ]);
    expect((await getLatestAllianceRating(s.late))?.stale).toBe(true);
    const a = fakeClient();
    expect((await rateSessionAlliance(s.late, { client: a.client })).outcome).toBe('stored');
    expect(transcriptSent(a.create)).toContain('REREDACTED');
    expect((await getLatestAllianceRating(s.late))?.stale).toBe(false);

    // A researcher's correction in the leak-review tool (the real write).
    expect(await updateRedactedContent(String(msgs[1].message_id), 'CORRECTED by a researcher', users.researcher)).toBe(
      true,
    );
    expect((await getLatestAllianceRating(s.late))?.stale).toBe(true);
    const b = fakeClient();
    expect((await rateSessionAlliance(s.late, { client: b.client })).outcome).toBe('stored');
    expect(transcriptSent(b.create)).toContain('CORRECTED by a researcher');
    expect((await getLatestAllianceRating(s.late))?.stale).toBe(false);

    // A later leak-check flag takes a message away from the judge: stale again.
    await q(
      `UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb)
              || '{"redaction_check": {"status": "checked", "flagged": true, "p_leak": 0.9}}'::jsonb
        WHERE message_id = $1`,
      [msgs[0].message_id],
    );
    expect((await getLatestAllianceRating(s.late))?.stale).toBe(true);
    const c = fakeClient();
    expect((await rateSessionAlliance(s.late, { client: c.client })).outcome).toBe('stored');
    expect(transcriptSent(c.create)).not.toContain('REREDACTED');
    expect((await ratingRows(s.late))[0].transcript_messages).toBe(8);
  });

  it('a session with no readable turn has the empty fingerprint', async () => {
    expect(await getTranscriptForAlliance(s.empty)).toEqual({ turns: [], fingerprint: EMPTY_TRANSCRIPT_FINGERPRINT });
    expect((await getTranscriptForAlliance(s.unredacted)).turns).toEqual([]);
  });

  // ------------------------------------------ the upsert rule and the claim (2)

  it('an errored result never replaces an answer; it does replace an earlier errored row', async () => {
    const stored = (await getAllianceRating(s.race, ALLIANCE_JUDGE_VERSION))!;
    expect(stored.status).toBe('rated');
    const errored = {
      sessionId: s.race,
      judgeVersion: ALLIANCE_JUDGE_VERSION,
      status: 'errored' as const,
      participantTurns: 4,
      participantWords: 80,
      transcriptChars: 100,
      transcriptTruncated: false,
      transcriptMessages: 8,
      transcriptFingerprint: stored.transcript_fingerprint,
      model: 'gpt-6-luna',
      tokensIn: null,
      tokensOut: null,
      error: 'the second, failing run',
    };
    // Same transcript (the hook and the backfill overlapping), and a different
    // one (a failed re-rating of a stale answer): refused either way, in SQL.
    expect(await upsertAllianceRating(errored)).toBeNull();
    expect(await upsertAllianceRating({ ...errored, transcriptFingerprint: 'another-transcript' })).toBeNull();
    expect((await ratingRows(s.race))[0]).toEqual(stored);

    // A too_short answer is an answer too.
    const { rows: shortBefore } = await q(`SELECT * FROM session_alliance_ratings WHERE session_id = $1`, [s.short]);
    expect(await upsertAllianceRating({ ...errored, sessionId: s.short })).toBeNull();
    expect((await ratingRows(s.short))[0]).toEqual(shortBefore[0]);

    // Under another judge version there is no answer yet: the errored row is
    // stored, a later errored attempt replaces it, and an answer replaces that.
    const v = { ...errored, judgeVersion: 'upsert-rule-test' };
    expect((await upsertAllianceRating(v))?.error).toBe('the second, failing run');
    expect((await upsertAllianceRating({ ...v, error: 'failed again' }))?.error).toBe('failed again');
    const answered = await upsertAllianceRating({
      ...v,
      status: 'too_short',
      error: null,
      model: null,
      subscales: {
        task: { rateable: false, pRateable: null, score: null, level: null, confidence: null, distribution: null },
        bond: { rateable: false, pRateable: null, score: null, level: null, confidence: null, distribution: null },
        goal: { rateable: false, pRateable: null, score: null, level: null, confidence: null, distribution: null },
      },
    });
    expect(answered).toMatchObject({ status: 'too_short', error: null });
    expect(await upsertAllianceRating(v)).toBeNull();
    await q(`DELETE FROM session_alliance_ratings WHERE judge_version = 'upsert-rule-test'`);
  });

  it('a failed forced re-rating leaves the stored rating exactly as it was', async () => {
    const before = (await ratingRows(s.race))[0];
    const failing = fakeClient(async () => Promise.reject(new Error('503 upstream')));
    expect(await rateSessionAlliance(s.race, { client: failing.client, force: true })).toEqual({
      outcome: 'skipped',
      reason: 'kept_existing',
    });
    expect(failing.create).toHaveBeenCalledTimes(1);
    expect((await ratingRows(s.race))[0]).toEqual(before);
  });

  it('two overlapping runs for one session make one judge call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = fakeClient(async () => {
      await gate;
      return goodResponse();
    });
    const other = fakeClient();
    const first = rateSessionAlliance(s.race, { client: slow.client, force: true });
    await vi.waitFor(() => expect(slow.create).toHaveBeenCalledTimes(1));
    // The second run (the backfill, or --force) arrives while the first is waiting for the judge.
    expect(await rateSessionAlliance(s.race, { client: other.client, force: true })).toEqual({
      outcome: 'skipped',
      reason: 'in_progress',
    });
    expect(other.create).not.toHaveBeenCalled();
    release();
    expect((await first).outcome).toBe('stored');
    // The claim is released afterwards, for the same and for other connections.
    const after = await withAllianceRatingClaim(s.race, ALLIANCE_JUDGE_VERSION, async () => 'free');
    expect(after).toEqual({ acquired: true, result: 'free' });
    // A claim on one session does not block another session.
    const nested = await withAllianceRatingClaim(s.race, ALLIANCE_JUDGE_VERSION, () =>
      withAllianceRatingClaim(s.good, ALLIANCE_JUDGE_VERSION, async () => 'other session'),
    );
    expect(nested).toEqual({ acquired: true, result: { acquired: true, result: 'other session' } });
    // And it is released when the work throws.
    await expect(
      withAllianceRatingClaim(s.race, ALLIANCE_JUDGE_VERSION, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await withAllianceRatingClaim(s.race, ALLIANCE_JUDGE_VERSION, async () => 1)).acquired).toBe(true);
  });

  // ---------------------------------------------------------------- withdrawal

  it('a participant who withdraws after a rating is not rated again; the stored row stays', async () => {
    expect((await ratingRows(s.later))[0].status).toBe('rated');
    await q(`UPDATE users SET study_status = 'withdrawn' WHERE userid = $1`, [users.later]);
    await addMessage(s.later, 'a late turn after the withdrawal');
    expect(await isSessionAllianceEligible(s.later)).toBe(false);
    expect(await waitingMine()).not.toContain(s.later);
    const { client, create } = fakeClient();
    expect(await rateSessionAlliance(s.later, { client, force: true })).toEqual({
      outcome: 'skipped',
      reason: 'not_eligible',
    });
    expect(create).not.toHaveBeenCalled();
    expect(await ratingRows(s.later)).toHaveLength(1);
  });

  // -------------------------------------------------------------------- export

  it('the export row carries the pseudonyms, the study week, the stale flag and numbers only', async () => {
    await q(
      `INSERT INTO research_pseudonyms (entity_type, entity_key, pseudonym) VALUES
         ('session', $1, $2), ('session', $3, $4), ('session', $5, $6)`,
      [s.good, `SA${stamp}`, s.later, `SB${stamp}`, s.wiped, `SC${stamp}`],
    );
    const all = await getAllianceRatingsExport('2099-01-01T00:00:00Z');
    const rows = all.filter((r) => r.session_pseudo_id === `SA${stamp}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      participant_id: `PA${stamp}`,
      session_started_at: '2026-11-11T12:00:00Z',
      study_week: 2,
      judge_version: ALLIANCE_JUDGE_VERSION,
      status: 'rated',
      task_rateable: true,
      task_score: 4.25,
      task_level: 4,
      task_confidence: 0.75,
      goal_rateable: false,
      goal_score: null,
      stale: false,
    });
    expect(Object.keys(rows[0])).not.toContain('session_id');
    expect(Object.keys(rows[0])).not.toContain('error');
    expect(Object.keys(rows[0])).not.toContain('transcript_fingerprint');
    // A rating whose transcript has changed since (the late turn after the
    // withdrawal above) is exported, marked stale.
    expect(all.find((r) => r.session_pseudo_id === `SB${stamp}`)).toMatchObject({ status: 'rated', stale: true });
    // A session with no pseudonym (out of the export's scope) has no row.
    expect(all.some((r) => r.session_pseudo_id === null)).toBe(false);
  });

  it('the export honours the as-of date for the session and for the rating', async () => {
    const mine = (rows: Array<Record<string, unknown>>) =>
      rows.filter((r) => [`SA${stamp}`, `SC${stamp}`].includes(String(r.session_pseudo_id)));
    // Session "good" started 2026-11-11 but was rated just now: as of the day
    // after the session there was no rating yet.
    expect(mine(await getAllianceRatingsExport('2026-11-12T00:00:00Z'))).toEqual([]);
    // Before the session started: nothing either.
    expect(mine(await getAllianceRatingsExport('2026-11-10T00:00:00Z'))).toEqual([]);
    // A rating made in the past is in an export as of a later date.
    await q(`UPDATE session_alliance_ratings SET rated_at = '2026-11-11T13:00:00Z' WHERE session_id = $1`, [s.good]);
    expect(mine(await getAllianceRatingsExport('2026-11-12T00:00:00Z')).map((r) => r.session_pseudo_id)).toEqual([
      `SA${stamp}`,
    ]);
    expect(mine(await getAllianceRatingsExport('2026-11-11T12:30:00Z'))).toEqual([]);
  });

  it('study_week in surveys_scored.csv: weeks from the earliest enrollment record, empty when not derivable', async () => {
    const response = (suffix: string, user: number, at: string | null, finished = true, role = 'weekly') =>
      q(
        `INSERT INTO qualtrics_responses (response_id, survey_id, survey_role, user_id, finished, recorded_at, answers)
         VALUES ($1, 'SV_test', $2, $3, $4, $5::timestamptz, '{"QID1": 3}'::jsonb)`,
        [`R_${tag}_${suffix}`, role, user, finished, at],
      );
    // p enrolled 2026-11-01T00:00:00Z.
    await response('pre', users.p, '2026-10-30T12:00:00Z'); // before enrollment
    await response('base', users.p, '2026-11-01T00:00:00Z', true, 'baseline'); // the first instant of week 1
    await response('w1', users.p, '2026-11-07T23:59:59Z'); // the last second of week 1
    await response('w2a', users.p, '2026-11-08T00:00:00Z'); // exactly 7 days: week 2
    await response('w2b', users.p, '2026-11-11T09:00:00Z'); // a second weekly response in week 2
    await response('w5', users.p, '2026-11-30T00:00:00Z');
    await response('unfinished', users.p, '2026-11-12T00:00:00Z', false);
    // Two enrollment records (2026-11-05 and 2026-11-01): the earliest counts.
    await response('twice', users.twice, '2026-11-09T00:00:00Z');
    // A participant with no enrollment record.
    await response('nosignup', users.nosignup, '2026-11-09T00:00:00Z');

    const rows = (await getSurveyAnswersForExport('2099-01-01T00:00:00Z')).filter((r) =>
      [`PA${stamp}`, `PB${stamp}`, `PC${stamp}`].includes(r.participant_id),
    );
    expect(rows.map((r) => [r.participant_id, r.recorded_at, r.study_week])).toEqual([
      [`PA${stamp}`, '2026-10-30T12:00:00Z', null],
      [`PA${stamp}`, '2026-11-01T00:00:00Z', 1],
      [`PA${stamp}`, '2026-11-07T23:59:59Z', 1],
      [`PA${stamp}`, '2026-11-08T00:00:00Z', 2],
      [`PA${stamp}`, '2026-11-11T09:00:00Z', 2],
      [`PA${stamp}`, '2026-11-30T00:00:00Z', 5],
      [`PB${stamp}`, '2026-11-09T00:00:00Z', 2],
      [`PC${stamp}`, '2026-11-09T00:00:00Z', null],
    ]);
    expect(rows[1].answers).toEqual({ QID1: 3 });
    // The same week as the alliance rating of the session of 2026-11-11: the
    // join the two files are built for. Two weekly responses share that week,
    // which is why the codebook tells the analyst to take the latest.
    const week2 = rows.filter((r) => r.participant_id === `PA${stamp}` && r.study_week === 2);
    expect(week2).toHaveLength(2);
    // As-of bounds the response time.
    const early = (await getSurveyAnswersForExport('2026-11-08T00:00:00Z')).filter(
      (r) => r.participant_id === `PA${stamp}`,
    );
    expect(early).toHaveLength(4);
  });

  it('deleting the session deletes its rating', async () => {
    await q(`DELETE FROM therapy_sessions WHERE session_id = $1`, [s.short]);
    const { rows } = await q(`SELECT 1 FROM session_alliance_ratings WHERE session_id = $1`, [s.short]);
    expect(rows).toHaveLength(0);
  });
});
