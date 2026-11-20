// The GPT-Live opening watchdog's bounds and its on-screen fallback
// (ai-therapist-315), shared by the server (services/liveOpening.service.ts)
// and the browser (App.tsx) so the two can never disagree about them.
//
// Why a watchdog at all: GPT-Live never speaks unprompted, and the vendor is
// explicit that startup instructions "can improve greeting behavior, but do
// not guarantee that the model will speak" (live-conversations, "Greet before
// the caller speaks"). The opening carries the AI disclosure, so a silent
// start means the participant never hears that they are talking to an AI.
import { CHAT_OPENING_INVITATION, openingPreamble, type OpeningCrisisContact } from './openingPrompt.js';

/**
 * No assistant audio or transcript this long after the opening was requested:
 * send the opening once more, as commentary. A healthy start with the
 * documented recipe speaks 0.6 to 1.6 s after `session.started`, and up to
 * 3.2 s with the older instructions-append delivery (docs/gpt-live.md,
 * measured 2026-11-18); 4 s waits out that whole range, the same first bound
 * the recovery session's re-send uses (RECOVERY_SPEAK_RETRY_MS).
 */
export const LIVE_OPENING_RETRIGGER_MS = 4_000;

/**
 * Still nothing this long after the request (4 s after the re-trigger, again
 * past the slowest healthy start): stop trying, record it, and show the
 * opening's text on screen. Never a third send: re-sends did not rescue the
 * recovery sessions that stayed silent (two of them through re-sends at 4 s
 * and 8 s), and a model that finally answers both would say the disclosure
 * twice.
 */
export const LIVE_OPENING_UNSPOKEN_MS = 8_000;

/**
 * The browser's own backstop, for when the server's socket event is lost
 * (the participant socket is unreliable through the tunnel, ai-therapist-18):
 * it shows the text itself if it has seen no assistant caption this long after
 * the opening was requested. Later than the server's bound because the browser
 * sees only captions, which trail the audio, and must not cover a slow but
 * spoken start. The same 12 s as the recovery screen's own bound.
 */
export const LIVE_OPENING_CLIENT_BACKSTOP_MS = 12_000;

/**
 * What the participant sees, as the assistant's message, when the opening was
 * never spoken: the opening's own words (the voice preamble the voice model is
 * told to say, microphone note included), ending with the typed-chat
 * invitation when lead_conversation is on, exactly as a typed-chat opening
 * does (server/utils/openingLine.ts). No new wording.
 */
export function liveOpeningScreenText(crisis: OpeningCrisisContact, leadConversation: boolean): string {
  const preamble = openingPreamble(crisis, true);
  return leadConversation ? `${preamble} ${CHAT_OPENING_INVITATION}` : preamble;
}

/** What the browser knows when its backstop timer fires (times in ms; null = not seen). */
export interface ClientOpeningFallbackInput {
  /**
   * `server`: the server's watchdog gave up (`session:opening-unspoken`); it
   * has already applied the bounds and the participant-first rule. `client`:
   * the browser's own backstop timer.
   */
  source: 'server' | 'client';
  now: number;
  /** When the server confirmed it delivered the opening (null = the browser never got that answer). */
  requestedAt: number | null;
  /** First assistant caption fragment of this call. */
  assistantSpokeAt: number | null;
  /** First participant caption fragment of this call. */
  participantSpokeAt: number | null;
  /** The crisis resource card is up, or the call is in crisis or recovery. */
  crisis: boolean;
  /** Already shown (by the server's event or an earlier check). */
  shown: boolean;
}

/** Should the browser put the opening's text on screen now? */
export function clientOpeningFallbackDue(i: ClientOpeningFallbackInput): boolean {
  if (i.shown || i.crisis) return false;
  // Latch: a caption means the assistant is speaking (or has spoken).
  if (i.assistantSpokeAt !== null) return false;
  if (i.source === 'server') return true;
  // A participant who speaks first is being answered; the model's reply is
  // not a silent start.
  if (i.participantSpokeAt !== null || i.requestedAt === null) return false;
  return i.now - i.requestedAt >= LIVE_OPENING_CLIENT_BACKSTOP_MS;
}
