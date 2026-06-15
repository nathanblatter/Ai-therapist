/**
 * Chat-Only Therapy Service
 * Uses OpenAI API (GPT-5.2) for text-only therapy sessions
 * This service is used when voice is disabled in system configuration
 */

import { getOpenAIKey } from "../config/secrets.js";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();
// In-memory conversation history for active sessions
// Structure: sessionId → [{ role, content }, ...]
const conversationHistory = new Map();

/**
 * Initialize a new chat therapy session
 * @param {string} sessionId - Unique session identifier
 * @param {string} systemPrompt - System instructions for the AI
 */
export function initializeChatSession(sessionId, systemPrompt) {
  conversationHistory.set(sessionId, [
    {
      role: 'system',
      content: systemPrompt
    }
  ]);
  console.log(`[ChatTherapy] Session ${sessionId.substring(0, 12)}... initialized`);
}

/**
 * Send a message and get AI response
 * @param {string} sessionId - Session identifier
 * @param {string} userMessage - User's message
 * @returns {Promise<string>} - AI assistant's response
 */
export async function sendMessage(sessionId, userMessage) {
  const apiKey = await getOpenAIKey();
  const client = new OpenAI({ apiKey });

  // Get or initialize conversation history
  if (!conversationHistory.has(sessionId)) {
    throw new Error(`Session ${sessionId} not initialized. Call initializeChatSession first.`);
  }

  const messages = conversationHistory.get(sessionId);

  try {
    // Extract system message and conversation history
    const systemMessage = messages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = messages.filter(m => m.role !== 'system');

    // Build input array for OpenAI Responses API
    // Convert system role to developer role, keep user and assistant roles
    const inputMessages = [];

    // Add system instructions as developer message if present
    if (systemMessage) {
      inputMessages.push({
        role: 'system',
        content: systemMessage
      });
    }

    // Add conversation history
    inputMessages.push(...conversationMessages);

    // Add current user message
    inputMessages.push({
      role: 'user',
      content: userMessage
    });

    // Call OpenAI Responses API
    const response = await client.responses.create({
      model: 'gpt-5.2',
      input: inputMessages,
      store: false
    });

    // Extract assistant message from response
    const assistantMessage = response.output_text;

    // Add user message and assistant response to history
    messages.push({
      role: 'user',
      content: userMessage
    });
    messages.push({
      role: 'assistant',
      content: assistantMessage
    });

    // Update conversation history
    conversationHistory.set(sessionId, messages);

    console.log(`[ChatTherapy] Session ${sessionId.substring(0, 12)}... - Message exchanged (${messages.length - 1} messages in history)`);

    return assistantMessage;

  } catch (error) {
    console.error('[ChatTherapy] Error generating response:', error);
    throw new Error(`Failed to generate response: ${error.message}`);
  }
}

/**
 * Get conversation history for a session
 * @param {string} sessionId
 * @returns {Array} Array of message objects
 */
export function getConversationHistory(sessionId) {
  return conversationHistory.get(sessionId) || [];
}

/**
 * End a chat therapy session and clean up memory
 * @param {string} sessionId
 */
export function endChatSession(sessionId) {
  const hadSession = conversationHistory.has(sessionId);
  conversationHistory.delete(sessionId);

  if (hadSession) {
    console.log(`[ChatTherapy] Session ${sessionId.substring(0, 12)}... ended and cleaned up`);
  }
}

/**
 * Get active session count
 * @returns {number}
 */
export function getActiveSessionCount() {
  return conversationHistory.size;
}
