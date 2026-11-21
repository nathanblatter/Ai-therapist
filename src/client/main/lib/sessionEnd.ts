// One teardown per session end (ai-therapist-384).
//
// Ending a voice session takes a few seconds: the vendor's `session.closed`,
// then the recording drain (audioUploader.ts, at most DRAIN_TIMEOUT_MS), then
// POST /end, which finalises the recording. A second End press in that window
// used to run the whole teardown again. The second run found no uploaders left
// to drain (the first had taken them), so its POST /end went out at once and
// the server closed the recording while the first run's last batches were
// still uploading: they were answered 410 and the tail of the recording was
// lost. It also re-took the `session.closed` waiter, logged a second
// session_end, and overwrote the post-session snapshot with emptied state.
//
// The gate makes a repeated end of the same session join the teardown that is
// already running. The wait stays bounded: a teardown older than `maxJoinMs`
// no longer absorbs presses, so a hung request can never make End a dead
// button; the next press runs the teardown again, as every press used to.

/**
 * Longest a running teardown absorbs further End presses. Above the longest
 * healthy teardown: 15 s for `session.closed` (LIVE_CLOSE_TIMEOUT_MS), 3 s for
 * the recording drain, and the log flush and POST /end round trips.
 */
export const END_JOIN_MAX_MS = 30_000;

export interface SessionEndGate {
  /**
   * Run `teardown` for the session `key`, or join the one already running for
   * the same key. Resolves or rejects with that teardown.
   */
  run: (key: string | null, teardown: () => Promise<void>) => Promise<void>;
  /** Whether a teardown for `key` is running and still absorbing presses. */
  isEnding: (key: string | null) => boolean;
}

export function createSessionEndGate(maxJoinMs = END_JOIN_MAX_MS): SessionEndGate {
  let flight: { key: string | null; startedAt: number; promise: Promise<void> } | null = null;

  const joinable = (key: string | null) =>
    flight !== null && flight.key === key && Date.now() - flight.startedAt < maxJoinMs;

  return {
    run: (key, teardown) => {
      if (flight && joinable(key)) return flight.promise;
      // An async wrapper, so a teardown that throws before its first await
      // rejects the promise instead of escaping with the gate half-set.
      const promise = (async () => teardown())();
      const mine = { key, startedAt: Date.now(), promise };
      flight = mine;
      const release = () => {
        if (flight === mine) flight = null;
      };
      promise.then(release, release);
      return promise;
    },
    isEnding: joinable,
  };
}
