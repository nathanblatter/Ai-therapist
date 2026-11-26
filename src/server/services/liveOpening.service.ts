// Server-authored opening for GPT-Live voice sessions (ai-therapist-214, -315).
//
// GPT-Live never speaks unprompted, so every voice session needs to be told to
// speak first: the AI disclosure preamble, or the speak-first nudge on a crisis
// recovery session. The browser used to send that itself on its data channel.
// The data channel is now locked (session.client.data_channel.allowed_client_events
// in liveSessionConfig.ts), so the server authors the text at session creation
// and delivers it in two places, the vendor's documented greeting recipe
// (live-conversations, "Greet before the caller speaks"):
//
//   1. as a `developer` message in the session's startup `input`
//      (buildLiveSessionConfig, `speakFirst`), and
//   2. once more as `session.commentary.append` over the sideband when the
//      browser reports `session.started`.
//
// Until ai-therapist-315 the ordinary opening was step 2 alone, as an
// instructions append: one start in six or so stayed silent, and the
// participant never heard the disclosure. Recovery sessions had already moved
// to the recipe (ai-therapist-293) and stopped going silent in measurement.
//
// Why step 2 is not sent the moment the sideband attaches: the HTTP request
// starts the OpenAI session before the browser has applied the SDP answer, so
// speech triggered then would play into a peer connection that is not up yet
// and the participant would miss the start of the disclosure. The browser
// therefore still decides WHEN (it calls POST /api/sessions/:id/opening on
// `session.started`), but no longer WHAT: the text never leaves the server.
//
// For the ORDINARY opening that two-step recipe is opt-in
// (LIVE_OPENING_DELIVERY=recipe, see liveOpeningDelivery below); by default it
// is still step 2 alone as an instructions append, the vendor's channel for a
// disclosure's exact wording. The live measurement of 2026-11-26 found the
// recipe keeps the wording as closely; switching the default is the PI's call.
//
// The vendor still does not guarantee speech, so a delivered ordinary opening
// is watched in either delivery (see "Opening watchdog" below).
//
// State is in-process, like the sideband socket it is delivered on.
import { createLogger } from '../utils/logger.js';
import { LIVE_OPENING_RETRIGGER_MS, LIVE_OPENING_UNSPOKEN_MS } from '../../shared/liveOpeningWatch.js';

const log = createLogger('liveOpening');

export type LiveOpeningVia = 'instructions' | 'commentary';

/**
 * How the ORDINARY opening is delivered, from the LIVE_OPENING_DELIVERY env var
 * (an env var, not a system_config flag: flipping a feature flag inside the
 * study window is itself a recorded deviation, and this must be switchable
 * after measurement without one).
 *
 *   instructions (default) - one `session.instructions.append` at
 *     `session.started`, the delivery that shipped before ai-therapist-315 and
 *     the channel the vendor names for a disclosure's exact wording
 *     (live-conversations, "Deliver a disclosure": "Use
 *     session.instructions.append to request specific spoken wording for a
 *     disclosure. session.commentary.append may paraphrase the text.").
 *   recipe - the greeting recipe: a `developer` message in `session.input` at
 *     creation plus one `session.commentary.append` at `session.started`, as a
 *     recovery session does. Measured on 40 ordinary starts on 2026-11-26
 *     (docs/gpt-live.md, "Opening preamble"): first word at a median 0.67 s
 *     against 1.83 s, the disclosure kept as closely as under `instructions`
 *     and never said twice. Still not the default: changing how the
 *     IRB-described disclosure is delivered is the PI's decision.
 *
 * The watchdog (re-send at 4 s, on-screen text at 8 s) runs in both modes: it
 * acts only on a start that has not spoken.
 */
export type LiveOpeningDelivery = 'instructions' | 'recipe';

export function liveOpeningDelivery(env: NodeJS.ProcessEnv = process.env): LiveOpeningDelivery {
  return env.LIVE_OPENING_DELIVERY?.trim().toLowerCase() === 'recipe' ? 'recipe' : 'instructions';
}

/** How the watch on a delivered opening ended. */
export type LiveOpeningOutcome = 'spoken' | 'participant_first' | 'crisis' | 'unspoken' | 'closed';

