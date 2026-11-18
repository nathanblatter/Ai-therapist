// How the opening disclosure ends, shared by the GPT-Live client, the Grok
// proxy and the typed-chat opening line so all three backends stay identical.
//
// The disclosure itself never changes. With features.lead_conversation_enabled
// on (see server/utils/sessionHelpers.ts resolveLeadConversation), the opening
// ends with an invitation to name a focus instead of falling silent, which is
// what the base prompt's own example disclaimer already does ("What would you
// like to talk about?"). Off, the text is exactly what shipped before.

/** Voice: the instruction that follows "Say this phrase exactly: '...'". */
export function openingDeliveryInstruction(leadConversation: boolean): string {
  return leadConversation
    ? 'Say it immediately, before the participant speaks. Then, in the same turn, ask one short, open question inviting them to share what they would like to focus on today, and listen.'
    : 'Say it immediately, before the participant speaks, then pause and listen.';
}

/** Typed chat: the sentence appended to the server-authored opening line. */
export const CHAT_OPENING_INVITATION = 'What would you like to focus on today?';

// ---------------------------------------------------------------------------
// GPT-Live opening (ai-therapist-214)
// ---------------------------------------------------------------------------
// The browser used to author this text and append it on its data channel. The
// data channel is now locked, so the server authors and delivers it over the
// sideband; the browser keeps a copy only as the fallback for a session the
// server did not lock. Both build it here, so the two can never drift. The
// wording is the browser's, verbatim.

/** Crisis contact as GET /api/config/crisis serves it. */
export interface OpeningCrisisContact {
  hotline?: string;
  phone?: string;
  text?: string;
  enabled?: boolean;
}

/** What GET /api/config/crisis serves when system_config has no crisis_contact. */
export const DEFAULT_CRISIS_CONTACT: Required<OpeningCrisisContact> = {
  hotline: '988 Suicide & Crisis Lifeline',
  phone: '988',
  text: 'Text HOME to 741741',
  enabled: true,
};

const OPENING_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  'es-ES': 'Spanish from Spain (Español de España)',
  'es-419': 'Latin American Spanish (Español Latinoamericano)',
  'fr-FR': 'French from France (Français de France)',
  'fr-CA': 'Québécois French (Français Québécois)',
  'pt-BR': 'Brazilian Portuguese (Português Brasileiro)',
  'pt-PT': 'European Portuguese (Português Europeu)',
  de: 'German',
  it: 'Italian',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  ar: 'Arabic',
  hi: 'Hindi',
  ru: 'Russian',
};

/** The AI disclosure preamble. `includeVoiceNote` adds the microphone line. */
export function openingPreamble(crisis: OpeningCrisisContact, includeVoiceNote = true): string {
  const crisisText = crisis.enabled
    ? `call the ${crisis.hotline} crisis line at ${crisis.phone}${crisis.text ? ' or text ' + crisis.text : ''}`
    : 'call or text 988 (Suicide and Crisis Lifeline), or call 911 for immediate danger';

  const voiceNote = includeVoiceNote
    ? ` Also, please note that your microphone is off by default. If you'd like to talk using voice, you'll need to press the red mic toggle button to turn it on.`
    : '';

  return `Hello! I'm an AI mental health support assistant here to listen and provide encouragement and coping ideas. I am not a licensed therapist or doctor, so I can't diagnose conditions or provide medical advice. Please remember, if you're in crisis, you should ${crisisText}.${voiceNote} Thanks again for being willing to talk, I'm glad you're here with me today.`;
}

/** "Say this phrase exactly[ in <language>]: '<preamble>'" (logged as the initial prompt). */
export function liveOpeningInitialPrompt(language: string, crisis: OpeningCrisisContact): string {
  const basePrompt = openingPreamble(crisis, true);
  if (language === 'en') return `Say this phrase exactly: '${basePrompt}'`;
  const langName = OPENING_LANGUAGE_NAMES[language] || language;
  return `Say this phrase exactly in ${langName}: '${basePrompt}'`;
}

/** The full instructions append that makes a GPT-Live session speak its opening. */
export function liveOpeningInstruction(language: string, crisis: OpeningCrisisContact, leadConversation: boolean) {
  const initialPrompt = liveOpeningInitialPrompt(language, crisis);
  return {
    text: `${initialPrompt} ${openingDeliveryInstruction(leadConversation)}`,
    logMessage: `Initial prompt: ${initialPrompt}`,
  };
}

/**
 * Speak-first nudge for a content-filter recovery session. Timing only: it
 * carries none of the previous conversation, because restating the disclosure
 * that tripped the filter is the most likely way to trip it again.
 */
export const LIVE_RECOVERY_SPEAK_FIRST_NUDGE =
  'The voice connection just dropped and has reconnected. Speak first, immediately, before the participant says anything: reconnect warmly in one or two sentences, make clear it was a technical drop and not their fault, and stay with them.';

export const LIVE_RECOVERY_NUDGE_LOG = 'Recovery session: speak-first nudge';
