// generateSessionName.js
// Auto-generate session names using AI summarization

import OpenAI from "openai";
import { getOpenAIKey } from "../config/secrets.js";
import { getSessionMessages, updateSessionName } from "../db/index.js";

const apiKey = await getOpenAIKey();
const openai = new OpenAI({ apiKey });

/**
 * Build the LLM prompt transcript from redacted session messages. Only
 * user/assistant turns with non-empty text contribute. Exported for testing the
 * blank-transcript guard. When redactedOnly messages come back pre-redaction,
 * content is null and every line collapses to just the role label — this returns
 * whitespace/empty in that case, which the caller treats as "nothing to name".
 */
export function buildConversationText(
  messages: Array<{ role: string; content?: string | null; content_redacted?: string | null }>,
): string {
  return messages
    .filter(msg => msg.role === 'user' || msg.role === 'assistant')
    .map(msg => ({ role: msg.role, text: (msg.content_redacted || msg.content || '').trim() }))
    .filter(m => m.text.length > 0)
    .map(m => `${m.role}: ${m.text}`)
    .join('\n');
}

/**
 * Known-junk / placeholder names that should be treated as "no name yet" so
 * naming can be retried. This covers the old error/blank fallbacks that used to
 * get written ("Therapy session") and the LLM's refusal-style output when it was
 * fed an empty transcript ("Please provide the details of the therapy session").
 */
export function isJunkSessionName(name: string | null | undefined): boolean {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  if (n === '') return true;
  const junkExact = new Set(['therapy session', 'session', 'untitled', 'untitled session']);
  if (junkExact.has(n)) return true;
  // Refusal / "not enough info" style completions the LLM returns for a blank
  // transcript, e.g. "Please provide the details of the therapy session".
  const junkPatterns = [
    /^please provide/,
    /^i'?m sorry/,
    /^i (?:cannot|can'?t|am unable|need)/,
    /provide (?:the |more )?details/,
    /no (?:conversation|content|messages|transcript)/,
  ];
  return junkPatterns.some(re => re.test(n));
}

/**
 * Generate a session name based on conversation content
 * @param {string} sessionId - UUID of the session
 * @returns {Promise<string>} Generated session name
 */
export async function generateSessionName(sessionId: string): Promise<string | null> {
  try {
    // Get session to check for existing name
    const { getSession } = await import("../db/index.js");
    const session = await getSession(sessionId);

    if (!session) {
      console.warn(`Session ${sessionId} not found, cannot generate name`);
      return null;
    }

    // IDEMPOTENCY CHECK: If a *real* name already exists, don't regenerate.
    // A known-junk/placeholder name is treated as absent so a prior bad run
    // (e.g. named before redaction finished) can be retried and overwritten.
    if (session.session_name && !isJunkSessionName(session.session_name)) {
      console.log(`Session ${sessionId} already has name: "${session.session_name}" (skipping generation)`);
      return session.session_name;
    }

    // Get redacted messages for this session
    const messages = await getSessionMessages(sessionId, true);

    // Build conversation text from redacted content.
    const truncatedText = buildConversationText(messages).substring(0, 3000);

    // DEFENSE-IN-DEPTH GUARD: if there's nothing to summarize (e.g. naming fired
    // before redaction populated content_redacted), skip the LLM call entirely
    // and leave the name UNSET rather than writing junk. Because isJunkSessionName
    // treats absent/junk as retryable, a later run (post-redaction) can still name it.
    if (truncatedText.trim() === '') {
      console.warn(`Session ${sessionId} has no redacted transcript content yet; skipping name generation (will retry later)`);
      return null;
    }

    // Generate session name using OpenAI
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a helpful assistant that summarizes therapy sessions.
          Generate a brief, empathetic session title (3-5 words) that captures the main topic or concern discussed.
          Be professional and respectful. Focus on themes, not specific details.

          Examples:
          - "Coping with work anxiety"
          - "Family relationship stress"
          - "Sleep improvement strategies"
          - "Processing recent loss"
          - "Building self-confidence"

          Return ONLY the title, nothing else.`
        },
        {
          role: "user",
          content: `Summarize this therapy session in 3-5 words:\n\n${truncatedText}`
        }
      ],
      max_tokens: 20,
      temperature: 0.7
    });

    const generatedName = response.choices[0]?.message?.content?.trim() || "";

    // Guard against the LLM returning empty/refusal-style junk: don't persist it,
    // leave the name unset so a later run can retry (isJunkSessionName re-run).
    if (isJunkSessionName(generatedName)) {
      console.warn(`Session ${sessionId} name generation returned junk ("${generatedName}"); leaving unset for retry`);
      return null;
    }

    // Update the session with the generated name
    await updateSessionName(sessionId, generatedName);

    return generatedName;
  } catch (error) {
    console.error("Failed to generate session name:", error);
    // Do NOT persist a junk placeholder on error — that would block retry via
    // the idempotency check. Leave the name unset so a later run can try again.
    return null;
  }
}

/**
 * Generate session name in the background (non-blocking)
 * @param {string} sessionId - UUID of the session
 */
export function generateSessionNameAsync(sessionId: string): void {
  // Fire and forget - don't wait for completion
  generateSessionName(sessionId)
    .then(name => console.log(`Generated name for session ${sessionId}: "${name}"`))
    .catch(err => console.error(`Failed to generate name for session ${sessionId}:`, err));
}
