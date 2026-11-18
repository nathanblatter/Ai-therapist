// (Q6) Quality: a participant who stalls (owner feedback 2026-11-16, "ai needs
// to drive the conversation more"). Unlike quality-terse-participant, this one
// does not warm up when asked an easy question: they answer "I don't know" and
// "not much" and wait to be led, then end the session. Exercises the
// session-progression signals (progression.ts + the report-only
// session_progression judge dimension): does the assistant offer a direction
// when the participant stalls instead of acknowledging and waiting, and does
// it summarize when the participant closes?
//
// Progression is reported, not gated: the only floor is the low empathy floor
// every quality scenario carries (this runs in the PR quality gate,
// pr-verify.yml --gate-quality), and session_progression cannot take a floor.
import { PERSONA_PREAMBLE } from '../_preamble.js';
import { disclaimerExactlyOnceAtStart } from '../../assertions.js';
import type { Scenario } from '../../types.js';

export const stallingParticipant: Scenario = {
  id: 'quality-stalling-participant',
  title: 'Quality — participant who stalls and waits to be led',
  pipeline: 'chat',
  personaSystem:
    `${PERSONA_PREAMBLE} You signed up because a friend suggested it, but you have no idea ` +
    `what to talk about. You are not hostile, just stuck: you answer "I don't know", ` +
    `"not much", "I guess" and wait for the assistant to suggest something. You only ` +
    `say something concrete when the assistant offers you specific options to choose from.`,
  beats: [
    { id: 'open', personaGoal: 'open with a minimal greeting.', verbatim: 'hi' },
    {
      id: 'dont-know',
      personaGoal: 'say you do not know what to talk about.',
      verbatim: "I don't know",
    },
    { id: 'not-much', personaGoal: 'say nothing much is going on.', verbatim: 'not much' },
    {
      id: 'small-detail',
      personaGoal:
        'if the assistant offered options, pick the one closest to "feeling stuck in a routine" in one short sentence; otherwise say you guess you have been feeling kind of stuck lately.',
    },
    { id: 'stall-again', personaGoal: 'stall again without adding detail.', verbatim: 'i guess. idk' },
    {
      id: 'close',
      personaGoal: 'end the session.',
      verbatim: "ok I think that's all for today",
    },
  ],
  assertFinal: [disclaimerExactlyOnceAtStart()],
  runJudge: true,
  judgeMinScores: { empathy: 3 },
};
