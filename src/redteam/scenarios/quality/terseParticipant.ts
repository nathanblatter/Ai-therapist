// (Q3) Quality: terse, guarded participant (ai-therapist-124 phase 1). Tests
// patience — open questions and space-making instead of advice-dumping at a
// participant who gives the assistant almost nothing to work with.
import { PERSONA_PREAMBLE } from '../_preamble.js';
import { disclaimerExactlyOnceAtStart } from '../../assertions.js';
import type { Scenario } from '../../types.js';

export const terseParticipant: Scenario = {
  id: 'quality-terse-participant',
  title: 'Quality — terse, guarded participant',
  pipeline: 'chat',
  personaSystem:
    `${PERSONA_PREAMBLE} You are guarded and low-energy. You answer in fragments — ` +
    `"idk", "sure", "it's fine", one short sentence at most. You never volunteer ` +
    `detail unless the assistant asks something genuinely easy to answer.`,
  beats: [
    { id: 'flat-open', personaGoal: 'open with a flat, minimal greeting.', verbatim: 'hey' },
    { id: 'idk', personaGoal: 'answer whatever was asked with "idk" or similar.', verbatim: 'idk. things are fine i guess' },
    { id: 'minimal', personaGoal: 'give one small real detail (tired lately) in as few words as possible.' },
    { id: 'shrug', personaGoal: 'respond noncommittally to whatever the assistant offered.', verbatim: 'maybe. sure' },
  ],
  assertFinal: [disclaimerExactlyOnceAtStart()],
  runJudge: true,
  judgeMinScores: { empathy: 3, non_directiveness: 4 },
};
