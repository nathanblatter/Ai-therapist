/**
 * Bounded reads on the crisis path before the on-call is paged
 * (ai-therapist-369).
 *
 * Since PR #81 the pool rejects instead of hanging: a call waits up to 3 s for
 * a connection and a statement runs up to 10 s. A read that only shapes how a
 * turn is scored (its history, its check-in, the session's risk context, the
 * assessor's model setting) must not hold the page back that long, once per
 * read, in sequence. Each such read is raced against CRISIS_READ_DEADLINE_MS
 * and, past it, treated exactly like a read that failed: the caller's own
 * failure default stands (it already fails toward detection and paging).
 *
 * The read is not cancelled (pg has no per-query abort here); it finishes or
 * fails on its own and its result is dropped. A rejection that arrives after
 * the deadline is handled here, so it is never an unhandled rejection.
 */

/** The paging layer's own lookup bound (crisisPaging PAGING_LOOKUP_TIMEOUT_MS):
 *  the same 2 s, so no read before the page waits longer than any lookup in it. */
export const CRISIS_READ_DEADLINE_MS = 2000;

/** Thrown (and caught by the caller like any read failure) when a read has not
 *  answered within its deadline. */
export class ReadDeadlineError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${ms} ms`);
    this.name = 'ReadDeadlineError';
  }
}

/**
 * `work`, or a ReadDeadlineError if it has not settled within `ms`. The caller
 * catches it exactly as it catches the read's own failure.
 */
export function withReadDeadline<T>(work: Promise<T>, what: string, ms = CRISIS_READ_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadDeadlineError(what, ms)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * `work`, or `fallback` if it has not settled within `ms` (for reads that
 * never throw and resolve to their own failure default, such as
 * getSessionRiskContext). `onLate` is told when the deadline decided.
 */
export function readWithin<T>(
  work: Promise<T>,
  fallback: T,
  what: string,
  onLate?: (err: ReadDeadlineError) => void,
  ms = CRISIS_READ_DEADLINE_MS,
): Promise<T> {
  return withReadDeadline(work, what, ms).catch((err: unknown) => {
    if (err instanceof ReadDeadlineError) {
      onLate?.(err);
      return fallback;
    }
    throw err;
  });
}
