// Session auto-termination, shared by the Realtime and GPT-Live voice paths.
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

import { getSessionAccessInfo, updateSessionStatus } from '../db/index.js';
import { broadcastAdminEventForSession } from './adminBroadcast.js';

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
}

const WRAP_UP_NUDGE =
  '[About one minute remains in this session. Begin wrapping up naturally — consolidate one takeaway, ' +
  'no new topics. If it fits, call display_session_recap now.]';

const TIME_LIMIT_STEER =
  'TIME LIMIT REACHED: this session has hit its maximum duration. In your next reply, give a brief, warm ' +
  'closing (2-3 sentences, no new topics), then immediately call the end_session tool.';

/**
 * Finalize a session that ran past its limit: mark it ended, tear down the
 * backend connection, and kick off the post-session pipeline.
 *
 * Every post-session job is fire-and-forget and independently guarded, because
 * a failure in (say) insight generation must not prevent the recording from
 * being finalized or the participant from being told the session ended.
 */
async function hardEnd(opts: AutoTerminateOptions): Promise<void> {
  const { sessionId, maxDurationMinutes, teardown } = opts;
  console.log(`⏰ Auto-terminating session ${sessionId} after ${maxDurationMinutes} minutes (+grace)`);
  await updateSessionStatus(sessionId, 'ended', 'system');

  try {
    await teardown(sessionId);
  } catch (e) {
    console.error('[AutoTerminate] Backend teardown failed:', e);
  }

  import('../services/sessionRedaction.service.js')
    .then(m => m.redactSession(sessionId))
    .catch(e => console.error('[Redaction] session redaction failed:', e));

  import('../services/recorder.service.js')
    .then(m => m.finalize(sessionId))
    .catch(e => console.error('[Recorder] finalize failed:', e));

  import('../services/sessionInsights.service.js')
    .then(m => m.generateSessionInsightsAsync(sessionId))
    .catch(e => console.error('[Insights] generation failed:', e));

  import('../services/sessionEval.service.js')
    .then(m => m.maybeAutoEvalSession(sessionId))
    .catch(e => console.error('[Evals] auto-eval failed:', e));

  global.io?.to(`session:${sessionId}`).emit('session:status', {
    status: 'ended',
    endedBy: 'system',
    reason: 'duration_limit',
    message: `Your session has ended after ${maxDurationMinutes} minutes (maximum session duration).`,
    remoteTermination: true,
  });

  if (global.io) {
    void broadcastAdminEventForSession(global.io, 'session:ended', {
      sessionId, endedAt: new Date(), endedBy: 'system', reason: 'duration_limit',
    }, sessionId, 'summary');
  }
}

/**
 * Arm the auto-termination timers for a session. Returns immediately; all work
 * happens on unref'd timers so they can never hold the process open.
 */
export function scheduleAutoTermination(opts: AutoTerminateOptions): void {
  const { sessionId, maxDurationMinutes, steer } = opts;
  const durationMs = maxDurationMinutes * 60 * 1000;
  const graceMs = opts.graceMs ?? 75 * 1000;

  // T-60s pacing nudge (ai-therapist-112): without it the model only learns
  // about time at the hard limit, so closings were rushed or cut off entirely.
  // One minute of runway lets it consolidate and land the recap naturally.
  if (durationMs > 90 * 1000) {
    const nudge = setTimeout(async () => {
      try {
        const current = await getSessionAccessInfo(sessionId);
        if (!current || current.status !== 'active') return;
        await steer(sessionId, WRAP_UP_NUDGE, false);
      } catch (err) {
        console.error(`[AutoTerminate] T-60s wrap-up nudge failed for ${sessionId}:`, err);
      }
    }, durationMs - 60 * 1000);
    nudge.unref?.();
  }

  const limit = setTimeout(async () => {
    try {
      const current = await getSessionAccessInfo(sessionId);
      if (!current || current.status !== 'active') return;

      // Phase 1: ask the model to close out and end the session itself.
      try {
        await steer(sessionId, TIME_LIMIT_STEER, true);
        console.log(
          `⏰ Session ${sessionId} hit ${maxDurationMinutes}min limit — asked model to wrap up ` +
          `(${graceMs / 1000}s grace)`,
        );
      } catch (e) {
        console.error('[AutoTerminate] wrap-up steer failed, will hard-end after grace:', e);
      }

      // Phase 2: backstop if the model/client didn't end it in time.
      const backstop = setTimeout(async () => {
        try {
          const after = await getSessionAccessInfo(sessionId);
          if (after && after.status === 'active') await hardEnd(opts);
        } catch (err) {
          console.error(`[AutoTerminate] Failed to hard-end session ${sessionId}:`, err);
        }
      }, graceMs);
      backstop.unref?.();
    } catch (err) {
      console.error(`[AutoTerminate] Failed to auto-terminate session ${sessionId}:`, err);
    }
  }, durationMs);
  limit.unref?.();

  console.log(
    `Session ${sessionId} will auto-terminate in ${maxDurationMinutes} minutes (+${graceMs / 1000}s grace)`,
  );
}
