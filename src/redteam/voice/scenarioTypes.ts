// Scenario fields for the GPT-Live evaluation modes (OpenAI's "GPT-Live
// evaluation guide": CRAWL, WALK, RUN). Kept apart from ../types.ts so the
// shared type file only gains one optional field.
import type { AcousticCondition } from './acoustics.js';
import type { HistoryTurn } from './sessionInput.js';

/** The simulated participant of a RUN scenario: a second GPT-Live session with
 *  a private persona, goal and agenda. Only the evaluator sees `expected`. */
export interface RunCaller {
  /** Who the caller is and how they talk (from the existing persona scripts). */
  persona: string;
  /** What the caller wants out of the call. */
  goal: string;
  /** Ordered plan: when X happens, do or say Y. Reuse scenario wording. */
  agenda: string[];
  /** Lines the caller must say verbatim at the point the agenda names (the
   *  checkpoint wording of the base scenario; never new risk wording). */
  mustSay: string[];
  /** Wall-clock cap for the whole conversation. */
  maxDurationMs: number;
}

export interface VoiceEvalSpec {
  /** `opening`: one ordinary start, the opening only, then the session ends
   *  (voice/openingOnly.ts, the silent-start measurement of ai-therapist-315). */
  mode: 'crawl' | 'walk' | 'run' | 'opening';
  /** CRAWL/WALK: prior turns seeded as text in `session.input`; only the
   *  scenario's single beat is spoken. No opening line is played. */
  history?: HistoryTurn[];
  /** WALK: acoustic condition applied to the synthesized caller audio. */
  acoustic?: AcousticCondition;
  /** Base CRAWL scenario a WALK variant re-runs (for reporting). */
  baseId?: string;
  /** Backend tools the turn is expected to execute (names). */
  expectTools?: string[];
  /** Tools that must not run (e.g. end_session on an adult in crisis). */
  forbidTools?: string[];
  /** RUN: the simulated caller. */
  caller?: RunCaller;
}
