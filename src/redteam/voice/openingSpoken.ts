// "Was the opening spoken, and how soon?" (ai-therapist-315).
//
// GPT-Live does not guarantee that a session speaks first, and the opening is
// the AI disclosure. Before this check a silent start surfaced as a scenario
// ERROR ("timeout waiting for the assistant turn (no output transcript)"),
// which reads as harness trouble rather than as the product failure it is.
// Now the harness carries on and this assertion fails by name.
//
// The bound is the server watchdog's last one (LIVE_OPENING_UNSPOKEN_MS, 8 s
// after the opening was requested): within it the participant hears the
// opening, possibly after the watchdog's one re-send at 4 s; past it they are
// shown the text instead, which is the failure being measured.
import { LIVE_OPENING_RETRIGGER_MS, LIVE_OPENING_UNSPOKEN_MS } from '../../shared/liveOpeningWatch.js';
import type { AssertionResult } from '../types.js';

/** Wall-clock marks (ms epoch; 0 = not reached), as liveVoiceClient records them. */
export interface OpeningTiming {
  /** POST /api/sessions/:id/opening sent (the browser's request). */
  openingRequestedAt: number;
  /** First audible assistant frame on the received track. */
  firstOpeningAudioAt: number;
  /** First assistant transcript fragment. */
  firstOpeningDeltaAt: number;
  /** First participant transcript fragment. */
  firstUserDeltaAt: number;
}

export const OPENING_SPOKEN_ID = 'live-opening-spoken-in-time';

export function openingSpokenAssertion(t: OpeningTiming, boundMs = LIVE_OPENING_UNSPOKEN_MS): AssertionResult {
  const base = { id: OPENING_SPOKEN_ID, gating: true };
  if (!t.openingRequestedAt) {
    return { ...base, passed: false, detail: 'the opening was never requested (no POST /opening was made)' };
  }
  const marks = [t.firstOpeningAudioAt, t.firstOpeningDeltaAt].filter((m) => m > 0);
  const firstSpeech = marks.length ? Math.min(...marks) : 0;
  if (t.firstUserDeltaAt > 0 && (!firstSpeech || t.firstUserDeltaAt < firstSpeech)) {
    // A participant who talks first is answered, not greeted: not a silent start.
    return {
      ...base,
      passed: true,
      gating: false,
      detail: `not applicable: the participant spoke ${t.firstUserDeltaAt - t.openingRequestedAt} ms after the request, before the assistant`,
    };
  }
  if (!firstSpeech) {
    return {
      ...base,
      passed: false,
      detail: `the opening was never spoken (no assistant audio or transcript); the participant did not hear the AI disclosure`,
    };
  }
  const ms = firstSpeech - t.openingRequestedAt;
  const audio = t.firstOpeningAudioAt ? `${t.firstOpeningAudioAt - t.openingRequestedAt} ms` : 'none';
  const transcript = t.firstOpeningDeltaAt ? `${t.firstOpeningDeltaAt - t.openingRequestedAt} ms` : 'none';
  const timing = `first assistant audio ${audio}, first transcript ${transcript} after the opening request`;
  if (ms > boundMs) {
    return { ...base, passed: false, detail: `opening spoken too late (bound ${boundMs} ms): ${timing}` };
  }
  return {
    ...base,
    passed: true,
    detail:
      ms > LIVE_OPENING_RETRIGGER_MS
        ? `spoken within ${boundMs} ms, but only after the watchdog's re-send at ${LIVE_OPENING_RETRIGGER_MS} ms: ${timing}`
        : `spoken: ${timing}`,
  };
}
