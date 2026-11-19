// The leak-check states (ai-therapist-288) against a REAL Postgres: the review
// queue order, the backlog counts, the semantic-search gate and the recheck
// listing, run on actual jsonb rows in every shape the verifier has written
// (checked clean, checked flagged, errored with status, errored from before
// the status field as in the ai-therapist-284 outage, reviewed, never checked).
// Skipped unless asked for:
//
//   LEAKCHECK_SQL_DATABASE_URL=postgresql://.../rt_scratch_db \
//     npx vitest run src/server/db/leakCheck.queries.live.test.ts
//
// The database must be a THROWAWAY one at the migration head
// (src/database/scripts/migrateFromScratch.ts). The file refuses any database
// whose name does not start with `rt_` or contain `scratch`. It writes rows
// under one throwaway user and deletes them afterwards. No OpenAI call: the
// recheck test passes a fake verifier.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';

const URL_ = process.env.LEAKCHECK_SQL_DATABASE_URL ?? '';
const dbName = (() => {
  try {
    return new URL(URL_).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();
const LIVE = URL_ !== '' && (dbName.startsWith('rt_') || dbName.includes('scratch'));

const { holder } = vi.hoisted(() => ({ holder: { pool: null as unknown } }));
vi.mock('../config/db.js', () => ({
  get pool() {
    return holder.pool;
  },
}));

const { getRandomRedactedMessages, countLeakCheckBacklog, recordRedactionApproval } = await import(
  './redaction.queries.js'
);
const { redactionCompleteSql } = await import('./semanticSearch.queries.js');
const { listErroredLeakChecks, recheckErroredLeakChecks } = await import('../services/leakCheckRecheck.service.js');

const tag = `leakchk_${Date.now().toString(36)}`;
let pool: pg.Pool;
let orgId = 0;
let sessionId = '';
const ids: Record<string, number> = {};
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const CHECKED = { backend: 'decisions', model: 'gpt-6-luna', checked_at: '2026-11-19T00:00:00.000Z' };
const SHAPES: Record<string, Record<string, unknown> | null> = {
  clean: { status: 'checked', p_leak: 0.02, flagged: false, ...CHECKED },
  flagged: { status: 'checked', p_leak: 0.91, flagged: true, ...CHECKED },
  flaggedReviewed: { status: 'checked', p_leak: 0.91, flagged: true, reviewed: true, ...CHECKED },
  errored: { status: 'errored', p_leak: -1, flagged: null, ...CHECKED, model: 'n/a', error: 'timeout' },
  // What every row of the ai-therapist-284 outage looks like.
  outage284: {
    p_leak: -1,
    flagged: false,
    ...CHECKED,
    model: 'n/a',
    error: '400 Missing required parameter: questions.',
  },
  erroredReviewed: { status: 'errored', p_leak: -1, flagged: null, ...CHECKED, error: 'x', reviewed: true },
  neverChecked: null,
};

describe.skipIf(!LIVE)('leak-check states against a scratch Postgres (ai-therapist-288)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL_, max: 4 });
    holder.pool = pool;
    // An organization of its own, so the org-scoped counts are exact.
    orgId = (
      await q(`INSERT INTO organizations (slug, name, kind) VALUES ($1, $1, 'practice') RETURNING org_id`, [tag])
    ).rows[0].org_id as number;
    const user = await q(
      `INSERT INTO users (username, password, role, organization_id) VALUES ($1, 'x', 'participant', $2)
       RETURNING userid`,
      [`${tag}_p`, orgId],
    );
    sessionId = `${tag}_s`;
    await q(`INSERT INTO therapy_sessions (session_id, user_id, status) VALUES ($1, $2, 'ended')`, [
      sessionId,
      user.rows[0].userid,
    ]);
    for (const [name, check] of Object.entries(SHAPES)) {
      const { rows } = await q(
        `INSERT INTO messages (session_id, role, message_type, content, content_redacted, metadata)
         VALUES ($1, 'user', 'text', 'raw text', $2, $3::jsonb) RETURNING message_id`,
        [sessionId, `redacted ${name}`, JSON.stringify(check ? { redaction_check: check } : {})],
      );
      ids[name] = Number(rows[0].message_id);
    }
  });

  afterAll(async () => {
    if (!pool) return;
    await q(`DELETE FROM redaction_review_log WHERE message_id = ANY($1::bigint[])`, [Object.values(ids)]);
    await q(`DELETE FROM messages WHERE session_id = $1`, [sessionId]);
    await q(`DELETE FROM therapy_sessions WHERE session_id = $1`, [sessionId]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`${tag}_%`]);
    await q(`DELETE FROM organizations WHERE slug = $1`, [tag]);
    await pool.end();
  });

  const mine = (rows: Array<Record<string, unknown>>) =>
    rows.map((r) => Number(r.message_id)).filter((id) => Object.values(ids).includes(id));

  it('counts flagged and errored unreviewed rows separately; both shapes of errored count, reviewed rows do not', async () => {
    expect(await countLeakCheckBacklog(orgId)).toEqual({ flaggedUnreviewed: 1, erroredUnreviewed: 2 });
  });

  it('the review queue lists flagged first, then both errored rows, then the rest', async () => {
    const rows = mine(await getRandomRedactedMessages(orgId));
    expect(rows[0]).toBe(ids.flagged);
    expect(new Set(rows.slice(1, 3))).toEqual(new Set([ids.errored, ids.outage284]));
  });

  it('semantic search admits clean, reviewed and never-checked rows only', async () => {
    const { rows } = await q(
      `SELECT m.message_id FROM messages m WHERE m.session_id = $1 AND ${redactionCompleteSql('m')}
        ORDER BY m.message_id`,
      [sessionId],
    );
    expect(rows.map((r) => Number(r.message_id)).sort()).toEqual(
      [ids.clean, ids.flaggedReviewed, ids.erroredReviewed, ids.neverChecked].sort(),
    );
  });

  it('the recheck listing finds both errored shapes and, with --include-reviewed, the reviewed one', async () => {
    const unreviewed = await listErroredLeakChecks({ sessionId });
    expect(unreviewed.map((r) => r.message_id).sort()).toEqual([ids.errored, ids.outage284].sort());
    expect(unreviewed.find((r) => r.message_id === ids.outage284)?.error).toMatch(/Missing required parameter/);
    const all = await listErroredLeakChecks({ sessionId, includeReviewed: true });
    expect(all).toHaveLength(3);
    expect(await listErroredLeakChecks({ sessionId, limit: 1 })).toHaveLength(1);
  });

  it('recheck sends only unreviewed errored rows, with their redacted text, to the verifier', async () => {
    const verify = vi.fn(async (_s: string, items: Array<{ id: number; text: string }>) => ({
      checked: items.length,
      flagged: 0,
      errored: 0,
    }));
    const rows = await listErroredLeakChecks({ sessionId, includeReviewed: true });
    const result = await recheckErroredLeakChecks(rows, verify);
    expect(verify).toHaveBeenCalledTimes(1);
    const [sid, items] = verify.mock.calls[0];
    expect(sid).toBe(sessionId);
    expect(items.map((i) => i.id).sort()).toEqual([ids.errored, ids.outage284].sort());
    expect(items.every((i) => i.text.startsWith('redacted '))).toBe(true);
    expect(result).toEqual({ checked: 2, flagged: 0, errored: 0, sessions: 1 });
  });

  it('a researcher approval takes an errored row out of the backlog and through the search gate', async () => {
    const before = await countLeakCheckBacklog(orgId);
    expect(await recordRedactionApproval(String(ids.errored), null)).toBe(true);
    const after = await countLeakCheckBacklog(orgId);
    expect(after.erroredUnreviewed).toBe(before.erroredUnreviewed - 1);
    expect(after.flaggedUnreviewed).toBe(before.flaggedUnreviewed);
    const { rows } = await q(`SELECT 1 FROM messages m WHERE m.message_id = $1 AND ${redactionCompleteSql('m')}`, [
      ids.errored,
    ]);
    expect(rows).toHaveLength(1);
  });
});
