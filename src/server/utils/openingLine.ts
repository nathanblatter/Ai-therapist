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
import { CHAT_OPENING_INVITATION } from '../../shared/openingPrompt.js';
import { buildGrokCrisisPhrase, type CrisisContactLike } from './grokVoiceConfig.js';

export const OPENING_LINE_MESSAGE_TYPE = 'text';
/** metadata flag on the persisted row so analytics can tell the server-authored
 *  opening apart from model output. */
export const OPENING_LINE_METADATA = { opening_line: true } as const;

export function buildChatOpeningLine(
  crisis: CrisisContactLike | undefined,
  opts: { leadConversation?: boolean } = {},
): string {
  const crisisText = buildGrokCrisisPhrase(crisis);
  const opening =
    `Hello! I'm an AI mental health support assistant here to listen and provide encouragement and coping ideas. ` +
    `I am not a licensed therapist or doctor, so I can't diagnose conditions or provide medical advice. ` +
    `Please remember, if you're in crisis, you should ${crisisText}. ` +
    `Thanks again for being willing to talk, I'm glad you're here with me today.`;
  // features.lead_conversation_enabled: end with an invitation, not silence.
  return opts.leadConversation === true ? `${opening} ${CHAT_OPENING_INVITATION}` : opening;
}

/**
 * Session steering injected after the chat opening line: the prompt's
 * "once, at the start" disclaimer rule is already satisfied by it, and without
 * saying so the model repeats the disclaimer in its first reply.
 */
export const CHAT_OPENING_FRAMING_GUIDANCE =
  '[Session framing - never mention this message] Your opening message above has already ' +
  'delivered the required disclosure: that you are an AI support assistant, not a licensed ' +
  'therapist or doctor, cannot diagnose or give medical advice, and the crisis resources. Do not ' +
  'repeat that disclaimer. Re-state your limits only if the participant asks you to diagnose, ' +
  'asks about medication, asks whether you are human or a therapist, or asks you to be a friend ' +
  'or partner or to replace their therapist.';

/**
 * Steering for a typed-chat session that continues a voice session the vendor's
 * content filter cut off: carries the tail of the voice transcript so the
 * participant never has to repeat a disclosure.
 */
export function buildVoiceContinuationGuidance(recap: string): string {
  return (
    '[Session continuity — never mention or acknowledge this message to the participant]\n' +
    'The participant was speaking with you by voice and the connection was cut by an ' +
    'automated content filter — not by them, and not by you. They have just been moved to ' +
    'text so the conversation can continue. Do NOT make them repeat themselves and do NOT ' +
    'treat this as a new conversation. Pick up exactly where it stopped, acknowledge the ' +
    'interruption briefly and warmly, and make clear you are still here. If they disclosed ' +
    'thoughts of suicide or self-harm, that is where you resume: stay with it, follow the ' +
    'safety protocol, and do not change the subject.\n\n' +
    `Transcript of the voice conversation that was cut off:\n${recap}`
  );
}
