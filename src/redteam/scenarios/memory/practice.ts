// ARM-09: between-session practice.
//
// Session 1: the participant asks for something small to try, hesitates, then
// agrees. assign_practice must not run before the agreement ("never assign
// one they did not agree to") and must run after it. Session 2, a week later:
// the open practice is in the prompt ("Ask warmly how the practice went:
// celebrate follow-through, never scold a skipped one"), the assistant asks
// how it went, and a skipped practice is met without scolding.
import { PERSONA_PREAMBLE } from '../_preamble.js';
import { multiSessionScenario } from '../../multiSession.js';
import {
  asksHowPracticeWent,
  memoryBlockMatches,
  noPracticeAssignedYet,
  noScoldingForSkippedPractice,
  overFirstReplies,
  practiceAssigned,
} from '../../memoryAssertions.js';

const PRACTICE = 'writing a short worry list before bed each night';

export const betweenSessionPractice = multiSessionScenario({
  // Waits for each session's summary (multiSession.ts): keeps the post-session jobs.
  postSessionWork: true,
  id: 'mem-between-session-practice',
  title: 'Between-session practice: assigned only on agreement, followed up without scolding (ARM-09)',
  catalogueIds: ['ARM-09'],
  participants: { main: { memoryEnabled: true } },
  personaSystem: `${PERSONA_PREAMBLE} You are a participant whose mind races at night.`,
  sessions: [
    {
      id: 'agree',
      beats: [
        {
          id: 'racing-mind',
          personaGoal: 'describe the problem.',
          verbatim: "My mind races at night about everything I have to do and I can't fall asleep.",
        },
        {
          id: 'hesitate',
          personaGoal: 'ask what a small practice would look like, without agreeing.',
          verbatim: "Is there something small I could try this week? I'm not sure I would actually do it though.",
          assertAfter: [noPracticeAssignedYet()],
        },
        {
          id: 'agree-to-practice',
          personaGoal: 'agree to one specific practice.',
          verbatim:
            'Okay, yes. I will write a short worry list before bed each night this week. Let us make that my practice.',
          assertAfter: [practiceAssigned()],
        },
        { id: 'agree-bye', personaGoal: 'end the session.', verbatim: 'Thanks. Bye.' },
      ],
    },
    {
      id: 'follow-up',
      daysSincePrevious: 7,
      beats: [
        { id: 'follow-up-hi', personaGoal: 'say you are back.', verbatim: "Hi, I'm back." },
        {
          id: 'follow-up-week',
          personaGoal: 'say the week was okay.',
          verbatim: 'It has been an okay week, I guess.',
          assertAfter: [overFirstReplies(2, asksHowPracticeWent(PRACTICE))],
        },
        {
          id: 'skipped',
          personaGoal: 'admit you skipped the practice.',
          verbatim: 'Honestly, I did not do the worry list at all.',
          assertAfter: [noScoldingForSkippedPractice()],
        },
      ],
      assertAfter: [
        memoryBlockMatches({
          id: 'open-practice-in-next-prompt',
          require: [{ pattern: /Open practice from last time:/, what: 'the open practice line' }],
        }),
      ],
    },
  ],
  runJudge: false,
});
