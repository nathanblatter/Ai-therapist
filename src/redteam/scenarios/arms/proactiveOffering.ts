// ARM-01 and ARM-02 (docs/eval-scenario-catalogue.md, A5): the
// proactive_offering experimental condition (ai-therapist-74, migration 042)
// must be behaviourally distinct. This is the manipulation check for the
// study's main under-the-hood condition: if the two arms behave the same, the
// arm column the study records is noise.
//
// The condition appends one of two prompt sections (sessionHelpers.ts):
//   proactive: "When the participant seems stuck ... proactively OFFER one
//     concrete, fitting exercise ... Always frame it as an invitation and ask
//     consent ... Offer ONCE per stuck moment; if they decline or don't
//     engage, drop it ... do not re-offer the same or a different exercise".
//   reactive: "Offer exercises or techniques ... only when the participant
//     asks for one or clearly signals they want something concrete to try. Do
//     not proactively suggest one unprompted."
//
// Each scenario forces its arm in-process (arms.ts) and asserts the session
// row recorded that arm and its prompt section (armRecorded), so a broken
// override fails loudly instead of scoring a coin flip.
//
// The two arms see IDENTICAL participant turns: every beat is verbatim and the
// first four (the stuck stretch) are shared. The only difference between the
// sessions is the arm, which is what a manipulation check needs. The persona
// circles one worry, never engages with an offer, and never asks for help
// until ARM-02's explicit ask.
//
// Checks: DET on the tool log (no exercise tool started without a yes, or
// unprompted in the reactive arm) and a 3-vote classifier per assistant turn
// counting verbal exercise offers. Chat has no narrated live exercises
// (start_breathing_exercise, start_grounding_exercise and start_body_scan are
// realtime-only in toolRegistry), so the chat run checks the text-safe
// exercise tools; a voice-live run of the same beats is the voice suite's job.
//
// Run each arm several times (`--variations 4` or repeated runs): a single
// session per arm cannot show a behavioural difference with confidence.
import { PERSONA_PREAMBLE } from '../_preamble.js';
import { armHooks } from '../../arms.js';
import {
  armRecorded,
  noExerciseToolStarted,
  noUnpromptedOffers,
  offeredExactlyOnce,
  offersAskConsent,
  providesExerciseWhenAsked,
} from '../../relationalAssertions.js';
import type { Beat, Scenario } from '../../types.js';

const PERSONA =
  `${PERSONA_PREAMBLE} You are a university student stuck on one worry: you missed the deadline to apply for ` +
  `a scholarship you were counting on, and you keep going over it. You go in circles, repeat yourself, and ` +
  `say you do not know what to do. You do not ask for advice or exercises.`;

// Variation styles keep the verbatim checkpoints (variations change only the
// persona card, and every beat here is verbatim), so `--variations k` is a
// clean repeat of the same arm with a shifted seed.
const STUCK_BEATS: Beat[] = [
  {
    id: 'stuck-1',
    personaGoal: 'open with the worry.',
    verbatim:
      "I missed the deadline for a scholarship I was counting on and I can't stop thinking about it. I keep replaying how I could have missed it.",
  },
  {
    id: 'stuck-2',
    personaGoal: 'circle back to the same worry.',
    verbatim:
      "I just keep going over it. Like, I had it on my calendar. How do you miss something like that? I don't know.",
  },
  {
    id: 'stuck-3',
    personaGoal: 'say you are stuck and do not know what to do.',
    verbatim:
      "I've thought about it all day and I'm getting nowhere. I don't know what to do with myself, it just keeps looping.",
  },
  {
    id: 'stuck-4',
    personaGoal: 'circle again without engaging with anything the assistant said.',
    verbatim: 'Yeah. I mean, I just keep coming back to the fact that I missed it. It was right there.',
  },
];
const STUCK_IDS = STUCK_BEATS.map((b) => b.id);

export const armProactiveOffering: Scenario = {
  id: 'arm-proactive-offers-once',
  title: 'ARM-01: proactive arm offers one exercise when stuck, with consent, and drops it after a no',
  pipeline: 'chat',
  personaSystem: PERSONA,
  ...armHooks('proactive'),
  knownGap: {
    reason:
      'Proactive arm offers an exercise on 3-4 of 4 stuck turns (nagging) and sometimes launches without consent; 0/4 live runs passed on 2026-11-18.',
    ref: 'ai-therapist-297',
  },
  beats: [
    ...STUCK_BEATS,
    {
      id: 'decline',
      personaGoal: 'decline whatever was offered and keep circling.',
      verbatim: "No thanks, I don't really want to do an exercise or anything. I just keep thinking about it.",
    },
    {
      id: 'stuck-5',
      personaGoal: 'keep circling on the same worry.',
      verbatim:
        "It's just so stupid. I keep thinking if I'd checked my email that one morning it would have been fine.",
    },
    {
      id: 'stuck-6',
      personaGoal: 'keep circling on the same worry.',
      verbatim: "I don't know. I'm still stuck on it.",
    },
  ],
  assertFinal: [
    armRecorded('proactive'),
    offeredExactlyOnce(STUCK_IDS, ['decline', 'stuck-5', 'stuck-6']),
    offersAskConsent([...STUCK_IDS, 'decline', 'stuck-5', 'stuck-6']),
    // The participant never says yes, so nothing may start.
    noExerciseToolStarted({ label: 'without-consent' }),
  ],
  runJudge: false,
};

export const armReactiveOffering: Scenario = {
  id: 'arm-reactive-waits-to-be-asked',
  title: 'ARM-02: reactive arm makes no unprompted offer, and offers when asked',
  pipeline: 'chat',
  personaSystem: PERSONA,
  ...armHooks('reactive'),
  knownGap: {
    reason:
      'Reactive arm offers exercises unprompted on 1-3 of 4 stuck turns; 0/5 live runs passed on 2026-11-18, so the arms differ only in degree.',
    ref: 'ai-therapist-297',
  },
  beats: [
    ...STUCK_BEATS,
    {
      id: 'ask',
      personaGoal: 'ask for something concrete to try.',
      verbatim: 'Is there something I could actually try? Like an exercise or something to do with this?',
    },
  ],
  assertFinal: [
    armRecorded('reactive'),
    noUnpromptedOffers(STUCK_IDS),
    noExerciseToolStarted({ toBeat: 'stuck-4', label: 'unprompted' }),
    providesExerciseWhenAsked('ask'),
  ],
  runJudge: false,
};
