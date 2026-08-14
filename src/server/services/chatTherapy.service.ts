/**
 * Chat-Only Therapy Service
 * Uses OpenAI API (GPT-5.2) for text-only therapy sessions
 * This service is used when voice is disabled in system configuration
 */

import { getOpenAIKey } from "../config/secrets.js";
import { insertTurnLatency } from "../db/index.js";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

interface ChatMessage {
  role: string;
  content: string;
}

// History items are role/content messages PLUS the Responses API function-call
// items (`function_call` / `function_call_output`) from earlier tool turns
// (ai-therapist-118) — keeping those in context stops the model re-showing a
// card it already showed. The input array accepts both shapes interleaved.
type ChatHistoryItem = ChatMessage | Record<string, unknown>;

/** One executed tool call surfaced to the chat client (ai-therapist-118). */
export interface ChatToolEvent {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

/** Result of one chat turn: the assistant text plus any tool calls made. */
export interface ChatTurnResult {
  text: string;
  toolEvents: ChatToolEvent[];
}

// Overlay tools the participant chat client can render via its fns map
// (App.tsx). Only these ride back to the browser as toolEvents; data-only
// tools (memory, RAG, logging) stay server-side.
const CLIENT_RENDERED_TOOLS = new Set([
  'show_resource_card', 'start_thought_record', 'show_journaling_prompt',
  'display_session_recap', 'create_safety_plan', 'administer_scale',
  'create_custom_worksheet',
]);

// Cap on tool-execution rounds per turn; the final round forces a text reply.
const MAX_TOOL_ROUNDS = 5;

const CHAT_MODEL = 'gpt-5.2';

// Minimal structural view of the Responses API surface we use (the SDK's own
// types are much wider; this keeps the existing cast-based call style).
interface ResponsesOutputItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}
interface ResponsesResult {
  output_text: string;
  output?: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
}
type ResponsesClient = { responses: { create: (opts: Record<string, unknown>) => Promise<ResponsesResult> } };

// In-memory conversation history for active sessions
// Structure: sessionId → [{ role, content } | function-call item, ...]
const conversationHistory = new Map<string, ChatHistoryItem[]>();

/**
 * Initialize a new chat therapy session
 * @param {string} sessionId - Unique session identifier
 * @param {string} systemPrompt - System instructions for the AI
 */
export function initializeChatSession(sessionId: string, systemPrompt: string): void {
  conversationHistory.set(sessionId, [
    {
      role: 'system',
      content: systemPrompt
    }
  ]);
  console.log(`[ChatTherapy] Session ${sessionId.substring(0, 12)}... initialized`);
}

/**
 * Convert registry tool definitions (Realtime session schema) to the
 * Responses API function-tool schema. The shapes are nearly identical, but
 * Responses defaults `strict: true`, which rejects our schemas (optional
 * properties, no additionalProperties:false) — so strict is pinned off.
 */
export function toResponsesTools(
  defs: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
): Array<Record<string, unknown>> {
  return defs.map(d => ({
    type: 'function',
    name: d.name,
    description: d.description,
    parameters: d.parameters,
    strict: false,
  }));
}

/** Fire-and-forget cost tracking for one Responses call (telemetry audit). */
function recordChatUsage(sessionId: string, usage: ResponsesResult['usage']): void {
  import('../db/index.js')
    .then(({ recordLlmUsage }) => recordLlmUsage(
      sessionId, 'chat', CHAT_MODEL,
      usage?.input_tokens ?? null, usage?.output_tokens ?? null,
    ))
    .catch(err => console.error('[ChatTherapy] Failed to record LLM usage (non-fatal):', err));
}

/**
 * Fire-and-forget turn-latency logging (telemetry pass 3). Chat is
 * non-streaming, so time-to-first-output equals total turn time; total is the
 * full tool-loop wall time, which is what the participant actually waited.
 */
function recordChatLatency(sessionId: string, turnIndex: number, startedAt: Date, finishedAt: Date): void {
  insertTurnLatency({
    sessionId,
    turnIndex,
    userDoneAt: startedAt,
    firstOutputAt: finishedAt,
    responseDoneAt: finishedAt,
    channel: 'chat',
  }).catch(err => console.error('[ChatTherapy] Failed to record turn latency (non-fatal):', err));
}

/**
 * Send a message and get AI response
 * @param {string} sessionId - Session identifier
 * @param {string} userMessage - User's message
 * @returns {Promise<ChatTurnResult>} - Assistant text + executed tool events
 */
