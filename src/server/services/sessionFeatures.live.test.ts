// The session-features job against a REAL Postgres (ai-therapist-172). Every
// statement the feature runs is executed here, none of it mocked: which
// sessions are eligible, which messages the judge reads (redacted text only,
// nothing waiting for leak review), what is stored for each outcome, the
// CHECK constraints of migration 135, stale rows and their re-extraction, the
// upsert rule (a failed attempt never replaces an answer), the per-session
// claim, the export rows with their as-of and stale handling, and that the
// row goes when the session goes.
//
// Runs in CI: the `sql-tests` job of .github/workflows/pr-verify.yml migrates
// an empty Postgres to head and runs this file against it, AFTER the alliance
// file and not alongside it (each file's backfill test walks every waiting
// session in the database). In the plain unit run (`npm test`, no database)
// it is skipped. Locally:
//
//   SESSION_FEATURES_SQL_DATABASE_URL=postgresql://.../ai_therapist_rt_features \
//     npx vitest run src/server/services/sessionFeatures.live.test.ts
//
// The database must be a THROWAWAY one at the migration head
// (scripts/redteam-db-setup.sh). The file refuses any database whose name
// does not start with `rt_` or contain `_rt_` or `scratch`. It writes rows
// under one throwaway organisation and deletes them afterwards. No OpenAI
// call: the judge is a fake client.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';

const URL_ = process.env.SESSION_FEATURES_SQL_DATABASE_URL ?? '';
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

const { backfillSessionFeatures, extractSessionFeatures, getSessionFeaturesConfig } = await import(
  './sessionFeatures.service.js'
);
const { SESSION_FEATURE_SET_VERSION, SESSION_FEATURES } = await import('./sessionFeatures.js');
const {
  getLatestSessionFeatures,
  getSessionFeatures,
  getSessionsNeedingFeatures,
  upsertSessionFeatures,
  withSessionFeaturesClaim,
} = await import('../db/sessionFeatures.queries.js');
const { getLeakReviewStateForMessage, isSessionJudgeEligible } = await import('../db/sessionJudge.queries.js');
const { withAllianceRatingClaim } = await import('../db/allianceRatings.queries.js');
const { getSessionFeaturesExport } = await import('../db/datasetExport.queries.js');
const { recordRedactionApproval, updateRedactedContent } = await import('../db/redaction.queries.js');

const stamp = Date.now().toString(36);
const tag = `feat_${stamp}`;
let pool: pg.Pool;
let orgId = 0;
const users: Record<string, number> = {};
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const RAW = 'RAWSECRET my name is Zebediah';
const REDACTED =
  'my name is [REDACTED: NAME] and I have not been sleeping, I did not do the worksheet and I have not told anyone';

/** Sleep present, family uncertain, substance use refused, everything else
 *  absent; the earlier between-session work was not done; no rupture. */
function goodResponse() {
  const answers = SESSION_FEATURES.map((f) => {
    if (f.name === 'topic_substance_use') return { type: 'refusal', name: f.name };
    if (f.type === 'predicate') {
      const p = f.name === 'topic_sleep' ? 0.97 : f.name === 'topic_family' ? 0.5 : 0.02;
      return { type: 'predicate', name: f.name, probability: p };
    }
    const pick = f.name === 'followup_status' ? 'not_done' : f.choices[0].value;
    return {
      type: 'choice',
      name: f.name,
      choice: pick,
      confidence: 0.85,
      probabilities: f.choices.map((c) => ({
        value: c.value,
        probability: c.value === pick ? 0.85 : 0.15 / (f.choices.length - 1),
      })),
    };
  });
  return { model: 'gpt-6-luna', answers, usage: { input_tokens: 5678, output_tokens: 0 } };
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
): Promise<string> {
  const { rows } = await q(
    `INSERT INTO messages (session_id, role, message_type, content, content_redacted, metadata, created_at)
     VALUES ($1, 'user', 'text', $2, $3, $4::jsonb, now() + interval '500 seconds')
     RETURNING message_id`,
    [sessionId, RAW, redacted, metadata ? JSON.stringify(metadata) : null],
  );
  return String(rows[0].message_id);
}

