// One "Yes" pages the on-call once: the replay of crisisPaging.handoffYes.test.ts
// against the REAL paging SQL (db/paging.queries) on a throwaway Postgres, so
// the folding decision is read back from rows actually written. Skipped
// unless asked for:
//
//   PAGING_SQL_DATABASE_URL=postgresql://.../rt_scratch_db \
//     npx vitest run src/server/services/crisisPaging.handoffYes.live.test.ts
//
// Same guard as db/paging.queries.live.test.ts: the database name must start
// with `rt_` or contain `scratch`. The pager is a mock that reports DELIVERED;
// nothing here can text anyone. Rows are written under a throwaway user and
// deleted afterwards.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

const { holder, pagerCalls } = vi.hoisted(() => ({
  holder: { pool: null as unknown },
  pagerCalls: [] as string[],
}));
vi.mock('../config/db.js', () => ({
  get pool() {
    return holder.pool;
  },
}));
vi.mock('./crisisAlert.service.js', async () =>
  (await import('../testing/alertMock.js')).alertModuleMock(async (message: string) => {
    pagerCalls.push(message);
    return true;
  }),
);
vi.mock('./suppression.js', () => ({ sessionSuppressesCrisisPaging: vi.fn(async () => false) }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn(async () => undefined) }));

const { pageHighRisk, _resetPagingStateForTests } = await import('./crisisPaging.service.js');

const tag = `yesreplay_${Date.now().toString(36)}`;
let pool: pg.Pool;
let userId = 0;
let n = 0;

async function chatSession(): Promise<string> {
  const id = `${tag}_chat_${n++}`;
  await pool.query(`INSERT INTO therapy_sessions (session_id, user_id, session_type) VALUES ($1, $2, 'chat')`, [
    id,
    userId,
  ]);
  return id;
}

describe.skipIf(!LIVE)('one "Yes" after a crisis hand-off, real paging SQL', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL_, max: 4 });
    holder.pool = pool;
    const org = await pool.query('SELECT org_id FROM organizations ORDER BY org_id LIMIT 1');
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, role, organization_id) VALUES ($1, 'x', 'participant', $2)
       RETURNING userid`,
      [`${tag}_u`, org.rows[0].org_id],
    );
    userId = rows[0].userid as number;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM therapy_sessions WHERE session_id LIKE $1`, [`${tag}_%`]);
    await pool.query(`DELETE FROM users WHERE username LIKE $1`, [`${tag}_%`]);
    await pool.end();
  });

  beforeEach(async () => {
    pagerCalls.length = 0;
    // A fresh process each time, and no earlier page for the participant.
    _resetPagingStateForTests();
    await pool.query(
      `DELETE FROM intervention_actions WHERE session_id IN (SELECT session_id FROM therapy_sessions WHERE user_id = $1)`,
      [userId],
    );
  });

  it('pipeline page, then escalate_to_human 3 s later: one text, the second folded into it', async () => {
    const chat = await chatSession();
    const first = await pageHighRisk(chat, 85, { trigger: 'high_turn_in_recovery_session' });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const second = await pageHighRisk(chat, 80, { source: 'model_escalation' });
    expect(pagerCalls).toHaveLength(1);
    expect(first.outcome).toBe('paged');
    expect(second).toMatchObject({ outcome: 'folded', foldedIntoActionId: first.actionId });
    const { rows } = await pool.query(
      `SELECT action_type, action_details #>> '{paging,decision}' AS decision
         FROM intervention_actions WHERE session_id = $1 ORDER BY action_id`,
      [chat],
    );
    expect(rows).toEqual([
      { action_type: 'crisis_sms_alert', decision: 'paged' },
      { action_type: 'external_api_called', decision: 'folded' },
    ]);
  }, 15_000);

  it('the same two requests with no gap at all (the in-process ledger, before any row is written): one text', async () => {
    const chat = await chatSession();
    const results = await Promise.all([
      pageHighRisk(chat, 85, { trigger: 'high_turn_in_recovery_session' }),
      pageHighRisk(chat, 80, { source: 'model_escalation' }),
    ]);
    expect(pagerCalls).toHaveLength(1);
    expect(results.map((r) => r.outcome).sort()).toEqual(['folded', 'paged']);
  });

  it('after a restart between the two (no ledger, only the stored row): still one text', async () => {
    const chat = await chatSession();
    await pageHighRisk(chat, 85, { trigger: 'high_turn_in_recovery_session' });
    _resetPagingStateForTests();
    const second = await pageHighRisk(chat, 80, { source: 'model_escalation' });
    expect(pagerCalls).toHaveLength(1);
    expect(second.outcome).toBe('folded');
  });
});
