// Session auto-termination, shared by the GPT-Live and Grok voice paths.
//
// Extracted from token.routes.ts so the two voice backends cannot drift apart on
// something safety- and data-relevant. The logic is identical for both; only the
// mechanism for steering the model differs, so that is injected as a callback.
//
// Why it is two-phase (preserved verbatim from the original): the participant's
// Socket.io channel is unreliable through the tunnel, so ending the session
// server-side is invisible to them — their WebRTC conversation keeps going and
// the recording ends up covering only the first N minutes of a much longer
// conversation. Phase 1 asks the MODEL to say goodbye and end the session, which
// reaches the client over the WebRTC data channel (reliable) and closes things
// through the normal user path with the recording intact. Phase 2 is the old
// hard server-side end, as a backstop.
//
// Crisis (ai-therapist-281, Nathan 2026-11-01): our own duration limit must
// never cut off a participant in crisis. On a high flag the limit is LIFTED to
// the vendor ceiling (60 minutes on GPT-Live, the one limit we cannot move), the
// model is told how much time is left at fixed points so it can prepare them,
// and when the ceiling does close the session the client rolls straight into a
// new one (see the `expired` branch in sidebandManager and App.tsx). Under Grok
// there is no known vendor ceiling, so the ceiling is where our own graceful
// wrap-up moves to instead.
//
// Time is PUSHED to the model (sideband notices), never polled: a model asked to
// "check the time periodically" either never does or does it every turn. The
// get_session_time tool exists for the participant's own "how long do we have".

import { getSessionAccessInfo, updateSessionStatus } from '../db/index.js';
import { broadcastAdminEventForSession } from './adminBroadcast.js';
import { authorizeModelEnd } from './modelEndAuthorization.js';

import { createLogger } from './logger.js';

const log = createLogger('sessionAutoTerminate');

/** How the model is steered. Returns false when the steer wasn't delivered. */
export type SteerFn = (sessionId: string, text: string, respond: boolean) => Promise<boolean>;

/** How the backend connection for the session is torn down. */
export type TeardownFn = (sessionId: string) => Promise<void>;

export interface AutoTerminateOptions {
  sessionId: string;
  maxDurationMinutes: number;
  steer: SteerFn;
  teardown: TeardownFn;
  /** Grace period between asking the model to wrap up and the hard end. */
  graceMs?: number;
  /**
   * Which voice backend owns the session. Decides what happens at the vendor
   * ceiling once a crisis has lifted our own limit: GPT-Live expires on its own
   * and the client recovers, so the model is told to expect a brief reset and
   * NOT to end; Grok has no such ceiling, so our graceful wrap-up runs there.
   */
  backend?: 'live' | 'grok';
}

/** The vendor's own maximum session length, past which our timers are moot. */
export const DEFAULT_VENDOR_CEILING_MINUTES = 60;

const WRAP_UP_NUDGE =
  '[About one minute remains in this session. Begin wrapping up naturally — consolidate one takeaway, ' +
  'no new topics. If it fits, call display_session_recap now.]';

const TIME_LIMIT_STEER =
  'TIME LIMIT REACHED: this session has hit its maximum duration. In your next reply, give a brief, warm ' +
  'closing (2-3 sentences, no new topics), then immediately call the end_session tool.';

/** Minutes-before-limit at which the model is told the time, in normal mode. */
const TIME_NOTICE_MINUTES = [10, 5];

/** Minutes-before-ceiling at which a crisis session is told the time. */
const CRISIS_NOTICE_MINUTES = [10, 5, 2];

function timeNotice(elapsedMinutes: number, remainingMinutes: number): string {
  return (
    `[Session time: about ${elapsedMinutes} minutes used, ${remainingMinutes} remaining. ` +
    `Do not announce this unless it helps them; pace the conversation so it can land naturally.]`
  );
}

