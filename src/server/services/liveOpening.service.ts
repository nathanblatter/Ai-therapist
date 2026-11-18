// Server-authored opening for GPT-Live voice sessions (ai-therapist-214).
//
// GPT-Live never speaks unprompted, so every voice session needs an
// instructions append telling the model to speak first: the AI disclosure
// preamble, or the speak-first nudge on a content-filter recovery session.
// The browser used to send that append itself on its data channel. The data
// channel is now locked (session.client.data_channel.allowed_client_events in
// liveSessionConfig.ts), so the server authors the text at session creation and
// delivers it over the sideband.
//
// Why it is not sent the moment the sideband attaches: the HTTP request starts
// the OpenAI session before the browser has applied the SDP answer, so speech
// triggered then would play into a peer connection that is not up yet and the
// participant would miss the start of the disclosure. The browser therefore
// still decides WHEN (it calls POST /api/sessions/:id/opening on
// `session.started`), but no longer WHAT: the text never leaves the server.
//
// State is in-process, like the sideband socket it is delivered on.
import { createLogger } from '../utils/logger.js';

const log = createLogger('liveOpening');

interface PendingOpening {
  text: string;
  /** Written to the messages table on delivery, as the browser used to log it. */
  logMessage: string;
  registeredAt: number;
  delivered: boolean;
}

/** An opening is only meaningful in the first moments of a session. */
const OPENING_TTL_MS = 10 * 60 * 1000;

const openings = new Map<string, PendingOpening>();

function purgeExpired(now: number): void {
  for (const [id, entry] of openings) {
    if (now - entry.registeredAt > OPENING_TTL_MS) openings.delete(id);
  }
}

/** Record the opening for a session that has just been created. */
export function registerLiveOpening(sessionId: string, opening: { text: string; logMessage: string }): void {
  const now = Date.now();
  purgeExpired(now);
  openings.set(sessionId, { ...opening, registeredAt: now, delivered: false });
}

export type LiveOpeningResult =
  | { delivered: true; already: boolean; logMessage: string | null }
  | { delivered: false; reason: 'none_registered' | 'sideband_unavailable' };

/**
 * Deliver a session's opening exactly once.
 *
 * `inject` is the sideband steer; it returns false when the append could not
 * be sent. A failed delivery leaves the opening registered so the caller can
 * retry, and a repeat call after success reports `already` without speaking
 * the disclosure twice.
 */
export async function deliverLiveOpening(
  sessionId: string,
  inject: (text: string) => Promise<boolean>,
): Promise<LiveOpeningResult> {
  purgeExpired(Date.now());
  const entry = openings.get(sessionId);
  if (!entry) return { delivered: false, reason: 'none_registered' };
  if (entry.delivered) return { delivered: true, already: true, logMessage: null };

  // Claimed before the await so two overlapping requests cannot both inject.
  entry.delivered = true;
  let ok = false;
  try {
    ok = await inject(entry.text);
  } catch {
    ok = false;
  }
  if (!ok) {
    entry.delivered = false;
    return { delivered: false, reason: 'sideband_unavailable' };
  }
  return { delivered: true, already: false, logMessage: entry.logMessage };
}

/**
 * Deliver over the real sideband and write the record the browser used to log.
 * Shared by the route and the fallback timer so both leave the same trail.
 */
export async function deliverLiveOpeningViaSideband(sessionId: string): Promise<LiveOpeningResult> {
  const { sidebandManager } = await import('./sidebandManager.service.js');
  const result = await deliverLiveOpening(sessionId, (text) =>
    sidebandManager.tryInject(sessionId, 'system', text, true),
  );
  if (result.delivered && !result.already && result.logMessage) {
    // Server-authored text with no participant content, so the redacted column
    // can carry it verbatim. A logging failure must not undo the delivery: the
    // opening has already been spoken.
    try {
      const { insertMessage } = await import('../db/index.js');
      await insertMessage(sessionId, 'system', 'system', result.logMessage, result.logMessage, {
        source: 'live-opening',
      });
    } catch (err) {
      log.error({ err }, 'Failed to log the live opening');
    }
  }
  return result;
}

/**
 * How long the server waits for the browser to ask for the opening before
 * speaking it anyway.
 *
 * The browser normally asks within a second or two of the SDP answer. A tab
 * still running a bundle from before the data channel was locked never asks:
 * it sends its own instructions append, which the API now refuses. Without
 * this backstop that participant would get a silent session and no AI
 * disclosure. Long enough that the browser's audio path is up; delivery is
 * once-only, so a browser that asks later gets `already`.
 */
export const LIVE_OPENING_FALLBACK_MS = 10_000;

/** Arm the backstop for a registered opening. The timer never holds the process open. */
export function scheduleLiveOpeningFallback(sessionId: string, delayMs = LIVE_OPENING_FALLBACK_MS): void {
  const timer = setTimeout(() => {
    const entry = openings.get(sessionId);
    if (!entry || entry.delivered) return;
    log.warn(`Browser never requested the live opening for ${sessionId}; delivering it from the server`);
    deliverLiveOpeningViaSideband(sessionId)
      .then((result) => {
        if (!result.delivered) log.error(`Live opening fallback NOT delivered for ${sessionId} (${result.reason})`);
      })
      .catch((err: unknown) => log.error({ err }, 'Live opening fallback failed'));
  }, delayMs);
  timer.unref?.();
}

/** Drop a session's opening (session ended, or start failed). */
export function clearLiveOpening(sessionId: string): void {
  openings.delete(sessionId);
}

/** Test hook. */
export function _resetLiveOpeningsForTests(): void {
  openings.clear();
}