interface OpeningWatch {
  armedAt: number;
  timers: NodeJS.Timeout[];
  retriggerAt: number | null;
  unspokenAt: number | null;
  outcome: LiveOpeningOutcome | null;
  recordTimer: NodeJS.Timeout | null;
  recorded: boolean;
}

interface PendingOpening {
  text: string;
  /** Written to the messages table on delivery, as the browser used to log it. */
  logMessage: string;
  /**
   * How the text is sent at `session.started`. `commentary` is the documented
   * way to have GPT-Live open a conversation and is what every opening uses
   * since ai-therapist-315; `instructions` remains for callers that ask.
   */
  via: LiveOpeningVia;
  /**
   * Arm the silent-start watchdog when this opening is delivered. Ordinary
   * sessions only: a recovery session has its own re-send in the sideband
   * (armRecoverySpeakWatchdog), and two watchdogs would send it twice.
   */
  watch: boolean;
  registeredAt: number;
  delivered: boolean;
  /** First sightings since registration (ms epoch; null = not yet). */
  assistantAudioAt: number | null;
  assistantTranscriptAt: number | null;
  /** Participant speech before any assistant speech (a barge-in before the opening). */
  participantFirstAt: number | null;
  crisisAt: number | null;
  watchState: OpeningWatch | null;
}

/** An opening is only meaningful in the first moments of a session. */
const OPENING_TTL_MS = 10 * 60 * 1000;

/**
 * After the opening is spoken, how long to wait before recording its timing,
 * so the row carries both the first audio and the first transcript (the
 * transcript trails the audio).
 */
const RECORD_SETTLE_MS = 3_000;

/** After giving up on an unspoken opening, how long the record waits for late speech. */
const RECORD_LATE_SPEECH_MS = 15_000;

const openings = new Map<string, PendingOpening>();

function purgeExpired(now: number): void {
  for (const [id, entry] of openings) {
    if (now - entry.registeredAt > OPENING_TTL_MS) {
      stopWatchTimers(entry);
      openings.delete(id);
    }
  }
}

/** Record the opening for a session that has just been created. */
export function registerLiveOpening(
  sessionId: string,
  opening: { text: string; logMessage: string; via?: LiveOpeningVia; watch?: boolean },
): void {
  const now = Date.now();
  purgeExpired(now);
  const previous = openings.get(sessionId);
  if (previous) stopWatchTimers(previous);
  openings.set(sessionId, {
    text: opening.text,
    logMessage: opening.logMessage,
    via: opening.via ?? 'instructions',
    watch: opening.watch === true,
    registeredAt: now,
    delivered: false,
    assistantAudioAt: null,
    assistantTranscriptAt: null,
    participantFirstAt: null,
    crisisAt: null,
    watchState: null,
  });
}

export type LiveOpeningResult =
  | { delivered: true; already: boolean; logMessage: string | null }
  | { delivered: false; reason: 'none_registered' | 'sideband_unavailable' };

function assistantHasSpoken(entry: PendingOpening): boolean {
  return entry.assistantAudioAt !== null || entry.assistantTranscriptAt !== null;
}

/**
 * Deliver a session's opening exactly once.
 *
 * `inject` is the sideband send; it returns false when the text could not be
 * sent. A failed delivery leaves the opening registered so the caller can
 * retry, and a repeat call after success reports `already` without speaking
 * the disclosure twice.
 *
 * When the assistant has already started speaking (the startup developer
 * message alone can make it greet), nothing is sent: the opening is under way
 * and a second trigger would have it say the disclosure twice. It counts as
 * delivered, so the record and the watch still happen.
 */
export async function deliverLiveOpening(
  sessionId: string,
  inject: (text: string, via: LiveOpeningVia) => Promise<boolean>,
): Promise<LiveOpeningResult> {
  purgeExpired(Date.now());
  const entry = openings.get(sessionId);
  if (!entry) return { delivered: false, reason: 'none_registered' };
  if (entry.delivered) return { delivered: true, already: true, logMessage: null };

  // Claimed before the await so two overlapping requests cannot both inject.
  entry.delivered = true;
  if (assistantHasSpoken(entry)) {
    log.info(`Live opening for ${sessionId} already being spoken at the request; not sending it again`);
    return { delivered: true, already: false, logMessage: entry.logMessage };
  }
  let ok = false;
  try {
    ok = await inject(entry.text, entry.via);
  } catch {
    ok = false;
  }
  if (!ok) {
    entry.delivered = false;
    return { delivered: false, reason: 'sideband_unavailable' };
  }
  return { delivered: true, already: false, logMessage: entry.logMessage };
}

