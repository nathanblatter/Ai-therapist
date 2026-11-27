// The alliance-rating job against a REAL Postgres (ai-therapist-173): which
// sessions are eligible, that only redacted text reaches the judge, what is
// stored for each outcome, the export row and its study week, and that the
// rating goes when the session goes. Skipped unless asked for:
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
const { getSessionsNeedingAllianceRating, isSessionAllianceEligible } = await import(
  '../db/allianceRatings.queries.js'
);
const { getAllianceRatingsExport } = await import('../db/datasetExport.queries.js');

const tag = `alli_${Date.now().toString(36)}`;
let pool: pg.Pool;
let orgId = 0;
let participantId = 0;
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
      opts.userId === undefined ? participantId : opts.userId,
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

describe.skipIf(!LIVE)('alliance ratings against a scratch Postgres (ai-therapist-173)', () => {
  const s: Record<string, string> = {};

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL_, max: 4 });
    holder.pool = pool;
    orgId = (
      await q(`INSERT INTO organizations (slug, name, kind) VALUES ($1, $1, 'practice') RETURNING org_id`, [tag])
    ).rows[0].org_id as number;
    const user = async (suffix: string, sandbox = false) =>
      (
        await q(
          `INSERT INTO users (username, password, role, organization_id, is_sandbox)
           VALUES ($1, 'x', 'participant', $2, $3) RETURNING userid`,
          [`${tag}_${suffix}`, orgId, sandbox],
        )
      ).rows[0].userid as number;
    participantId = await user('p');
    const sandboxId = await user('sb', true);
    // Enrolled 10 days before the "good" session: that session is in study week 2.
    await q(
      `INSERT INTO qualtrics_signups (response_id, survey_id, user_id, registered_at)
       VALUES ($1, 'SV_test', $2, '2026-11-01T00:00:00Z')`,
      [`R_${tag}`, participantId],
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
    s.sandbox = await addSession('sandbox', { userId: sandboxId });
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
  });

  afterAll(async () => {
    if (!pool) return;
    await q(`DELETE FROM therapy_sessions WHERE session_id LIKE $1`, [`${tag}_%`]);
    await q(`DELETE FROM research_pseudonyms WHERE entity_key LIKE $1`, [`${tag}_%`]);
    await q(`DELETE FROM research_pseudonyms WHERE entity_type = 'participant' AND entity_key = $1`, [
      String(participantId),
    ]);
    await q(`DELETE FROM qualtrics_signups WHERE response_id = $1`, [`R_${tag}`]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`${tag}_%`]);
    await q(`DELETE FROM organizations WHERE slug = $1`, [tag]);
    await pool.end();
  });

  it('the migration seeds the switch off', async () => {
    expect(await getAllianceMarkersConfig()).toEqual({ enabled: false });
  });

  it('eligibility: ended, not demo, not sandbox, redaction complete', async () => {
    const eligible: Record<string, boolean> = {};
    for (const [name, id] of Object.entries(s)) eligible[name] = await isSessionAllianceEligible(id);
    expect(eligible).toEqual({
      good: true,
      short: true,
      wiped: true,
      pending: false,
      unredacted: false,
      active: false,
      demo: false,
      sandbox: false,
      empty: false,
    });
  });

  it('the backfill list is exactly the eligible, unrated sessions', async () => {
    const mine = (await getSessionsNeedingAllianceRating(ALLIANCE_JUDGE_VERSION)).filter((id) => id.startsWith(tag));
    expect(mine.sort()).toEqual([s.good, s.short, s.wiped].sort());
  });

  it('the judge receives redacted text only: no raw content, no muted-microphone turn', async () => {
    const { client, create } = fakeClient();
    const result = await rateSessionAlliance(s.good, { client });
    expect(result.outcome).toBe('stored');
    const body = (create.mock.calls[0] as unknown as [{ input: Array<{ content: string }> }])[0];
    const transcript = body.input[1].content;
    expect(transcript).toContain('[REDACTED: NAME]');
    expect(transcript).not.toContain('RAWSECRET');
    expect(transcript).not.toContain('Zebediah');
    expect(transcript).not.toContain('PHANTOM');
    expect(transcript.split('\n')).toHaveLength(8);
  });

  it('stores numbers per subscale; a not-rateable subscale has no score', async () => {
    const { rows } = await q(`SELECT * FROM session_alliance_ratings WHERE session_id = $1`, [s.good]);
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
      transcript_truncated: false,
      error: null,
    });
    expect(r.task_score).toBeCloseTo(4.25, 3);
    expect(r.goal_p_rateable).toBeCloseTo(0.1, 3);
    // No column of the row holds transcript text.
    expect(JSON.stringify(r)).not.toContain('REDACTED');
  });

  it('the table refuses a score on a subscale marked not rateable', async () => {
    await expect(
      q(
        `INSERT INTO session_alliance_ratings (session_id, judge_version, status, task_rateable, task_score)
         VALUES ($1, 'constraint-test', 'rated', FALSE, 1.0)`,
        [s.good],
      ),
    ).rejects.toThrow(/check/i);
  });

  it('a too-short session is stored as not rateable with no model call', async () => {
    const { client, create } = fakeClient();
    await rateSessionAlliance(s.short, { client });
    expect(create).not.toHaveBeenCalled();
    const { rows } = await q(`SELECT * FROM session_alliance_ratings WHERE session_id = $1`, [s.short]);
    expect(rows[0]).toMatchObject({
      status: 'too_short',
      task_rateable: false,
      bond_rateable: false,
      goal_rateable: false,
      task_score: null,
      model: null,
    });
  });

  it('an ineligible session is never rated, even when asked for by id', async () => {
    const { client, create } = fakeClient();
    for (const name of ['pending', 'unredacted', 'active', 'demo', 'sandbox', 'empty']) {
      expect(await rateSessionAlliance(s[name], { client, force: true })).toEqual({
        outcome: 'skipped',
        reason: 'not_eligible',
      });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('a failed judge call is stored as errored, listed again, and replaced by the next answer', async () => {
    const failing = fakeClient(async () => Promise.reject(new Error('503 upstream')));
    await rateSessionAlliance(s.wiped, { client: failing.client });
    let { rows } = await q(`SELECT * FROM session_alliance_ratings WHERE session_id = $1`, [s.wiped]);
    expect(rows[0]).toMatchObject({ status: 'errored', task_rateable: null, task_score: null, error: '503 upstream' });

    const waiting = (await getSessionsNeedingAllianceRating(ALLIANCE_JUDGE_VERSION)).filter((id) => id.startsWith(tag));
    expect(waiting).toEqual([s.wiped]);

    // The backfill goes through every waiting session in the database; only
    // this file's rows exist in a scratch database built for it.
    const ok = fakeClient();
    await backfillAllianceRatings({ client: ok.client });
    ({ rows } = await q(`SELECT * FROM session_alliance_ratings WHERE session_id = $1`, [s.wiped]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'rated', error: null, task_level: 4 });
  });

  it('a second run rates nothing new', async () => {
    const { client, create } = fakeClient();
    expect(await rateSessionAlliance(s.good, { client })).toEqual({ outcome: 'skipped', reason: 'already_rated' });
    expect(create).not.toHaveBeenCalled();
  });

  it('the export row carries the pseudonyms, the study week and numbers only', async () => {
    await q(
      `INSERT INTO research_pseudonyms (entity_type, entity_key, pseudonym) VALUES
         ('session', $1, $3), ('participant', $2, $4)`,
      [s.good, String(participantId), `S${tag}`.slice(0, 20), `P${tag}`.slice(0, 20)],
    );
    const rows = (await getAllianceRatingsExport('2099-01-01T00:00:00Z')).filter(
      (r) => r.session_pseudo_id === `S${tag}`.slice(0, 20),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      participant_id: `P${tag}`.slice(0, 20),
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
    });
    expect(Object.keys(rows[0])).not.toContain('session_id');
    expect(Object.keys(rows[0])).not.toContain('error');
  });

  it('deleting the session deletes its rating', async () => {
    await q(`DELETE FROM therapy_sessions WHERE session_id = $1`, [s.short]);
    const { rows } = await q(`SELECT 1 FROM session_alliance_ratings WHERE session_id = $1`, [s.short]);
    expect(rows).toHaveLength(0);
  });
});
