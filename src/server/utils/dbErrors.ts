// Classifying database failures (ai-therapist-366). Pure: no pool, no imports
// of config/db, so route modules can use it under any test mock.

export type DbTimeoutKind = 'acquire' | 'statement' | 'idle_in_transaction';

/** pg-pool's message when no connection was free within connectionTimeoutMillis. */
export const POOL_ACQUIRE_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
/** pg's message when a NEW connection could not be opened in time. */
const CONNECT_TIMEOUT_MESSAGE = 'Connection terminated due to connection timeout';

/**
 * Which of the pool's bounds produced this error, or null when it is not one
 * of them. 57014 is query_canceled, which is what statement_timeout raises;
 * 25P03 is idle_in_transaction_session_timeout.
 */
export function dbTimeoutKind(err: unknown): DbTimeoutKind | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === '57014') return 'statement';
  if (e.code === '25P03') return 'idle_in_transaction';
  if (typeof e.message === 'string') {
    if (e.message === POOL_ACQUIRE_TIMEOUT_MESSAGE || e.message.startsWith(CONNECT_TIMEOUT_MESSAGE)) return 'acquire';
  }
  return null;
}

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  // admin_shutdown, crash_shutdown, cannot_connect_now, too_many_connections
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

/**
 * True when the database could not answer in time or at all: a pool bound
 * fired, the connection was refused or dropped, or the server is out of
 * connections. Not true for an ordinary query error (a constraint, bad SQL),
 * which a retry would not fix. Used to give participants a retry message.
 */
export function isDatabaseUnavailableError(err: unknown): boolean {
  if (dbTimeoutKind(err) !== null) return true;
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === 'string' && UNAVAILABLE_CODES.has(e.code)) return true;
  return typeof e.message === 'string' && /^Connection terminated/.test(e.message);
}

/** What a participant is told when the database could not answer. No detail. */
export const DATABASE_RETRY_MESSAGE =
  'We could not reach our system just now. Please wait a moment and try again. ' +
  'If you are in crisis, call or text 988 (Suicide & Crisis Lifeline) or 911.';