function crisisTimeNotice(remainingMinutes: number): string {
  return (
    `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
    `The platform's maximum connection time is about ${remainingMinutes} minutes away; the session timer was ` +
    `lifted so you are not cut off early, but that ceiling cannot be moved. Stay with them. Use this time to make ` +
    `sure they know how to reach ${'988'} (call or text) and whether someone can be with them in person. ` +
    `Do not say goodbye and do not end the session.`
  );
}

const CRISIS_CEILING_LIVE =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  `The connection is about to reset in roughly a minute; that is the platform, not you, and you will be ` +
  `reconnected with them automatically. In your next reply, calmly tell them the line may drop for a moment ` +
  `and that you will be right back with them; remind them they can call or text 988 at any time. ` +
  `Do not say goodbye as if the conversation is over, and do NOT call end_session.`;

const CRISIS_CEILING_WRAP_UP =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  `The platform's maximum connection time has been reached and the session must close now. In your next reply, ` +
  `warmly tell them this conversation has to end here, make sure they have 988 (call or text) and, if they are ` +
  `in immediate danger, 911; ask them to reach out to someone who can be with them; say a brief, caring goodbye; ` +
  `then call the end_session tool.`;

interface ArmedSession {
  opts: AutoTerminateOptions;
  startedAt: number;
  /** The limit currently in force, in minutes from startedAt. */
  limitMinutes: number;
  /** Our own limit was lifted to the vendor ceiling for a crisis. */
  liftedForCrisis: boolean;
  timers: Set<NodeJS.Timeout>;
}

const armed = new Map<string, ArmedSession>();

function arm(entry: ArmedSession, delayMs: number, fn: () => Promise<void>, label: string): void {
  if (delayMs < 0) return;
  const timer = setTimeout(async () => {
    entry.timers.delete(timer);
    try {
      const current = await getSessionAccessInfo(entry.opts.sessionId);
      if (!current || current.status !== 'active') return;
      await fn();
    } catch (err) {
      log.error({ err }, `${label} failed for ${entry.opts.sessionId}`);
    }
  }, delayMs);
  timer.unref?.();
  entry.timers.add(timer);
}

function clearTimers(entry: ArmedSession): void {
  for (const t of entry.timers) clearTimeout(t);
  entry.timers.clear();
}

/**
 * Finalize a session that ran past its limit: mark it ended, tear down the
 * backend connection, and kick off the post-session pipeline.
 *
 * Every post-session job is fire-and-forget and independently guarded, because
 * a failure in (say) insight generation must not prevent the recording from
 * being finalized or the participant from being told the session ended.
 */
async function hardEnd(opts: AutoTerminateOptions, limitMinutes: number): Promise<void> {
  const { sessionId, teardown } = opts;
  log.info(`Auto-terminating session ${sessionId} after ${limitMinutes} minutes (+grace)`);
  await updateSessionStatus(sessionId, 'ended', 'system');
  armed.delete(sessionId);

  try {
    await teardown(sessionId);
  } catch (e) {
    log.error({ err: e }, 'Backend teardown failed');
  }

  // Free the in-memory chat transcript (ai-therapist-224). No-op for realtime.
  import('../services/chatTherapy.service.js')
    .then((m) => m.endChatSession(sessionId))
    .catch((e) => log.error({ err: e }, 'chat transcript cleanup failed'));

  import('../services/sessionRedaction.service.js')
    .then((m) => m.redactSession(sessionId))
    .catch((e) => log.error({ err: e }, '[Redaction] session redaction failed'));

  import('../services/recorder.service.js')
    .then((m) => m.finalize(sessionId))
    .catch((e) => log.error({ err: e }, '[Recorder] finalize failed'));

  import('../services/sessionInsights.service.js')
    .then((m) => m.generateSessionInsightsAsync(sessionId))
    .catch((e) => log.error({ err: e }, '[Insights] generation failed'));

  import('../services/sessionEval.service.js')
    .then((m) => m.maybeAutoEvalSession(sessionId))
    .catch((e) => log.error({ err: e }, '[Evals] auto-eval failed'));

  global.io?.to(`session:${sessionId}`).emit('session:status', {
    status: 'ended',
    endedBy: 'system',
    reason: 'duration_limit',
    message: `Your session has ended after ${limitMinutes} minutes (maximum session duration).`,
    remoteTermination: true,
  });

  if (global.io) {
    void broadcastAdminEventForSession(
      global.io,
      'session:ended',
      {
        sessionId,
        endedAt: new Date(),
        endedBy: 'system',
        reason: 'duration_limit',
      },
      sessionId,
      'summary',
    );
  }
}

