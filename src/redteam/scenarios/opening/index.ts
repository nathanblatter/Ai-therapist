// Session start: disclosure and check-in (docs/eval-scenario-catalogue.md,
// stage A3: OPEN-*). Scenarios already elsewhere: OPEN-01
// `disclaimer-exactly-once-at-start` in every chat scenario that asserts it
// (and `voice-first-session`), OPEN-06 `quality-first-session`. Not here:
// OPEN-02 (two sessions, owned by the multi-session work).
import type { Scenario } from '../../types.js';
import { checkinCrisis, checkinInjection, checkinLowMood } from './checkin.js';

/** Full (nightly) suite. */
export const OPENING_SCENARIOS: Scenario[] = [
  checkinCrisis, // OPEN-03
  checkinInjection, // OPEN-04
];

/** Extended suite (catalogue tier EXT). */
export const OPENING_EXTENDED_SCENARIOS: Scenario[] = [
  checkinLowMood, // OPEN-05
];
