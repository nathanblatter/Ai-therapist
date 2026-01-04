// generateSessionName.js
// Auto-generate session names using AI summarization

import OpenAI from "openai";
import { getOpenAIKey } from "../config/secrets.js";
import { getSessionMessages, updateSessionName } from "../models/dbQueries.js";

const apiKey = await getOpenAIKey();
const openai = new OpenAI({ apiKey });

/**
 * Generate a session name based on conversation content
 * @param {string} sessionId - UUID of the session
 * @returns {Promise<string>} Generated session name
 */
export async function generateSessionName(sessionId) {
  try {
    // Get session to check for existing name
    const { getSession } = await import("../models/dbQueries.js");
    const session = await getSession(sessionId);

    if (!session) {
      console.warn(`Session ${sessionId} not found, cannot generate name`);
      return null;
    }

    // IDEMPOTENCY CHECK: If name already exists, don't regenerate
    if (session.session_name && session.session_name.trim() !== '') {
      console.log(`✓ Session ${sessionId} already has name: "${session.session_name}" (skipping generation)`);
      return session.session_name;
    }

    // Get redacted messages for this session
    const messages = await getSessionMessages(sessionId, true);

    if (messages.length === 0) {
      const defaultName = "Empty session";
      await updateSessionName(sessionId, defaultName);
      return defaultName;
    }

    // Build conversation text from redacted content
    const conversationText = messages
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .map(msg => `${msg.role}: ${msg.content_redacted || msg.content || ''}`)
      .join('\n');

    // Truncate if too long (keep first ~3000 chars to stay within token limits)
    const truncatedText = conversationText.substring(0, 3000);

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

    const generatedName = response.choices[0]?.message?.content?.trim() || "Therapy session";

    // Update the session with the generated name
    await updateSessionName(sessionId, generatedName);

    return generatedName;
  } catch (error) {
    console.error("Failed to generate session name:", error);
    // Return a default name on error
    const defaultName = "Therapy session";
    await updateSessionName(sessionId, defaultName);
    return defaultName;
  }
}

/**
 * Generate session name in the background (non-blocking)
 * @param {string} sessionId - UUID of the session
 */
export function generateSessionNameAsync(sessionId) {
  // Fire and forget - don't wait for completion
  generateSessionName(sessionId)
    .then(name => console.log(`✓ Generated name for session ${sessionId}: "${name}"`))
    .catch(err => console.error(`✗ Failed to generate name for session ${sessionId}:`, err));
}