/** Phase 1 + phase 2 at `limitMs` from start: ask the model, then back it up. */
function armGracefulEnd(entry: ArmedSession, limitMs: number, steerText: string): void {
  const { opts } = entry;
  const { sessionId, steer } = opts;
  const graceMs = opts.graceMs ?? 75 * 1000;
  arm(
    entry,
    limitMs - (Date.now() - entry.startedAt),
    async () => {
      // Phase 1: ask the model to close out and end the session itself. The
      // grant comes first: on a crisis-flagged session end_session refuses a
      // model-initiated end unless the server asked for it.
      try {
        authorizeModelEnd(sessionId);
        await steer(sessionId, steerText, true);
        log.info(
          `Session ${sessionId} hit ${entry.limitMinutes}min limit — asked model to wrap up (${graceMs / 1000}s grace)`,
        );
      } catch (e) {
        log.error({ err: e }, 'wrap-up steer failed, will hard-end after grace');
      }
      // Phase 2: backstop if the model/client didn't end it in time.
      arm(entry, graceMs, () => hardEnd(opts, entry.limitMinutes), 'hard end');
    },
    'time limit',
  );
}

function armNormal(entry: ArmedSession): void {
  const { opts } = entry;
  const { sessionId, steer } = opts;
  const limitMs = entry.limitMinutes * 60 * 1000;
  const since = () => Date.now() - entry.startedAt;

  // Fixed-point time notices so the model can pace (ai-therapist-281). Only
  // where there is room: a 5-minute demo session gets the T-60s nudge alone.
  for (const minutes of TIME_NOTICE_MINUTES) {
    const at = limitMs - minutes * 60 * 1000;
    if (at <= 2 * 60 * 1000) continue;
    arm(
      entry,
      at - since(),
      async () => {
        await steer(sessionId, timeNotice(entry.limitMinutes - minutes, minutes), false);
      },
      `T-${minutes}min notice`,
    );
  }

  // T-60s pacing nudge (ai-therapist-112): without it the model only learns
  // about time at the hard limit, so closings were rushed or cut off entirely.
  // One minute of runway lets it consolidate and land the recap naturally.
  if (limitMs > 90 * 1000) {
    arm(
      entry,
      limitMs - 60 * 1000 - since(),
      async () => {
        // The nudge is already a server request to wrap up; a model that
        // closes early must not be refused and then told to end again.
        authorizeModelEnd(sessionId);
        await steer(sessionId, WRAP_UP_NUDGE, false);
      },
      'T-60s wrap-up nudge',
    );
  }

  armGracefulEnd(entry, limitMs, TIME_LIMIT_STEER);
}

function armCrisis(entry: ArmedSession): void {
  const { opts } = entry;
  const { sessionId, steer } = opts;
  const ceilingMs = entry.limitMinutes * 60 * 1000;
  const since = () => Date.now() - entry.startedAt;

  for (const minutes of CRISIS_NOTICE_MINUTES) {
    const at = ceilingMs - minutes * 60 * 1000;
    if (at <= since()) continue;
    arm(
      entry,
      at - since(),
      async () => {
        await steer(sessionId, crisisTimeNotice(minutes), false);
      },
      `crisis T-${minutes}min notice`,
    );
  }

  if (opts.backend === 'grok') {
    // No vendor ceiling to lean on: our graceful wrap-up moves to the ceiling.
    armGracefulEnd(entry, ceilingMs, CRISIS_CEILING_WRAP_UP);
    return;
  }

  // GPT-Live: the vendor closes the session at the ceiling (session.closed
  // reason 'expired') and the client rolls into a new session. Prepare the
  // participant a minute out; never ask the model to end. No hard end either:
  // if the vendor somehow does not expire it, the abandonment sweep and the
  // participant's own end button remain.
  arm(
    entry,
    ceilingMs - 60 * 1000 - since(),
    async () => {
      await steer(sessionId, CRISIS_CEILING_LIVE, false);
    },
    'crisis ceiling notice',
  );
}

