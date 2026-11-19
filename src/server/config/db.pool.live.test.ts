// The pool's bounds against a REAL Postgres (ai-therapist-366). Skipped unless
// asked for, because it needs a throwaway database:
//
//   DB_POOL_LIVE_DATABASE_URL=postgresql://.../rt_dbpool_<random> \
//     npx vitest run src/server/config/db.pool.live.test.ts
//
// The database must be a THROWAWAY one at the current migration head
// (src/database/scripts/migrateFromScratch.ts) whose name starts with
// `rt_dbpool_`; any other name is refused, so this cannot be pointed at stage
// or at another project's database on the shared server. Everything here is
// small on purpose: pools of 1 or 2 connections and sleeps of about two
// seconds, so the shared server's connection budget is never at risk. It writes
// nothing. The pager is a mock and the model API is a failing fake: nothing
// here can text anyone or spend anything.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { PoolClient } from 'pg';

const URL_ = process.env.DB_POOL_LIVE_DATABASE_URL ?? '';
const dbName = (() => {
  try {
    return new URL(URL_).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();
const LIVE = URL_ !== '' && /^rt_dbpool_[a-z0-9_]+$/.test(dbName);

const { holder, pager } = vi.hoisted(() => ({
  holder: { pool: null as unknown },
  pager: { calls: [] as string[] },
}));

// The crisis services use whatever pool the test installs; createPool and the
// rest of config/db.ts are the real code.
vi.mock('./db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db.js')>();
  return {
    ...real,
    get pool() {
      return holder.pool;
    },
  };
});
vi.mock('../services/crisisAlert.service.js', async () => ({
  ...(await import('../testing/alertMock.js')).alertModuleMock(async (m: string) => {
    pager.calls.push(m);
    return true;
  }),
  reportOpenAIQuotaExhausted: vi.fn(async () => true),
  reportRiskAssessorOutage: vi.fn(async () => true),
}));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: vi.fn(async () => Promise.reject(new Error('model API not used in tests'))) } };
    moderations = { create: vi.fn(async () => Promise.reject(new Error('model API not used in tests'))) };
  },
}));
vi.mock('../services/sidebandManager.service.js', () => ({
  sidebandManager: {
    getActiveConnections: () => [] as string[],
    isConnected: () => false,
    injectMessage: vi.fn(async () => undefined),
    tryInject: vi.fn(async () => false),
  },
}));
vi.mock('../utils/sessionAutoTerminate.js', () => ({
  liftLimitForCrisis: vi.fn(() => ({ lifted: false, previousLimitMinutes: null, ceilingMinutes: 60 })),
}));
vi.mock('../services/adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: vi.fn(async () => null) }));

const { createPool } = await import('./db.js');
const { withLongQueries } = await import('./dbLongQueries.js');
const { dbTimeoutKind } = await import('../utils/dbErrors.js');

type Pool = ReturnType<typeof createPool>;
const pools: Pool[] = [];
function smallPool(over: Partial<Parameters<typeof createPool>[0]> = {}): Pool {
  const pool = createPool(
    {
      max: 2,
      connectionTimeoutMs: 500,
      statementTimeoutMs: 1000,
      idleInTransactionTimeoutMs: 30_000,
      longStatementTimeoutMs: 5000,
      applicationName: 'ai-therapist/dbpool-live-test',
      ...over,
    },
    URL_,
  );
  pools.push(pool);
  return pool;
}

afterEach(() => {
  pager.calls.length = 0;
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
});

describe.skipIf(!LIVE)('app pool bounds against a scratch database', () => {
  beforeAll(async () => {
    const probe = smallPool();
    const { rows } = await probe.query<{ db: string }>('SELECT current_database() AS db');
    // Belt and braces: the connection really is the throwaway database.
    expect(rows[0].db).toBe(dbName);
  });

  it('names the process in pg_stat_activity', async () => {
    const pool = smallPool({ applicationName: 'ai-therapist/dbpool-live-name' });
    const { rows } = await pool.query<{ name: string }>(`SELECT current_setting('application_name') AS name`);
    expect(rows[0].name).toBe('ai-therapist/dbpool-live-name');
  });

  it('an exhausted pool of 2 fails the third request fast, with the acquire timeout', async () => {
    const pool = smallPool();
    const held: PoolClient[] = [await pool.connect(), await pool.connect()];
    try {
      const started = Date.now();
      const err = await pool.query('SELECT 1').catch((e: unknown) => e);
      const waited = Date.now() - started;
      expect(dbTimeoutKind(err)).toBe('acquire');
      expect(waited).toBeGreaterThanOrEqual(450);
      expect(waited).toBeLessThan(2000);
      const err2 = await pool.connect().catch((e: unknown) => e);
      expect(dbTimeoutKind(err2)).toBe('acquire');
      expect(pool.stats().timeouts.acquire).toBe(2);
    } finally {
      held.forEach((c) => c.release());
    }
    // The held connections are fine afterwards.
    await expect(pool.query('SELECT 1')).resolves.toBeTruthy();
  });

  it('with the pool exhausted, a high-risk turn still shows resources and pages the on-call', async () => {
    const pool = smallPool();
    holder.pool = pool;
    const emit = vi.fn();
    (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit })) };
    const { runCrisisPipeline } = await import('../services/crisisPipeline.service.js');
    const held: PoolClient[] = [await pool.connect(), await pool.connect()];
    try {
      const result = await runCrisisPipeline(
        { sessionId: 'rt_dbpool_live_session', messageId: null, content: 'I am going to kill myself tonight' },
        'realtime',
      );
      expect(result.severity).toBe('high');
      const deadline = Date.now() + 10_000;
      while (pager.calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(pager.calls).toHaveLength(1);
      expect(pager.calls[0]).toMatch(/crisis/i);
      expect(emit).toHaveBeenCalledWith(
        'session:crisis-emergency',
        expect.objectContaining({ sessionId: 'rt_dbpool_live_session', severity: 'high' }),
      );
      expect(pool.stats().timeouts.acquire).toBeGreaterThan(0);
    } finally {
      held.forEach((c) => c.release());
      // Let fire-and-forget writes settle against this pool before it ends.
      await new Promise((r) => setTimeout(r, 1500));
      holder.pool = null;
    }
  }, 30_000);

  it('a statement past the timeout is cancelled; inside withLongQueries it is exempt, and the limit comes back', async () => {
    const pool = smallPool({ max: 1 });
    const err = await pool.query('SELECT pg_sleep(2)').catch((e: unknown) => e);
    expect(dbTimeoutKind(err)).toBe('statement');
    expect(pool.stats().timeouts.statement).toBe(1);

    // pool.query inside the scope.
    await expect(withLongQueries('live-test', () => pool.query('SELECT pg_sleep(2)'))).resolves.toBeTruthy();
    // pool.connect inside the scope (a transaction, as ensurePseudonyms runs).
    await withLongQueries('live-test', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ s: string }>("SELECT current_setting('statement_timeout') AS s");
        expect(rows[0].s).toBe('5s');
        await client.query('SELECT pg_sleep(1.5)');
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });

    // Same single connection, back on the pool's own limit.
    const { rows } = await pool.query<{ s: string }>("SELECT current_setting('statement_timeout') AS s");
    expect(rows[0].s).toBe('1s');
    const again = await pool.query('SELECT pg_sleep(2)').catch((e: unknown) => e);
    expect(dbTimeoutKind(again)).toBe('statement');
  }, 20_000);

  it('a long-scope connection whose RESET fails (released inside an aborted transaction) is destroyed, not reused', async () => {
    const pool = smallPool({ max: 1 });
    let scopedPid = 0;
    await withLongQueries('live-test', async () => {
      const client = await pool.connect();
      scopedPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await client.query('BEGIN');
      await client.query('SELECT 1/0').catch(() => undefined);
      // A caller that forgot its ROLLBACK: RESET now fails ("current
      // transaction is aborted"), so the 5 s limit cannot be cleared.
      client.release();
    });
    await new Promise((r) => setTimeout(r, 200));
    const { rows } = await pool.query<{ s: string; pid: number }>(
      "SELECT current_setting('statement_timeout') AS s, pg_backend_pid() AS pid",
    );
    expect(rows[0].s).toBe('1s');
    expect(rows[0].pid).not.toBe(scopedPid);
  }, 10_000);

  it('a transaction left idle is ended by the server, and the process survives it', async () => {
    const pool = smallPool({ max: 1, idleInTransactionTimeoutMs: 500 });
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1');
    // A handler that crashed between statements: nothing more is sent.
    await new Promise((r) => setTimeout(r, 1500));
    const err = await client.query('SELECT 1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    client.release(err as Error);
    // The error arrived while the client was checked out and idle: counted by
    // the connection's own listener instead of crashing the process.
    expect(pool.stats().timeouts.idle_in_transaction).toBe(1);
    // The pool replaces the connection.
    await expect(pool.query('SELECT 1')).resolves.toBeTruthy();
  }, 10_000);
});
