// Pool bounds configuration and failure classification (ai-therapist-366).
// No database: settings are pure, and the pool is only constructed, never used.
import { describe, it, expect, vi } from 'vitest';
import { resolveDbPoolSettings, defaultApplicationName, DB_POOL_DEFAULTS, createPool } from './db.js';
import {
  withLongQueries,
  currentLongQueryScope,
  longStatementTimeoutFromEnv,
  DEFAULT_LONG_STATEMENT_TIMEOUT_MS,
} from './dbLongQueries.js';
import { dbTimeoutKind, isDatabaseUnavailableError } from '../utils/dbErrors.js';
import { installProcessPolicy, unhandledRejectionCount } from '../utils/processPolicy.js';

describe('resolveDbPoolSettings', () => {
  it('uses the documented defaults when nothing is set', () => {
    const s = resolveDbPoolSettings({});
    expect(s).toMatchObject({
      max: 10,
      connectionTimeoutMs: 3000,
      statementTimeoutMs: 10_000,
      idleInTransactionTimeoutMs: 30_000,
      longStatementTimeoutMs: DEFAULT_LONG_STATEMENT_TIMEOUT_MS,
    });
    expect(s.applicationName).toMatch(/^ai-therapist\//);
    expect(DB_POOL_DEFAULTS.max).toBe(10);
  });

  it('reads every bound from the environment, 0 disabling a timeout', () => {
    const s = resolveDbPoolSettings({
      DB_POOL_MAX: '15',
      DB_CONNECTION_TIMEOUT_MS: '5000',
      DB_STATEMENT_TIMEOUT_MS: '0',
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '60000',
      DB_LONG_STATEMENT_TIMEOUT_MS: '120000',
      DB_APPLICATION_NAME: 'ai-therapist/stage',
    });
    expect(s).toEqual({
      max: 15,
      connectionTimeoutMs: 5000,
      statementTimeoutMs: 0,
      idleInTransactionTimeoutMs: 60000,
      longStatementTimeoutMs: 120000,
      applicationName: 'ai-therapist/stage',
    });
  });

  it('falls back to the default on an invalid value instead of running unbounded', () => {
    const s = resolveDbPoolSettings({
      DB_POOL_MAX: '0',
      DB_CONNECTION_TIMEOUT_MS: 'soon',
      DB_STATEMENT_TIMEOUT_MS: '-5',
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '1.5',
      DB_LONG_STATEMENT_TIMEOUT_MS: 'x',
    });
    expect(s).toMatchObject({
      max: 10,
      connectionTimeoutMs: 3000,
      statementTimeoutMs: 10_000,
      idleInTransactionTimeoutMs: 30_000,
      longStatementTimeoutMs: DEFAULT_LONG_STATEMENT_TIMEOUT_MS,
    });
  });

  it('names the process for pg_stat_activity: script and host, ASCII, at most 63 characters', () => {
    expect(defaultApplicationName('/app/src/server/index.ts', 'a1b2c3d4e5f6')).toBe('ai-therapist/index@a1b2c3d4e5f6');
    expect(defaultApplicationName('/x/runMigrationRange.js', 'h')).toBe('ai-therapist/runMigrationRange@h');
    expect(defaultApplicationName('', 'h')).toBe('ai-therapist/node@h');
    expect(defaultApplicationName('/x/y.ts', 'é'.repeat(100)).length).toBeLessThanOrEqual(63);
  });

  it('passes the bounds to every connection as startup parameters', () => {
    const pool = createPool(
      {
        max: 2,
        connectionTimeoutMs: 1234,
        statementTimeoutMs: 5678,
        idleInTransactionTimeoutMs: 9012,
        longStatementTimeoutMs: 60_000,
        applicationName: 'ai-therapist/test',
      },
      'postgresql://nobody@127.0.0.1:1/never_connected',
    );
    const opts = (pool as unknown as { options: Record<string, unknown> }).options;
    expect(opts).toMatchObject({
      max: 2,
      connectionTimeoutMillis: 1234,
      statement_timeout: 5678,
      idle_in_transaction_session_timeout: 9012,
      application_name: 'ai-therapist/test',
    });
    expect(pool.stats()).toEqual({
      max: 2,
      total: 0,
      idle: 0,
      waiting: 0,
      timeouts: { acquire: 0, statement: 0, idle_in_transaction: 0 },
      lastTimeoutAt: null,
    });
    void pool.end();
  });
});

describe('withLongQueries', () => {
  it('scopes the long limit to the async work inside it, and nowhere else', async () => {
    expect(currentLongQueryScope()).toBeUndefined();
    const seen = await withLongQueries(
      'export',
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentLongQueryScope();
      },
      { timeoutMs: 1234 },
    );
    expect(seen).toEqual({ label: 'export', timeoutMs: 1234 });
    expect(currentLongQueryScope()).toBeUndefined();
  });

  it("defaults to the pool's long limit (DB_LONG_STATEMENT_TIMEOUT_MS); an inner scope keeps the outer one", async () => {
    expect(longStatementTimeoutFromEnv({ DB_LONG_STATEMENT_TIMEOUT_MS: '90000' })).toBe(90000);
    await expect(withLongQueries('d', async () => currentLongQueryScope())).resolves.toEqual({
      label: 'd',
      timeoutMs: undefined,
    });
    const inner = await withLongQueries('outer', () => withLongQueries('inner', async () => currentLongQueryScope()), {
      timeoutMs: 0,
    });
    expect(inner).toEqual({ label: 'outer', timeoutMs: 0 });
  });

  it('refuses a nonsense limit', () => {
    expect(() => withLongQueries('x', async () => 1, { timeoutMs: -1 })).toThrow(/non-negative integer/);
  });
});

describe('database failure classification', () => {
  it('recognises the three bounds', () => {
    expect(dbTimeoutKind(new Error('timeout exceeded when trying to connect'))).toBe('acquire');
    expect(dbTimeoutKind(new Error('Connection terminated due to connection timeout'))).toBe('acquire');
    expect(dbTimeoutKind({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe('statement');
    expect(dbTimeoutKind({ code: '25P03', message: 'terminating connection due to idle-in-transaction timeout' })).toBe(
      'idle_in_transaction',
    );
    expect(dbTimeoutKind(new Error('duplicate key'))).toBeNull();
    expect(dbTimeoutKind(null)).toBeNull();
  });

  it('treats refusals and dropped connections as unavailable, ordinary query errors as not', () => {
    expect(isDatabaseUnavailableError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(
      true,
    );
    expect(isDatabaseUnavailableError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isDatabaseUnavailableError({ code: '53300', message: 'too many connections' })).toBe(true);
    expect(isDatabaseUnavailableError({ code: '23505', message: 'duplicate key' })).toBe(false);
    expect(isDatabaseUnavailableError(new Error('Session not found'))).toBe(false);
  });
});

describe('process policy', () => {
  it('logs an unhandled rejection and keeps the process running', () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
    const before = process.listenerCount('unhandledRejection');
    installProcessPolicy(log);
    installProcessPolicy(log); // idempotent
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    const listeners = process.listeners('unhandledRejection');
    const ours = listeners[listeners.length - 1] as (reason: unknown, p: Promise<unknown>) => void;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    ours(new Error('timeout exceeded when trying to connect'), Promise.resolve());
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ dbTimeout: 'acquire', count: 1 }),
      expect.stringMatching(/kept running/),
    );
    expect(unhandledRejectionCount()).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
    process.off('unhandledRejection', ours);
  });
});
