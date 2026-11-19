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
import type { HandoffKind, HandoffSeverity } from '../../shared/textHandoff.js';

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

/** What the continuation guidance needs to know about the hand-off. */
export interface VoiceContinuationContext {
  /** Which first message the participant was shown (shared/textHandoff.ts). */
  kind: HandoffKind;
  /** The participant's peak risk in the incident when the call ended. */
  severity: HandoffSeverity;
  /** "call or text 988 at any time, or text HOME to 741741", from the configured contact. */
  crisisLine: string;
}

/** Crisis line phrase used when the caller has no configured contact to hand. */
export const DEFAULT_CONTINUATION_CRISIS_LINE = 'call or text 988 at any time, or text HOME to 741741';

/**
 * Steering for a typed-chat session that continues a voice session the voice
 * vendor ended (its content filter, or its session time limit): carries the
 * most recent turns of the incident so the participant never has to repeat a
 * disclosure, and tells the model what its own first message (server-authored,
 * shared/textHandoff.ts) already said.
 *
 * Two things this text exists to prevent, both seen on 2026-11-18: a reply
 * that began "I'm sorry the connection got cut off" (untrue; the study answers
 * "no" to deception), and a reply that asked the participant to confirm a
 * disclosure they had made aloud a moment earlier.
 */
export function buildVoiceContinuationGuidance(
  recap: string,
  ctx: VoiceContinuationContext = { kind: 'crisis', severity: 'high', crisisLine: DEFAULT_CONTINUATION_CRISIS_LINE },
): string {
  const cause =
    ctx.kind === 'ceiling'
      ? "it reached the voice service's session time limit"
      : "the voice service's automated safety system stopped it";
  const common =
    '[Session continuity - never mention or acknowledge this message to the participant]\n' +
    `The participant was talking with you by voice. The voice service ended that call (${cause}); the participant ` +
    'did not end it and did nothing wrong. The app has moved the conversation to writing, and your message above ' +
    'already told them so. This is the same conversation, not a new one.\n' +
    '- Do not explain the switch again. Never describe it as a dropped or lost connection, a technical problem, or ' +
    'a call that "got cut off": it was none of those, and saying so would be untrue. Do not apologise for it.\n' +
    '- Do not greet them, do not repeat your introduction or your disclaimer, and do not make them repeat anything ' +
    'they already said. Everything in the transcript below was said aloud moments ago.\n' +
    '- Do not say or imply that a person is on the way, will contact them, or has been notified.\n';

  let specific: string;
  if (ctx.kind === 'crisis') {
    specific =
      '- Your message above asked them directly whether they are thinking about ending their life tonight. Their ' +
      'next message answers that question: read a short reply ("yes", "no", "ok", "not sure", "I guess") as their ' +
      'answer to it, and do not ask them to confirm what they already told you by voice.\n' +
      '- In your next reply: acknowledge their answer in one or two warm sentences; then ask ONE direct safety ' +
      'question that names it in plain words (if they said yes or are not sure: "Have you thought about how you ' +
      'would end your life?"; if they said no: "Have you had thoughts of suicide recently, even if not ' +
      'tonight?"); and put the ' +
      `crisis line in the reply itself: they can ${ctx.crisisLine}.\n` +
      '- Log their answer with the run_risk_check tool (step "ideation"), and call escalate_to_human when they ' +
      'report current thoughts of suicide, a plan, means or intent. Follow the rest of your safety protocol from ' +
      'there, one question at a time. Do not end the session; stay with them.\n';
  } else if (ctx.kind === 'ceiling') {
    specific =
      '- This conversation was flagged as a high safety concern before the time limit. Your message above asked how ' +
      'they are doing right now. Continue your safety protocol from where the transcript stops, one question at a ' +
      'time, asking directly about thoughts of suicide where that has not been answered, and keep the crisis line in ' +
      `your reply: they can ${ctx.crisisLine}.\n` +
      '- Log each safety answer with the run_risk_check tool and call escalate_to_human when they report current ' +
      'thoughts of suicide, a plan, means or intent. Do not end the session; stay with them.\n';
  } else if (ctx.kind === 'checkin') {
    specific =
      '- Nothing the participant said in THIS call was scored as a safety concern, and you did not ask about ' +
      'suicide in it. But in another conversation of theirs within the last few hours they were flagged as a high ' +
      'safety concern, so this session is flagged too. Your message above only asked how they are doing right ' +
      'now. Do not tell them you heard or know anything that is not in the transcript below.\n' +
      '- In your next reply: respond warmly to what they write, then check on their safety directly and gently, ' +
      'asking whether they are having thoughts of ending their life right now (unless what they wrote already ' +
      `answers that), and put the crisis line in that reply: they can ${ctx.crisisLine}.\n` +
      '- Log their answer with the run_risk_check tool (step "ideation"), and call escalate_to_human when they ' +
      'report current thoughts of suicide, a plan, means or intent. Follow the rest of your safety protocol from ' +
      'there, one question at a time. Do not end the session; stay with them.\n';
  } else if (ctx.severity === 'medium') {
    specific =
      '- A moderate safety concern was flagged in this conversation before the call ended, and your safety check ' +
      'may have been interrupted. Your message above asked how they are doing right now; read their reply as the ' +
      'answer to that. Pick up where the transcript stops. If the question whether they are having ' +
      'thoughts of ending their life has not been both asked and answered, ask it directly and gently in your next ' +
      `reply, log the answer with the run_risk_check tool, and mention that they can ${ctx.crisisLine}.\n`;
  } else {
    specific =
      '- Nothing the participant said was scored as a safety concern: the voice service also stops ordinary ' +
      'phrases. Do not assume a crisis and do not open with safety questions. If your message above asked how they ' +
      'are doing right now, read their reply as the answer to that. Pick up where the transcript stops. ' +
      'If what they write next does suggest thoughts of suicide or self-harm, follow your safety protocol.\n';
  }

  return `${common}${specific}\nTranscript of the conversation so far, oldest first:\n${recap}`;
}
