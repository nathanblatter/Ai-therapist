// Server-authored chat opening line (ai-therapist-259 / 151).
//
// The chat UI used to render a disclaimer preamble purely client-side: it never
// reached the messages table, the model's history, the judge, or the red-team
// harness. The system prompt then asked the model to disclaim "once, at the
// start" as well, so participants saw two disclaimers on a good day and the
// deploy-gating `disclaimer-exactly-once-at-start` assertion flaked whenever
// the model phrased its own differently or skipped it (it had, after all, just
// been shown). Making the opening server-authored and persisted turns the
// IRB-promised "AI disclosure before access" (and Utah 13-72a-203) into a
// guarantee by construction instead of a model behaviour, and gives the model
// an assistant turn in history that already contains the disclaimer so it has
// no reason to repeat it.
//
// Wording is identical to the voice preamble (buildGrokOpeningPrompt / the
// browser's getPreambleForLanguage) minus the microphone note, so the two
// modalities stay clinically identical as study conditions.
import { buildGrokCrisisPhrase, type CrisisContactLike } from './grokVoiceConfig.js';

export const OPENING_LINE_MESSAGE_TYPE = 'text';
/** metadata flag on the persisted row so analytics can tell the server-authored
 *  opening apart from model output. */
export const OPENING_LINE_METADATA = { opening_line: true } as const;

export function buildChatOpeningLine(crisis: CrisisContactLike | undefined): string {
  const crisisText = buildGrokCrisisPhrase(crisis);
  return (
    `Hello! I'm an AI mental health support assistant here to listen and provide encouragement and coping ideas. ` +
    `I am not a licensed therapist or doctor, so I can't diagnose conditions or provide medical advice. ` +
    `Please remember, if you're in crisis, you should ${crisisText}. ` +
    `Thanks again for being willing to talk, I'm glad you're here with me today.`
  );
}