function sendOverSideband(sessionId: string, text: string, via: LiveOpeningVia): Promise<boolean> {
  return import('./sidebandManager.service.js').then(({ sidebandManager }) =>
    via === 'commentary'
      ? sidebandManager.tryCommentary(sessionId, text)
      : sidebandManager.tryInject(sessionId, 'system', text, true),
  );
}

/**
 * Deliver over the real sideband and write the record the browser used to log.
 * Shared by the route and the fallback timer so both leave the same trail.
 */
export async function deliverLiveOpeningViaSideband(sessionId: string): Promise<LiveOpeningResult> {
  const result = await deliverLiveOpening(sessionId, (text, via) => sendOverSideband(sessionId, text, via));
  if (result.delivered && !result.already) {
    armLiveOpeningWatch(sessionId);
    if (result.logMessage) {
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

// ---------------------------------------------------------------------------
// Opening watchdog (ai-therapist-315)
// ---------------------------------------------------------------------------
//
// From the moment an ordinary opening is delivered (the browser's request, or
// the server's own fallback):
//
//   - the first assistant audio or transcript latches it as spoken; nothing is
//     ever sent again;
//   - participant speech before any assistant speech stands it down (a
//     barge-in before the opening is legitimate, and the model is answering);
//   - a crisis signal (a risk steer, crisis resources for our own high flag,
//     or a vendor stop or cut) stands it down: the crisis path owns the next
//     words;
//   - LIVE_OPENING_RETRIGGER_MS with none of those: the opening is sent once
//     more as commentary;
//   - LIVE_OPENING_UNSPOKEN_MS with none of those: no further send. Logged
//     (`LIVE OPENING UNSPOKEN`), broadcast to admins (`live:opening-unspoken`),
//     noted in the session's messages, and sent to the participant's browser
//     (`session:opening-unspoken`), which shows the opening's text as the
//     assistant's message so the disclosure is at least on screen.
//
// The latch lives here, keyed by session, not on the sideband's per-attach
// state, so a sideband reconnect in the first seconds neither loses it nor
// re-arms anything.
//
// Every delivered opening, recovery included, also gets its timing recorded
// once (a `live_opening` client_events row, numbers only); only ordinary ones
// get the timers.

/** Effects of the watchdog, swappable in tests. */
export interface LiveOpeningWatchDeps {
  /** Re-send the opening as commentary; false when it could not be sent. */
  resend(sessionId: string, text: string): Promise<boolean>;
  /** The opening was never spoken: tell the participant's browser, the admins and the record. */
  onUnspoken(sessionId: string): Promise<void>;
  /** Persist the timing record. */
  record(sessionId: string, detail: LiveOpeningTiming): Promise<void>;
  /** A re-trigger was sent (admin broadcast). */
  onRetrigger(sessionId: string, afterMs: number, sent: boolean): void;
}

/**
 * The `live_opening` record: ms relative to the opening request (negative =
 * before it), null = did not happen. Numbers only, nothing anyone said.
 */
export interface LiveOpeningTiming {
  /** Session creation to the opening request. */
  requestAfterCreateMs: number;
  firstAudioMs: number | null;
  firstTranscriptMs: number | null;
  participantFirstMs: number | null;
  crisisMs: number | null;
  retriggerMs: number | null;
  unspokenMs: number | null;
  /** 1 when the watchdog ran on this opening (ordinary sessions), 0 for a measure-only record. */
  watched: 0 | 1;
}

const defaultDeps: LiveOpeningWatchDeps = {
  resend: (sessionId, text) => sendOverSideband(sessionId, text, 'commentary'),
  async onUnspoken(sessionId) {
    if (global.io) {
      global.io.to(`session:${sessionId}`).emit('session:opening-unspoken', { sessionId });
      const { broadcastAdminEventForSession } = await import('../utils/adminBroadcast.js');
      void broadcastAdminEventForSession(
        global.io,
        'live:opening-unspoken',
        { sessionId, afterMs: LIVE_OPENING_UNSPOKEN_MS, timestamp: new Date() },
        sessionId,
      );
    }
    const note = `Live opening not spoken within ${LIVE_OPENING_UNSPOKEN_MS / 1000} s; its text was shown on screen`;
    const { insertMessage } = await import('../db/index.js');
    await insertMessage(sessionId, 'system', 'system', note, note, { source: 'live-opening-unspoken' });
  },
  async record(sessionId, detail) {
    const { insertClientEvent } = await import('../db/index.js');
    await insertClientEvent({ sessionId, kind: 'live_opening', detail: { ...detail } });
  },
  onRetrigger(sessionId, afterMs, sent) {
    if (!global.io) return;
    void import('../utils/adminBroadcast.js').then(({ broadcastAdminEventForSession }) =>
      broadcastAdminEventForSession(
        global.io,
        'live:opening-silent',
        { sessionId, afterMs, sent, timestamp: new Date() },
        sessionId,
      ),
    );
  },
};

let deps: LiveOpeningWatchDeps = defaultDeps;

function stopWatchTimers(entry: PendingOpening): void {
  const w = entry.watchState;
  if (!w) return;
  for (const t of w.timers) clearTimeout(t);
  w.timers = [];
}

function rel(at: number | null, base: number): number | null {
  return at === null ? null : at - base;
}

function writeRecord(sessionId: string, entry: PendingOpening): void {
  const w = entry.watchState;
  if (!w || w.recorded) return;
  w.recorded = true;
  if (w.recordTimer) {
    clearTimeout(w.recordTimer);
    w.recordTimer = null;
  }
  const detail: LiveOpeningTiming = {
    requestAfterCreateMs: w.armedAt - entry.registeredAt,
    firstAudioMs: rel(entry.assistantAudioAt, w.armedAt),
    firstTranscriptMs: rel(entry.assistantTranscriptAt, w.armedAt),
    participantFirstMs: rel(entry.participantFirstAt, w.armedAt),
    crisisMs: rel(entry.crisisAt, w.armedAt),
    retriggerMs: rel(w.retriggerAt, w.armedAt),
    unspokenMs: rel(w.unspokenAt, w.armedAt),
    watched: entry.watch ? 1 : 0,
  };
  log.info({ sessionId, outcome: w.outcome, ...detail }, 'live opening timing');
  deps
    .record(sessionId, detail)
    .catch((err: unknown) => log.error({ err }, 'Failed to record the live opening timing'));
}

function settle(sessionId: string, entry: PendingOpening, outcome: LiveOpeningOutcome): void {
  const w = entry.watchState;
  if (!w || w.outcome) return;
  w.outcome = outcome;
  stopWatchTimers(entry);
  if (outcome === 'spoken' || outcome === 'unspoken') {
    // Spoken: wait for the other of audio / transcript to arrive. Unspoken:
    // wait in case the model speaks after all (the latch still notes it), so
    // the record tells a late start from one that never spoke. A close before
    // then records at once (clearLiveOpening).
    w.recordTimer = setTimeout(
      () => writeRecord(sessionId, entry),
      outcome === 'spoken' ? RECORD_SETTLE_MS : RECORD_LATE_SPEECH_MS,
    );
    w.recordTimer.unref?.();
  } else {
    writeRecord(sessionId, entry);
  }
}

/** Start watching a just-delivered opening. Idempotent. */
export function armLiveOpeningWatch(sessionId: string): void {
  const entry = openings.get(sessionId);
  if (!entry || entry.watchState) return;
  const w: OpeningWatch = {
    armedAt: Date.now(),
    timers: [],
    retriggerAt: null,
    unspokenAt: null,
    outcome: null,
    recordTimer: null,
    recorded: false,
  };
  entry.watchState = w;

  // Anything that happened before the request decides it at once.
  if (assistantHasSpoken(entry)) return settle(sessionId, entry, 'spoken');
  if (entry.crisisAt !== null) return settle(sessionId, entry, 'crisis');
  if (entry.participantFirstAt !== null) return settle(sessionId, entry, 'participant_first');
  if (!entry.watch) return; // measure-only: settles on speech or close

  const retrigger = setTimeout(() => void onRetriggerDue(sessionId, entry), LIVE_OPENING_RETRIGGER_MS);
  const unspoken = setTimeout(() => void onUnspokenDue(sessionId, entry), LIVE_OPENING_UNSPOKEN_MS);
  retrigger.unref?.();
  unspoken.unref?.();
  w.timers.push(retrigger, unspoken);
}

async function onRetriggerDue(sessionId: string, entry: PendingOpening): Promise<void> {
  const w = entry.watchState;
  if (!w || w.outcome || w.retriggerAt !== null) return;
  w.retriggerAt = Date.now();
  const afterMs = w.retriggerAt - w.armedAt;
  log.warn(
    `LIVE OPENING SILENT for ${sessionId}: no assistant speech ${afterMs} ms after the opening was requested; ` +
      'sending it once more as commentary',
  );
  let sent = false;
  try {
    sent = await deps.resend(sessionId, entry.text);
  } catch (err) {
    log.error({ err }, `Live opening re-trigger failed for ${sessionId}`);
  }
  if (!sent) log.error(`Live opening re-trigger NOT sent for ${sessionId} (sideband unavailable)`);
  deps.onRetrigger(sessionId, afterMs, sent);
}

async function onUnspokenDue(sessionId: string, entry: PendingOpening): Promise<void> {
  const w = entry.watchState;
  if (!w || w.outcome) return;
  w.unspokenAt = Date.now();
  log.error(
    `LIVE OPENING UNSPOKEN for ${sessionId}: no assistant speech ${w.unspokenAt - w.armedAt} ms after the ` +
      'opening was requested, after one re-send; showing its text on screen. The participant has not heard ' +
      'the AI disclosure.',
  );
  settle(sessionId, entry, 'unspoken');
  try {
    await deps.onUnspoken(sessionId);
  } catch (err) {
    log.error({ err }, `Could not signal the unspoken live opening for ${sessionId}`);
  }
}

/** True while the session's opening has not been heard yet (the sideband skips audio decoding otherwise). */
export function liveOpeningAwaitingSpeech(sessionId: string): boolean {
  const entry = openings.get(sessionId);
  return !!entry && entry.assistantAudioAt === null;
}

/** First assistant audio (audible) or transcript fragment of the session. */
export function noteLiveOpeningAssistantSpeech(sessionId: string, kind: 'audio' | 'transcript'): void {
  const entry = openings.get(sessionId);
  if (!entry) return;
  const now = Date.now();
  if (kind === 'audio' && entry.assistantAudioAt === null) entry.assistantAudioAt = now;
  if (kind === 'transcript' && entry.assistantTranscriptAt === null) entry.assistantTranscriptAt = now;
  settle(sessionId, entry, 'spoken');
}

/** Participant speech. Only counts before any assistant speech. */
export function noteLiveOpeningParticipantSpeech(sessionId: string): void {
  const entry = openings.get(sessionId);
  if (!entry || assistantHasSpoken(entry) || entry.participantFirstAt !== null) return;
  entry.participantFirstAt = Date.now();
  settle(sessionId, entry, 'participant_first');
}

/** A crisis signal: the crisis path's words take priority over the opening. */
export function noteLiveOpeningCrisis(sessionId: string): void {
  const entry = openings.get(sessionId);
  if (!entry) return;
  if (entry.crisisAt === null) entry.crisisAt = Date.now();
  settle(sessionId, entry, 'crisis');
}

/** Drop a session's opening (session ended, or start failed), recording a watched one first. */
export function clearLiveOpening(sessionId: string): void {
  const entry = openings.get(sessionId);
  if (!entry) return;
  if (entry.watchState) {
    settle(sessionId, entry, 'closed');
    writeRecord(sessionId, entry);
  }
  stopWatchTimers(entry);
  openings.delete(sessionId);
}

/** Test hooks. */
export function _resetLiveOpeningsForTests(): void {
  for (const entry of openings.values()) {
    stopWatchTimers(entry);
    if (entry.watchState?.recordTimer) clearTimeout(entry.watchState.recordTimer);
  }
  openings.clear();
  deps = defaultDeps;
}

export function _setLiveOpeningWatchDepsForTests(override: Partial<LiveOpeningWatchDeps>): void {
  deps = { ...defaultDeps, ...override };
}

export function _liveOpeningOutcomeForTests(sessionId: string): LiveOpeningOutcome | null {
  return openings.get(sessionId)?.watchState?.outcome ?? null;
}
