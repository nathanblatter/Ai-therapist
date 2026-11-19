// The app's Postgres pool, with bounds (ai-therapist-366).
//
// Connection comes from DATABASE_URL (e.g. the shared Postgres instance in
// docker-services, reached via host.docker.internal from inside the container).
// SSL is only enabled when DATABASE_SSL=true (used for managed Postgres like RDS);
// the self-hosted Postgres does not use TLS.
//
// Before this file set bounds, a slow or saturated database could hang any
// request indefinitely: no connectionTimeoutMillis (a request for a connection
// waited forever), no statement_timeout, and a handler that died inside a
// transaction kept its connection. Every connection now carries:
//
//   DB_POOL_MAX                         connections per process (default 10)
//   DB_CONNECTION_TIMEOUT_MS            longest wait for a connection (3000)
//   DB_STATEMENT_TIMEOUT_MS             longest single statement (10000)
//   DB_IDLE_IN_TRANSACTION_TIMEOUT_MS   longest a transaction may sit idle (30000)
//   DB_LONG_STATEMENT_TIMEOUT_MS        the limit inside withLongQueries (600000)
//   DB_APPLICATION_NAME                 pg_stat_activity.application_name
//                                       (default ai-therapist/<script>@<host>)
//
// 0 disables a timeout. Unset or invalid values fall back to the defaults, so
// prod is tuned through .env, never a code change. Long legitimate jobs use the
// named escape hatch in config/dbLongQueries.ts, not a second pool.
//
// What a caller sees when a bound fires: a rejected promise. pg-pool's
// "timeout exceeded when trying to connect", or a Postgres error with code
// 57014 (statement timeout) / 25P03 (idle in transaction). utils/dbErrors.ts
// classifies them. The crisis path is written to treat any of these as "could
// not read", which always resolves toward paging and showing resources.
import os from 'node:os';
import path from 'node:path';
import pkg from 'pg';
import type { PoolClient } from 'pg';
import 'dotenv/config';
import { currentLongQueryScope, longStatementTimeoutFromEnv, type LongQueryScope } from './dbLongQueries.js';
import { dbTimeoutKind, type DbTimeoutKind } from '../utils/dbErrors.js';
import { createLogger } from '../utils/logger.js';

const { Pool } = pkg;
const log = createLogger('db');

export interface DbPoolSettings {
  max: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
  longStatementTimeoutMs: number;
  applicationName: string;
}

export const DB_POOL_DEFAULTS = {
  max: 10,
  connectionTimeoutMs: 3000,
  statementTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 30_000,
} as const;

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= min) return n;
  log.warn(`${name}=${JSON.stringify(raw)} is not an integer >= ${min}; using ${fallback}`);
  return fallback;
}

/** ai-therapist/<entry script>@<host>: which process holds which connection
 *  in pg_stat_activity (two app containers during a deploy differ by host). */
export function defaultApplicationName(argv1: string | undefined = process.argv[1], host = os.hostname()): string {
  const script = argv1 ? path.basename(argv1).replace(/\.(m?[jt]s|cjs)$/, '') : 'node';
  return `ai-therapist/${script}@${host}`.replace(/[^\x20-\x7e]/g, '?').slice(0, 63);
}

export function resolveDbPoolSettings(env: NodeJS.ProcessEnv = process.env): DbPoolSettings {
  return {
    max: intFromEnv(env, 'DB_POOL_MAX', DB_POOL_DEFAULTS.max, 1),
    connectionTimeoutMs: intFromEnv(env, 'DB_CONNECTION_TIMEOUT_MS', DB_POOL_DEFAULTS.connectionTimeoutMs, 0),
    statementTimeoutMs: intFromEnv(env, 'DB_STATEMENT_TIMEOUT_MS', DB_POOL_DEFAULTS.statementTimeoutMs, 0),
    idleInTransactionTimeoutMs: intFromEnv(
      env,
      'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS',
      DB_POOL_DEFAULTS.idleInTransactionTimeoutMs,
      0,
    ),
    longStatementTimeoutMs: longStatementTimeoutFromEnv(env),
    applicationName: env.DB_APPLICATION_NAME?.trim() || defaultApplicationName(),
  };
}

export interface PoolStats {
  max: number;
  total: number;
  idle: number;
  waiting: number;
  timeouts: Record<DbTimeoutKind, number>;
  lastTimeoutAt: string | null;
}

type Done = (release?: unknown) => void;
type ConnectCallback = (err: Error | undefined, client: PoolClient | undefined, done: Done) => void;
type AnyFn = (...args: unknown[]) => unknown;

const INSTRUMENTED = Symbol('dbInstrumented');

export type BoundedPool = pkg.Pool & { readonly settings: DbPoolSettings; stats(): PoolStats };

/**
 * A pg Pool with the bounds above, timeout counting, and the long-query scope.
 * Exported so tests (and nothing else) can build a small one against a
 * scratch database with exactly the production code path.
 */
