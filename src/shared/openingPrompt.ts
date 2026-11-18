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
