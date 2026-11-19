// The named escape hatch from the pool's default statement timeout
// (ai-therapist-366). Kept apart from config/db.ts on purpose: it holds no
// pool, so a module that wraps its work in it does not have to be re-mocked by
// the hundred tests that replace config/db.js with a fake pool.
//
// Every connection the app pool hands out carries a short statement_timeout
// and idle_in_transaction_session_timeout (see config/db.ts). A few legitimate
// jobs are long by nature: the research dataset export, the bulk researcher
// export, the content wipe, risk calibration, migrations. They run inside
//
//   await withLongQueries('dataset_export', () => buildDataset(asOf));
//
// and every query they make through the app pool, directly or through the
// db/*.queries helpers, gets the longer limit: config/db.ts reads the scope at
// checkout, raises both timeouts on that connection (SET), and puts them back
// (RESET) before the connection returns to the pool. Nothing outside the scope
// is affected, and no second pool exists.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LongQueryScope {
  /** Names the job in logs (no participant data). */
  label: string;
  /** statement_timeout and idle_in_transaction_session_timeout for the
   *  scope's connections, in ms. 0 means no limit (migrations only).
   *  Undefined: the pool's long limit (DB_LONG_STATEMENT_TIMEOUT_MS). */
  timeoutMs: number | undefined;
}

/** Default for a scope that does not name its own limit. */
export const DEFAULT_LONG_STATEMENT_TIMEOUT_MS = 10 * 60 * 1000;

const scopes = new AsyncLocalStorage<LongQueryScope>();

/** The long-statement limit from DB_LONG_STATEMENT_TIMEOUT_MS, or the default. */
export function longStatementTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DB_LONG_STATEMENT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_LONG_STATEMENT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_LONG_STATEMENT_TIMEOUT_MS;
}

/**
 * Run `fn` with the long statement limit on every app-pool query it makes.
 * `timeoutMs` 0 lifts the limit entirely; reserve that for migrations, which
 * a human runs and watches. A scope inside a scope keeps the outer one.
 */
export function withLongQueries<T>(label: string, fn: () => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  const outer = scopes.getStore();
  if (outer) return fn();
  const timeoutMs = opts.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0)) {
    throw new Error(`withLongQueries(${label}): timeoutMs must be a non-negative integer`);
  }
  return scopes.run({ label, timeoutMs }, fn);
}

/** The scope the current async context runs in, if any. */
export function currentLongQueryScope(): LongQueryScope | undefined {
  return scopes.getStore();
}
