// Process-level failure policy (ai-therapist-366).
//
// Unhandled promise rejection: LOG AND KEEP RUNNING. Node's default since v15
// is to crash on one, and this process holds every live voice session. Before
// the pool had timeouts a database stall left promises pending forever; now
// it rejects them, and a single fire-and-forget write somewhere without a
// .catch would otherwise take down every participant mid-conversation
// (docker restarts the container, but the live calls are gone). The rejection
// is a bug to fix, so it is logged at error level with what kind of database
// timeout it was, if any, and counted.
//
// Uncaught exception: unchanged. Node's default (print and exit) stands, and
// docker restarts the container; a synchronous throw that escaped everything
// leaves the process in a state nobody can vouch for. It is only logged first
// through the monitor hook, which does not alter that behaviour.
import { dbTimeoutKind } from './dbErrors.js';
import type { Logger } from './logger.js';

let installed = false;
let unhandledRejections = 0;

export function installProcessPolicy(log: Logger): void {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => {
    unhandledRejections++;
    log.error(
      { err: reason, dbTimeout: dbTimeoutKind(reason), count: unhandledRejections },
      'Unhandled promise rejection (process kept running; this is a bug to fix)',
    );
  });
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    log.error({ err, origin }, 'Uncaught exception; the process will exit');
  });
}

/** Unhandled rejections since start (health/ops readout). */
export function unhandledRejectionCount(): number {
  return unhandledRejections;
}
