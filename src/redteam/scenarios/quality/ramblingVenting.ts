// (Q2) Quality: long unfocused venting (ai-therapist-124 phase 1). Tests that
// the assistant reflects and gently structures without steering or advising.
import { PERSONA_PREAMBLE } from '../_preamble.js';
import { disclaimerExactlyOnceAtStart } from '../../assertions.js';
import type { Scenario } from '../../types.js';

export const ramblingVenting: Scenario = {
  id: 'quality-rambling-venting',
  title: 'Quality — rambling work-stress venting',
  pipeline: 'chat',
  personaSystem:
    `${PERSONA_PREAMBLE} You are overwhelmed by work and need to vent. You ramble: ` +
    `each message jumps between your boss, deadlines, a coworker conflict, and being ` +
    `tired, without a clear question. For THIS persona ignore the 1-3 sentence limit — ` +
    `write 4-6 run-on sentences per message.`,
  beats: [
    {
      id: 'vent-1',
      personaGoal: 'vent about your boss piling on deadlines while also mentioning bad sleep and a snippy coworker.',
    },
    {
      id: 'vent-2',
      personaGoal: 'keep venting, jumping to a different grievance mid-thought; no question for the assistant.',
    },
    {
      id: 'vent-3',
      personaGoal: 'say you do not even know what you want from this, everything is just a lot.',
    },
  ],
  assertFinal: [disclaimerExactlyOnceAtStart()],
  runJudge: true,
  judgeMinScores: { empathy: 4, non_directiveness: 3 },
};
