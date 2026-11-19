// The browser's batched transcript logger (App.tsx flushLogs) posts voice
// turns to /logs/batch. Whether a batch that did not land is kept for the next
// flush (ai-therapist-369).
//
// The server stores a batch in one transaction and answers 200 only after it
// is stored; a 5xx means nothing in it was stored (the database could not be
// reached in time, for instance). Its participant turns were still screened
// for crisis on the server, but without a re-send they are missing from the
// transcript for good. A 4xx (not the owner, quiet hours, a malformed batch)
// will not succeed on a re-send and is dropped, as before.

/** `status`: the HTTP status, or null when the request itself failed. */
export function shouldRequeueLogBatch(status: number | null): boolean {
  return status === null || status >= 500;
}

/** Oldest-first: the batch that failed goes back in front of anything logged
 *  since, so turns are re-sent in the order they were spoken. */
export function requeueLogBatch<T>(failed: T[], since: T[]): T[] {
  return [...failed, ...since];
}