/**
 * Arm the auto-termination timers for a session. Returns immediately; all work
 * happens on unref'd timers so they can never hold the process open. Re-arming
 * a session replaces its previous timers.
 */
export function scheduleAutoTermination(opts: AutoTerminateOptions): void {
  const { sessionId, maxDurationMinutes } = opts;
  cancelAutoTermination(sessionId);
  const entry: ArmedSession = {
    opts,
    startedAt: Date.now(),
    limitMinutes: maxDurationMinutes,
    liftedForCrisis: false,
    timers: new Set(),
  };
  armed.set(sessionId, entry);
  armNormal(entry);
  const graceMs = opts.graceMs ?? 75 * 1000;
  log.info(`Session ${sessionId} will auto-terminate in ${maxDurationMinutes} minutes (+${graceMs / 1000}s grace)`);
}

/** Drop every timer for a session (ended, or re-armed). */
export function cancelAutoTermination(sessionId: string): void {
  const entry = armed.get(sessionId);
  if (!entry) return;
  clearTimers(entry);
  armed.delete(sessionId);
}

export interface LiftResult {
  lifted: boolean;
  previousLimitMinutes: number | null;
  ceilingMinutes: number;
  /** Why nothing changed, when `lifted` is false. */
  reason?: 'not_armed' | 'already_lifted' | 'limit_at_ceiling';
}

/**
 * Lift a session's duration limit to the vendor ceiling because the
 * participant is in crisis. Idempotent; a session with no armed limit (no
 * limit configured, researcher bypass) has nothing to lift.
 */
export function liftLimitForCrisis(sessionId: string, ceilingMinutes = DEFAULT_VENDOR_CEILING_MINUTES): LiftResult {
  const entry = armed.get(sessionId);
  if (!entry) return { lifted: false, previousLimitMinutes: null, ceilingMinutes, reason: 'not_armed' };
  if (entry.liftedForCrisis) {
    return { lifted: false, previousLimitMinutes: entry.limitMinutes, ceilingMinutes, reason: 'already_lifted' };
  }
  const previous = entry.limitMinutes;
  if (previous >= ceilingMinutes) {
    // Nothing to gain in minutes, but the model should still hear the crisis
    // phrasing rather than "say goodbye and call end_session".
    clearTimers(entry);
    entry.liftedForCrisis = true;
    armCrisis(entry);
    return { lifted: false, previousLimitMinutes: previous, ceilingMinutes, reason: 'limit_at_ceiling' };
  }
  clearTimers(entry);
  entry.limitMinutes = ceilingMinutes;
  entry.liftedForCrisis = true;
  armCrisis(entry);
  log.warn(`Session ${sessionId} duration limit lifted from ${previous} to ${ceilingMinutes} minutes (crisis)`);
  return { lifted: true, previousLimitMinutes: previous, ceilingMinutes };
}

export interface SessionTimeStatus {
  elapsedMinutes: number;
  /** Null when no limit is armed for the session. */
  limitMinutes: number | null;
  remainingMinutes: number | null;
  liftedForCrisis: boolean;
}

/** What the model (get_session_time) and admins may ask about a session's clock. */
export function getSessionTimeStatus(sessionId: string): SessionTimeStatus | null {
  const entry = armed.get(sessionId);
  if (!entry) return null;
  const elapsedMinutes = Math.floor((Date.now() - entry.startedAt) / 60000);
  return {
    elapsedMinutes,
    limitMinutes: entry.limitMinutes,
    remainingMinutes: Math.max(0, entry.limitMinutes - elapsedMinutes),
    liftedForCrisis: entry.liftedForCrisis,
  };
}

/** Test hook. */
export function _armedCountForTests(): number {
  return armed.size;
}
