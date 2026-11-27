// One queue for the automatic per-session Decisions judges (the alliance
// rating and the session features). Each job holds one pool connection for
// its claim while the model answers; without a queue a burst of session ends
// (or the redaction sweep working through a backlog) would hold one each and
// starve the live app of connections. With one queue for both judges the
// automatic hooks hold at most one such connection in this process.

let queue: Promise<void> = Promise.resolve();

/**
 * Run `job` after every job queued before it. Never rejects: a failure goes
 * to `onError` and the queue moves on. The returned promise settles when this
 * job's turn is done (tests await it; callers ignore it).
 */
export function enqueueSessionJudgeJob(job: () => Promise<void>, onError: (err: unknown) => void): Promise<void> {
  queue = queue.then(job).catch(onError);
  return queue;
}