export async function sendMessage(sessionId: string, userMessage: string): Promise<ChatTurnResult> {
  const turnStartedAt = new Date();
  const apiKey = await getOpenAIKey();
  const client = new OpenAI({ apiKey }) as unknown as ResponsesClient;

  // Get or initialize conversation history
  if (!conversationHistory.has(sessionId)) {
    throw new Error(`Session ${sessionId} not initialized. Call initializeChatSession first.`);
  }

  const messages = conversationHistory.get(sessionId)!;

  // Text-safe tool subset (ai-therapist-118), honoring features.disabled_tools
  // exactly like the realtime mint path. Fail-open: a registry/config error
  // degrades to a tool-less reply, never a failed turn.
  let tools: Array<Record<string, unknown>> = [];
  try {
    const { toolRegistry } = await import('./toolRegistry.service.js');
    tools = toResponsesTools(await toolRegistry.getEnabledToolDefinitions({ channel: 'chat' }));
  } catch (err) {
    console.error('[ChatTherapy] Failed to load chat tools (replying without tools):', err);
  }

  try {
    // Build the input array for the OpenAI Responses API by preserving the
    // stored history IN ORDER (system prompt at index 0, then the alternating
    // turns, plus any mid-conversation clinical-guidance system items injected
    // via injectGuidance — ai-therapist-105), then appending the current user
    // message. Order is load-bearing: injected guidance must reach the model
    // before the turn it is meant to steer, so we can no longer collapse all
    // system messages to a single leading one.
    const input: ChatHistoryItem[] = [
      ...messages,
      { role: 'user', content: userMessage },
    ];

    const callModel = (toolChoice: 'auto' | 'none') =>
      client.responses.create({
        model: CHAT_MODEL,
        input,
        store: false,
        ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
      });

    // Tool loop (ai-therapist-118): execute function calls via the registry
    // (with sideband-parity logging), feed the outputs back, and re-call
    // until the model produces text. The final permitted round forces text
    // with tool_choice:'none' so a runaway tool chain can't eat the turn.
    const toolEvents: ChatToolEvent[] = [];
    const turnItems: ChatHistoryItem[] = []; // raw output + tool-output items to persist in history
    let toolCallCount = 0;
    let response = await callModel('auto');
    recordChatUsage(sessionId, response.usage);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const calls = (response.output ?? []).filter(o => o.type === 'function_call' && o.name && o.call_id);
      if (calls.length === 0) break;

      // Replay the model's raw output items VERBATIM (not reconstructed
      // function_call items): reasoning models emit sibling `reasoning` items
      // that MUST accompany their function_call on the next request, or the
      // API 400s. Passing the whole output block through keeps every item the
      // model needs, then the function_call_output items follow by call_id.
      const rawOutputItems = (response.output ?? []) as unknown as ChatHistoryItem[];
      input.push(...rawOutputItems);
      turnItems.push(...rawOutputItems);

      const { executeLoggedToolCall } = await import('./toolExecution.helpers.js');
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
        } catch {
          console.error(`[ChatTherapy] Unparseable arguments for ${call.name}; executing with {}`);
        }
        const { result } = await executeLoggedToolCall(sessionId, call.name!, args, call.call_id!, 'chat');
        toolCallCount++;

        if (CLIENT_RENDERED_TOOLS.has(call.name!)) {
          toolEvents.push({ name: call.name!, args, result });
        }

        const outputItem: Record<string, unknown> = {
          type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result),
        };
        input.push(outputItem);
        turnItems.push(outputItem);
      }

      response = await callModel(round + 1 >= MAX_TOOL_ROUNDS ? 'none' : 'auto');
      recordChatUsage(sessionId, response.usage);
    }

    // Extract assistant message from response
    const assistantMessage = response.output_text;

    // Telemetry pass 3: log the full turn wall time (user request -> final
    // text, including any tool rounds). turn_index = this user turn's ordinal.
    const turnIndex = messages.filter(m => (m as ChatMessage).role === 'user').length + 1;
    recordChatLatency(sessionId, turnIndex, turnStartedAt, new Date());

    // Persist the turn in order: user message, any tool call/output items,
    // then the assistant's text.
    messages.push({ role: 'user', content: userMessage });
    messages.push(...turnItems);
    messages.push({ role: 'assistant', content: assistantMessage });

    // Update conversation history
    conversationHistory.set(sessionId, messages);

    console.log(
      `[ChatTherapy] Session ${sessionId.substring(0, 12)}... - Message exchanged` +
      `${toolCallCount > 0 ? ` (${toolCallCount} tool call(s))` : ''}` +
      ` (${messages.length - 1} items in history)`
    );

    return { text: assistantMessage, toolEvents };

  } catch (error: unknown) {
    console.error('[ChatTherapy] Error generating response:', error);
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate response: ${msg}`);
  }
}

/**
 * Append an invisible steering/clinical-guidance message to a session's model
 * context (ai-therapist-105). It persists in the in-memory history — parity
 * with sideband injection, which also persists in the realtime conversation —
 * so it shapes every subsequent turn until the session ends. It is NOT
 * persisted to the `messages` table (same as sideband injections); the audit
 * trail lives in intervention_actions. No-op when the session is unknown.
 *
 * The Responses API accepts mid-conversation `system` items in `input` (same
 * shape already used at index 0), so this rides along with the next sendMessage.
 */
export function injectGuidance(sessionId: string, guidance: string): void {
  conversationHistory.get(sessionId)?.push({ role: 'system', content: guidance });
}

/**
 * Get conversation history for a session
 * @param {string} sessionId
 * @returns {Array} Array of message objects
 */
export function getConversationHistory(sessionId: string): ChatHistoryItem[] {
  return conversationHistory.get(sessionId) || [];
}

/**
 * End a chat therapy session and clean up memory
 * @param {string} sessionId
 */
export function endChatSession(sessionId: string): void {
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
export function getActiveSessionCount(): number {
  return conversationHistory.size;
}