export function createPool(settings: DbPoolSettings, connectionString = process.env.DATABASE_URL): BoundedPool {
  const useSsl = process.env.DATABASE_SSL === 'true';
  const pool = new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    // Set timezone to Mountain Time (handles both MST and MDT automatically)
    options: '-c timezone=America/Denver',
    max: settings.max,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    // Sent as startup parameters, so they hold from the first statement on
    // every connection, and RESET returns to them.
    statement_timeout: settings.statementTimeoutMs,
    idle_in_transaction_session_timeout: settings.idleInTransactionTimeoutMs,
    application_name: settings.applicationName,
  });

  const counts: Record<DbTimeoutKind, number> = { acquire: 0, statement: 0, idle_in_transaction: 0 };
  let lastTimeoutAt: string | null = null;
  const note = (err: unknown): void => {
    const kind = dbTimeoutKind(err);
    if (!kind) return;
    counts[kind]++;
    lastTimeoutAt = new Date().toISOString();
    // No SQL text and no parameters: those can carry participant content.
    log.warn(
      {
        kind,
        label: currentLongQueryScope()?.label ?? null,
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
      `database ${kind} timeout`,
    );
  };

  // Every new connection: count the timeouts its queries hit, and give it a
  // permanent 'error' listener. Without one, an error that arrives while the
  // client is checked out and idle (idle_in_transaction_session_timeout
  // terminating the backend, a dropped network) is emitted with no listener
  // and crashes the process. pg-pool only listens while the client is idle
  // in the pool.
  pool.on('connect', (client: PoolClient) => {
    const c = client as PoolClient & { [INSTRUMENTED]?: true };
    if (c[INSTRUMENTED]) return;
    c[INSTRUMENTED] = true;
    client.on('error', (err) => {
      note(err);
      log.error({ err, code: (err as { code?: unknown }).code }, 'database connection error');
    });
    const rawQuery = client.query.bind(client) as AnyFn;
    (client as unknown as { query: AnyFn }).query = (...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        args[args.length - 1] = (err: unknown, res: unknown) => {
          if (err) note(err);
          (last as AnyFn)(err, res);
        };
        return rawQuery(...args);
      }
      const out = rawQuery(...args);
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        // A tap, not a handler: the caller still gets (and must handle) the
        // original promise; this derived one always resolves.
        (out as Promise<unknown>).then(undefined, note);
      }
      return out;
    };
  });

  const rawConnect = pool.connect.bind(pool) as (cb: ConnectCallback) => void;

  const scopedSql = (scope: LongQueryScope): string => {
    const ms = scope.timeoutMs ?? settings.longStatementTimeoutMs;
    return `SET statement_timeout = ${ms}; SET idle_in_transaction_session_timeout = ${ms}`;
  };
  const RESET_SQL = 'RESET statement_timeout; RESET idle_in_transaction_session_timeout';

  // Both the promise form (callers) and the callback form (pg-pool's own
  // pool.query) come through here, so the scope and the counting apply to
  // both. The scope is read now, in the caller's async context, not in the
  // callback, which can run in whichever context released a connection.
  function connect(cb?: ConnectCallback): Promise<PoolClient> | void {
    if (typeof cb !== 'function') {
      return new Promise<PoolClient>((resolve, reject) => {
        connect((err, client) => (err || !client ? reject(err) : resolve(client)));
      });
    }
    const scope = currentLongQueryScope();
    rawConnect((err, client, done) => {
      if (err || !client) {
        note(err);
        return cb(err, undefined, done);
      }
      if (!scope) return cb(undefined, client, done);
      const release = client.release.bind(client) as (err?: Error | boolean) => void;
      client.query(scopedSql(scope)).then(
        () => {
          // Back to the pool's own limits before anyone else can borrow it.
          // A connection whose RESET fails is destroyed, never reused.
          const releaseScoped = (releaseErr?: Error | boolean): void => {
            if (releaseErr) return release(releaseErr);
            client.query(RESET_SQL).then(
              () => release(),
              (resetErr: Error) => release(resetErr),
            );
          };
          client.release = releaseScoped as PoolClient['release'];
          cb(undefined, client, releaseScoped as Done);
        },
        (setErr: Error) => {
          release(setErr);
          cb(setErr, undefined, () => undefined);
        },
      );
    });
  }
  (pool as unknown as { connect: typeof connect }).connect = connect;

  return Object.assign(pool, {
    settings,
    stats(): PoolStats {
      return {
        max: settings.max,
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        timeouts: { ...counts },
        lastTimeoutAt,
      };
    },
  });
}

const settings = resolveDbPoolSettings();
const pool = createPool(settings);

/** Pool size, in-use and waiting counts, and timeouts since start. No secrets. */
export function getPoolStats(): PoolStats {
  return pool.stats();
}

export { pool };