const featureRows = async (sessionId: string) =>
  (await q(`SELECT * FROM session_features WHERE session_id = $1 ORDER BY feature_row_id`, [sessionId])).rows;

const waitingMine = async () =>
  (await getSessionsNeedingFeatures(SESSION_FEATURE_SET_VERSION)).filter((id) => id.startsWith(tag)).sort();

describe.skipIf(!LIVE)('session features against a scratch Postgres (ai-therapist-172)', () => {
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
    await user('later'); // withdraws after their session is coded
    await user('therapist', { role: 'therapist' });
    await user('researcher', { role: 'researcher' });
    await user('caseworker', { role: 'caseworker' });
    await user('demo', { role: 'demo' });

    // p enrolled 10 days before the "good" session: that session is in study week 2.
    await q(
      `INSERT INTO qualtrics_signups (response_id, survey_id, user_id, registered_at)
       VALUES ($1, 'SV_test', $2, '2026-11-01T00:00:00Z')`,
      [`R_${tag}`, users.p],
    );
    await q(`INSERT INTO research_pseudonyms (entity_type, entity_key, pseudonym) VALUES ('participant', $1, $2)`, [
      String(users.p),
      `PF${stamp}`,
    ]);

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
    await q(`DELETE FROM research_pseudonyms WHERE pseudonym = $1`, [`PF${stamp}`]);
    await q(`DELETE FROM qualtrics_signups WHERE response_id LIKE $1`, [`R_${tag}%`]);
    await q(`DELETE FROM redaction_review_log WHERE reviewed_by = $1`, [users.researcher]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`${tag}_%`]);
    await q(`DELETE FROM organizations WHERE slug = $1`, [tag]);
    await pool.end();
  });

  it('the migration seeds the switch off', async () => {
    expect(await getSessionFeaturesConfig()).toEqual({ enabled: false });
    const { rows } = await q(`SELECT config_value FROM system_config WHERE config_key = 'session_features'`);
    expect(rows[0].config_value).toEqual({ enabled: false });
  });

  // ---------------------------------------------------------------- eligibility

  it('eligibility: an ended session of an enrolled participant with redaction complete, nothing else', async () => {
    const eligible: Record<string, boolean> = {};
    for (const [name, id] of Object.entries(s)) eligible[name] = await isSessionJudgeEligible(id);
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

  it('the backfill list is exactly the eligible, uncoded sessions', async () => {
    expect(await waitingMine()).toEqual([s.good, s.short, s.wiped, s.late, s.leak, s.race, s.paused, s.later].sort());
  });

  it('an ineligible session is never coded, even when asked for by id with force', async () => {
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
      expect(await extractSessionFeatures(s[name], { client, force: true }), name).toEqual({
        outcome: 'skipped',
        reason: 'not_eligible',
      });
    }
    expect(create).not.toHaveBeenCalled();
    expect((await q(`SELECT 1 FROM session_features WHERE session_id LIKE $1`, [`${tag}_%`])).rows).toHaveLength(0);
  });

  // ------------------------------------------------------- what the judge reads

  it('the judge receives redacted text only: no raw content, no muted-microphone turn', async () => {
    const { client, create } = fakeClient();
    const result = await extractSessionFeatures(s.good, { client });
    expect(result.outcome).toBe('stored');
    const transcript = transcriptSent(create);
    expect(transcript).toContain('[REDACTED: NAME]');
    expect(transcript).not.toContain('RAWSECRET');
    expect(transcript).not.toContain('Zebediah');
    expect(transcript).not.toContain('PHANTOM');
    expect(transcript.split('\n')).toHaveLength(8);
  });

  it('stores one JSON object of answers and what it was computed from; unknown and uncertain are their own states', async () => {
    const rows = await featureRows(s.good);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({
      feature_set_version: SESSION_FEATURE_SET_VERSION,
      status: 'extracted',
      unknown_count: 1,
      model: 'gpt-6-luna',
      tokens_in: 5678,
      tokens_out: 0,
      participant_turns: 4,
      transcript_messages: 8,
      transcript_truncated: false,
      error: null,
    });
    expect(Object.keys(r.features).sort()).toEqual(SESSION_FEATURES.map((f) => f.name).sort());
    expect(r.features.topic_sleep).toEqual({ kind: 'predicate', p: 0.97, present: true });
    expect(r.features.topic_low_mood).toEqual({ kind: 'predicate', p: 0.02, present: false });
    // In the uncertain band: the probability is kept, the answer is null.
    expect(r.features.topic_family).toEqual({ kind: 'predicate', p: 0.5, present: null });
    // Refused: unknown, not absent.
    expect(r.features.topic_substance_use).toEqual({ kind: 'unknown', reason: 'refused' });
    expect(r.features.followup_status).toMatchObject({ kind: 'choice', value: 'not_done', confidence: 0.85 });
    expect(r.transcript_fingerprint).toMatch(/^[0-9a-f]{32}$/);
    // No column of the row holds transcript text.
    expect(JSON.stringify(r)).not.toContain('REDACTED');
    expect(JSON.stringify(r)).not.toContain('worksheet');
    expect((await getLatestSessionFeatures(s.good))?.stale).toBe(false);
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
    expect(await isSessionJudgeEligible(s.leak)).toBe(true);

    const first = fakeClient();
    expect((await extractSessionFeatures(s.leak, { client: first.client })).outcome).toBe('stored');
    const transcript = transcriptSent(first.create);
    expect(transcript).toContain('REVIEWEDOK');
    expect(transcript).toContain('PASSTHROUGHOK');
    expect(transcript).not.toContain('FLAGGEDLEAK');
    expect(transcript).not.toContain('ERROREDLEAK');
    expect(transcript).not.toContain('OUTAGELEAK');
    expect(transcript.split('\n')).toHaveLength(10);
    expect((await featureRows(s.leak))[0].transcript_messages).toBe(10);
    expect((await getLatestSessionFeatures(s.leak))?.stale).toBe(false);

    // A researcher approves the flagged message (the real review write): it is
    // released to the judge, so the stored row is stale, and two messages of
    // the session still wait for review.
    expect(await recordRedactionApproval(flaggedId, users.researcher)).toBe(true);
    expect((await getLatestSessionFeatures(s.leak))?.stale).toBe(true);
    expect(await getLeakReviewStateForMessage(flaggedId)).toEqual({ sessionId: s.leak, awaitingReview: 2 });
    expect(await waitingMine()).toContain(s.leak);

    // Coded again without force: the released message is now read, the row is replaced.
    const second = fakeClient();
    expect((await extractSessionFeatures(s.leak, { client: second.client })).outcome).toBe('stored');
    expect(transcriptSent(second.create)).toContain('FLAGGEDLEAK');
    expect(transcriptSent(second.create)).not.toContain('ERROREDLEAK');
    const rows = await featureRows(s.leak);
    expect(rows).toHaveLength(1);
    expect(rows[0].transcript_messages).toBe(11);
    expect((await getLatestSessionFeatures(s.leak))?.stale).toBe(false);
  });

  // -------------------------------------------------------------- constraints

  it('the table refuses every row shape the job must never write', async () => {
    const insert = (
      status: string,
      c: { features?: string; unknown?: string; model?: string; tokensIn?: string; error?: string } = {},
    ) =>
      q(
        `INSERT INTO session_features
           (session_id, feature_set_version, status, transcript_messages, transcript_fingerprint,
            features, unknown_count, model, tokens_in, error)
         VALUES ($1, 'constraint-test', '${status}', 8, 'x',
                 ${c.features ?? 'NULL'}, ${c.unknown ?? 'NULL'}, ${c.model ?? 'NULL'}, ${c.tokensIn ?? 'NULL'}, ${c.error ?? 'NULL'})`,
        [s.good],
      );
    const obj = `'{"topic_sleep": {"kind": "predicate", "p": 0.9, "present": true}}'::jsonb`;
    const bad: Array<[string, () => Promise<unknown>]> = [
      ['an unknown status', () => insert('rated', { features: obj, unknown: '0', model: `'m'` })],
      ['an extracted row with no features', () => insert('extracted', { unknown: '0', model: `'m'` })],
      [
        'an extracted row with an empty object',
        () => insert('extracted', { features: `'{}'`, unknown: '0', model: `'m'` }),
      ],
      ['features that are an array', () => insert('extracted', { features: `'[1,2]'`, unknown: '0', model: `'m'` })],
      ['features that are a string', () => insert('extracted', { features: `'"text"'`, unknown: '0', model: `'m'` })],
      ['an extracted row with no unknown count', () => insert('extracted', { features: obj, model: `'m'` })],
      ['a negative unknown count', () => insert('extracted', { features: obj, unknown: '-1', model: `'m'` })],
      ['an extracted row with no model', () => insert('extracted', { features: obj, unknown: '0' })],
      [
        'an extracted row with an error text',
        () => insert('extracted', { features: obj, unknown: '0', model: `'m'`, error: `'boom'` }),
      ],
      ['a too_short row with features', () => insert('too_short', { features: obj })],
      ['a too_short row with an unknown count', () => insert('too_short', { unknown: '0' })],
      ['a too_short row with a model', () => insert('too_short', { model: `'m'` })],
      ['a too_short row with tokens', () => insert('too_short', { tokensIn: '10' })],
      ['a too_short row with an error text', () => insert('too_short', { error: `'boom'` })],
      ['an errored row with features', () => insert('errored', { features: obj, error: `'boom'` })],
      ['an errored row with an unknown count', () => insert('errored', { unknown: '0', error: `'boom'` })],
      ['an errored row with no error text', () => insert('errored')],
    ];
    for (const [label, attempt] of bad) {
      await expect(attempt(), label).rejects.toThrow(/violates check constraint/);
    }
    // The shapes the job does write are accepted (then removed).
    await insert('extracted', { features: obj, unknown: '0', model: `'m'`, tokensIn: '10' });
    await q(`DELETE FROM session_features WHERE feature_set_version = 'constraint-test'`);
    await insert('too_short');
    await q(`DELETE FROM session_features WHERE feature_set_version = 'constraint-test'`);
    await insert('errored', { model: `'m'`, error: `'boom'` });
    await q(`DELETE FROM session_features WHERE feature_set_version = 'constraint-test'`);
    // The fingerprint is required: a row cannot be written without its basis.
    await expect(
      q(
        `INSERT INTO session_features (session_id, feature_set_version, status, error) VALUES ($1, 'c2', 'errored', 'x')`,
        [s.good],
      ),
    ).rejects.toThrow(/not-null/);
    // One row per session and version.
    await expect(
      q(
        `INSERT INTO session_features (session_id, feature_set_version, status, transcript_messages, transcript_fingerprint)
         VALUES ($1, $2, 'too_short', 2, 'x')`,
        [s.good, SESSION_FEATURE_SET_VERSION],
      ),
    ).rejects.toThrow(/duplicate key/);
    // And no row without its session.
    await expect(
      q(
        `INSERT INTO session_features (session_id, feature_set_version, status, transcript_messages, transcript_fingerprint)
         VALUES ('no-such-session', 'c3', 'too_short', 2, 'x')`,
      ),
    ).rejects.toThrow(/foreign key/);
  });

  // ------------------------------------------------------------------ outcomes

  it('a too-short session is stored with no values and no model call', async () => {
    const { client, create } = fakeClient();
    await extractSessionFeatures(s.short, { client });
    expect(create).not.toHaveBeenCalled();
    expect((await featureRows(s.short))[0]).toMatchObject({
      status: 'too_short',
      features: null,
      unknown_count: null,
      model: null,
      tokens_in: null,
      transcript_messages: 2,
    });
  });

  it('a failed judge call is stored as errored, listed again, and replaced by the next answer', async () => {
    const failing = fakeClient(async () => Promise.reject(new Error('503 upstream')));
    await extractSessionFeatures(s.wiped, { client: failing.client });
    let rows = await featureRows(s.wiped);
    expect(rows[0]).toMatchObject({ status: 'errored', features: null, error: '503 upstream' });
    expect(await waitingMine()).toContain(s.wiped);
    expect(
      (await getSessionsNeedingFeatures(SESSION_FEATURE_SET_VERSION, { includeErrored: false })).includes(s.wiped),
    ).toBe(false);

    // A response in which every variable is refused is no answer either.
    const refusing = fakeClient(async () => ({
      answers: SESSION_FEATURES.map((f) => ({ type: 'refusal', name: f.name })),
    }));
    await extractSessionFeatures(s.wiped, { client: refusing.client });
    expect((await featureRows(s.wiped))[0]).toMatchObject({ status: 'errored', features: null });

    // The backfill goes through every waiting session in the database; only
    // this file's rows exist in a scratch database built for it.
    const ok = fakeClient();
    const summary = await backfillSessionFeatures({ client: ok.client });
    expect(summary.errored).toBe(0);
    rows = await featureRows(s.wiped);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'extracted', error: null });
    expect(await waitingMine()).toEqual([]);
  });

  it('a second run codes nothing new', async () => {
    const { client, create } = fakeClient();
    expect(await extractSessionFeatures(s.good, { client })).toEqual({
      outcome: 'skipped',
      reason: 'already_extracted',
    });
    expect(await extractSessionFeatures(s.short, { client })).toEqual({
      outcome: 'skipped',
      reason: 'already_extracted',
    });
    const summary = await backfillSessionFeatures({ client });
    expect(summary.candidates).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------- stale rows

  it('a late turn makes the row stale once it is redacted, and the session is coded again', async () => {
    const before = (await featureRows(s.late))[0];
    expect(before).toMatchObject({ status: 'extracted', transcript_messages: 8 });

    // A turn lands after the session was coded, not redacted yet: nothing
    // readable has changed, and the session is not eligible meanwhile.
    const lateId = await addMessage(s.late, null);
    expect((await getLatestSessionFeatures(s.late))?.stale).toBe(false);
    const idle = fakeClient();
    expect(await extractSessionFeatures(s.late, { client: idle.client })).toEqual({
      outcome: 'skipped',
      reason: 'not_eligible',
    });

    // The sweep redacts it: the stored row no longer covers the transcript.
    await q(`UPDATE messages SET content_redacted = 'LATETURN and one more thing I forgot' WHERE message_id = $1`, [
      lateId,
    ]);
    expect((await getLatestSessionFeatures(s.late))?.stale).toBe(true);
    expect(await waitingMine()).toEqual([s.late]);

    // The hook's call (no force): coded again, same version, the row replaced.
    const again = fakeClient();
    expect((await extractSessionFeatures(s.late, { client: again.client })).outcome).toBe('stored');
    expect(again.create).toHaveBeenCalledTimes(1);
    expect(transcriptSent(again.create)).toContain('LATETURN');
    const rows = await featureRows(s.late);
    expect(rows).toHaveLength(1);
    expect(rows[0].feature_row_id).toBe(before.feature_row_id);
    expect(rows[0]).toMatchObject({ status: 'extracted', transcript_messages: 9, participant_turns: 5 });
    expect(rows[0].transcript_fingerprint).not.toBe(before.transcript_fingerprint);
    expect(new Date(rows[0].extracted_at).getTime()).toBeGreaterThanOrEqual(new Date(before.extracted_at).getTime());
    expect((await getLatestSessionFeatures(s.late))?.stale).toBe(false);
    expect(await waitingMine()).toEqual([]);
  });

  it('a re-redaction, a leak-review correction and a later leak flag make the row stale too', async () => {
    const { rows: msgs } = await q(
      `SELECT message_id FROM messages WHERE session_id = $1 ORDER BY created_at, message_id LIMIT 2`,
      [s.late],
    );
    await q(`UPDATE messages SET content_redacted = content_redacted || ' REREDACTED' WHERE message_id = $1`, [
      msgs[0].message_id,
    ]);
    expect((await getLatestSessionFeatures(s.late))?.stale).toBe(true);
    const a = fakeClient();
    expect((await extractSessionFeatures(s.late, { client: a.client })).outcome).toBe('stored');
    expect(transcriptSent(a.create)).toContain('REREDACTED');
    expect((await getLatestSessionFeatures(s.late))?.stale).toBe(false);

    // A researcher's correction in the leak-review tool (the real write).
    expect(await updateRedactedContent(String(msgs[1].message_id), 'CORRECTED by a researcher', users.researcher)).toBe(
      true,
    );
    expect((await getLatestSessionFeatures(s.late))?.stale).toBe(true);
    const b = fakeClient();
    expect((await extractSessionFeatures(s.late, { client: b.client })).outcome).toBe('stored');
    expect(transcriptSent(b.create)).toContain('CORRECTED by a researcher');

    // A later leak-check flag takes a message away from the judge: stale again.
    await q(
      `UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb)
              || '{"redaction_check": {"status": "checked", "flagged": true, "p_leak": 0.9}}'::jsonb
        WHERE message_id = $1`,
      [msgs[0].message_id],
    );
    expect((await getLatestSessionFeatures(s.late))?.stale).toBe(true);
    const c = fakeClient();
    expect((await extractSessionFeatures(s.late, { client: c.client })).outcome).toBe('stored');
    expect(transcriptSent(c.create)).not.toContain('REREDACTED');
    expect((await featureRows(s.late))[0].transcript_messages).toBe(8);
  });

  // ---------------------------------------------- the upsert rule and the claim

  it('an errored result never replaces an answer; it does replace an earlier errored row', async () => {
    const stored = (await getSessionFeatures(s.race, SESSION_FEATURE_SET_VERSION))!;
    expect(stored.status).toBe('extracted');
    const errored = {
      sessionId: s.race,
      featureSetVersion: SESSION_FEATURE_SET_VERSION,
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
    // one (a failed re-run of a stale answer): refused either way, in SQL.
    expect(await upsertSessionFeatures(errored)).toBeNull();
    expect(await upsertSessionFeatures({ ...errored, transcriptFingerprint: 'another-transcript' })).toBeNull();
    expect((await featureRows(s.race))[0]).toEqual(
      (await q(`SELECT * FROM session_features WHERE feature_row_id = $1`, [stored.feature_row_id])).rows[0],
    );
    expect((await getSessionFeatures(s.race, SESSION_FEATURE_SET_VERSION))!).toEqual(stored);

    // A too_short answer is an answer too.
    const shortBefore = (await featureRows(s.short))[0];
    expect(await upsertSessionFeatures({ ...errored, sessionId: s.short })).toBeNull();
    expect((await featureRows(s.short))[0]).toEqual(shortBefore);

    // Under another version there is no answer yet: the errored row is stored,
    // a later errored attempt replaces it, and an answer replaces that.
    const v = { ...errored, featureSetVersion: 'upsert-rule-test' };
    expect((await upsertSessionFeatures(v))?.error).toBe('the second, failing run');
    expect((await upsertSessionFeatures({ ...v, error: 'failed again' }))?.error).toBe('failed again');
    const answered = await upsertSessionFeatures({ ...v, status: 'too_short', error: null, model: null });
    expect(answered).toMatchObject({ status: 'too_short', error: null });
    expect(await upsertSessionFeatures(v)).toBeNull();
    await q(`DELETE FROM session_features WHERE feature_set_version = 'upsert-rule-test'`);
  });

  it('a failed forced re-run leaves the stored row exactly as it was', async () => {
    const before = (await featureRows(s.race))[0];
    const failing = fakeClient(async () => Promise.reject(new Error('503 upstream')));
    expect(await extractSessionFeatures(s.race, { client: failing.client, force: true })).toEqual({
      outcome: 'skipped',
      reason: 'kept_existing',
    });
    expect(failing.create).toHaveBeenCalledTimes(1);
    expect((await featureRows(s.race))[0]).toEqual(before);
  });

  it('two overlapping runs for one session make one judge call; the alliance claim is a different lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = fakeClient(async () => {
      await gate;
      return goodResponse();
    });
    const other = fakeClient();
    const first = extractSessionFeatures(s.race, { client: slow.client, force: true });
    await vi.waitFor(() => expect(slow.create).toHaveBeenCalledTimes(1));
    expect(await extractSessionFeatures(s.race, { client: other.client, force: true })).toEqual({
      outcome: 'skipped',
      reason: 'in_progress',
    });
    expect(other.create).not.toHaveBeenCalled();
    // While the features claim is held, an alliance rating of the same
    // session and the same version string is not blocked by it.
    expect(await withAllianceRatingClaim(s.race, SESSION_FEATURE_SET_VERSION, async () => 'alliance free')).toEqual({
      acquired: true,
      result: 'alliance free',
    });
    release();
    expect((await first).outcome).toBe('stored');
    // The claim is released afterwards, and when the work throws.
    expect(await withSessionFeaturesClaim(s.race, SESSION_FEATURE_SET_VERSION, async () => 'free')).toEqual({
      acquired: true,
      result: 'free',
    });
    await expect(
      withSessionFeaturesClaim(s.race, SESSION_FEATURE_SET_VERSION, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await withSessionFeaturesClaim(s.race, SESSION_FEATURE_SET_VERSION, async () => 1)).acquired).toBe(true);
  });

  // ---------------------------------------------------------------- withdrawal

  it('a participant who withdraws after extraction is not coded again; the stored row stays', async () => {
    expect((await featureRows(s.later))[0].status).toBe('extracted');
    await q(`UPDATE users SET study_status = 'withdrawn' WHERE userid = $1`, [users.later]);
    await addMessage(s.later, 'a late turn after the withdrawal');
    expect(await isSessionJudgeEligible(s.later)).toBe(false);
    expect(await waitingMine()).not.toContain(s.later);
    const { client, create } = fakeClient();
    expect(await extractSessionFeatures(s.later, { client, force: true })).toEqual({
      outcome: 'skipped',
      reason: 'not_eligible',
    });
    expect(create).not.toHaveBeenCalled();
    expect(await featureRows(s.later)).toHaveLength(1);
  });

  // -------------------------------------------------------------------- export

  it('the export row has one pair of columns per variable, the pseudonyms, the study week and the stale flag', async () => {
    await q(
      `INSERT INTO research_pseudonyms (entity_type, entity_key, pseudonym) VALUES
         ('session', $1, $2), ('session', $3, $4), ('session', $5, $6)`,
      [s.good, `SF${stamp}A`, s.later, `SF${stamp}B`, s.short, `SF${stamp}C`],
    );
    const all = await getSessionFeaturesExport('2099-01-01T00:00:00Z');
    const rows = all.filter((r) => r.session_pseudo_id === `SF${stamp}A`);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      participant_id: `PF${stamp}`,
      session_started_at: '2026-11-11T12:00:00Z',
      study_week: 2,
      feature_set_version: SESSION_FEATURE_SET_VERSION,
      status: 'extracted',
      model: 'gpt-6-luna',
      topic_sleep: true,
      topic_sleep_p: 0.97,
      topic_low_mood: false,
      topic_low_mood_p: 0.02,
      // Uncertain: no answer, the probability kept.
      topic_family: null,
      topic_family_p: 0.5,
      // Unknown: both empty, never false or 0.
      topic_substance_use: null,
      topic_substance_use_p: null,
      followup_status: 'not_done',
      followup_status_confidence: 0.85,
      rupture_outcome: 'none',
      unknown_count: 1,
      participant_turns: 4,
      stale: false,
    });
    for (const f of SESSION_FEATURES) {
      expect(Object.keys(row), f.name).toContain(f.name);
      expect(Object.keys(row), f.name).toContain(f.type === 'predicate' ? `${f.name}_p` : `${f.name}_confidence`);
    }
    for (const hidden of ['session_id', 'features', 'error', 'transcript_fingerprint', 'feature_row_id']) {
      expect(Object.keys(row)).not.toContain(hidden);
    }
    // A stored row whose transcript has changed since is exported, marked stale.
    expect(all.find((r) => r.session_pseudo_id === `SF${stamp}B`)).toMatchObject({ status: 'extracted', stale: true });
    // A too_short row is exported with every variable empty: not coded, not absent.
    const short = all.find((r) => r.session_pseudo_id === `SF${stamp}C`)!;
    expect(short).toMatchObject({ status: 'too_short', topic_sleep: null, topic_sleep_p: null, followup_status: null });
    // A session with no pseudonym (out of the export's scope) has no row.
    expect(all.some((r) => r.session_pseudo_id === null)).toBe(false);
  });

  it('a row stored under an older feature set exports empty cells for variables it does not hold', async () => {
    await q(
      `INSERT INTO session_features
         (session_id, feature_set_version, status, features, unknown_count, transcript_messages, transcript_fingerprint, model)
       VALUES ($1, 'features-v0', 'extracted', '{"topic_sleep": {"kind": "predicate", "p": 0.1, "present": false}}'::jsonb,
               0, 8, 'older', 'gpt-6-luna')`,
      [s.good],
    );
    const rows = (await getSessionFeaturesExport('2099-01-01T00:00:00Z')).filter(
      (r) => r.session_pseudo_id === `SF${stamp}A`,
    );
    expect(rows.map((r) => r.feature_set_version)).toEqual(['features-v0', SESSION_FEATURE_SET_VERSION]);
    expect(rows[0]).toMatchObject({ topic_sleep: false, topic_sleep_p: 0.1, topic_family: null, topic_family_p: null });
    expect(rows[0].stale).toBe(true);
    await q(`DELETE FROM session_features WHERE feature_set_version = 'features-v0'`);
  });

  it('the export honours the as-of date for the session and for the extraction', async () => {
    const mine = (rows: Array<Record<string, unknown>>) =>
      rows.filter((r) => r.session_pseudo_id === `SF${stamp}A`).map((r) => r.session_pseudo_id);
    // Session "good" started 2026-11-11 but was coded just now: as of the day
    // after the session there was no row yet.
    expect(mine(await getSessionFeaturesExport('2026-11-12T00:00:00Z'))).toEqual([]);
    // Before the session started: nothing either.
    expect(mine(await getSessionFeaturesExport('2026-11-10T00:00:00Z'))).toEqual([]);
    // A row computed in the past is in an export as of a later date.
    await q(`UPDATE session_features SET extracted_at = '2026-11-11T13:00:00Z' WHERE session_id = $1`, [s.good]);
    expect(mine(await getSessionFeaturesExport('2026-11-12T00:00:00Z'))).toEqual([`SF${stamp}A`]);
    expect(mine(await getSessionFeaturesExport('2026-11-11T12:30:00Z'))).toEqual([]);
  });

  it('deleting the session deletes its features row', async () => {
    await q(`DELETE FROM therapy_sessions WHERE session_id = $1`, [s.short]);
    const { rows } = await q(`SELECT 1 FROM session_features WHERE session_id = $1`, [s.short]);
    expect(rows).toHaveLength(0);
  });
});
