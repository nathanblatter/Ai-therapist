// Which tool overlays the participant's screen is told to open, given what the
// tool call actually did. The policy itself lives in shared/toolOverlayPolicy.ts
// (one table for typed chat and both voice backends); this module applies it on
// the server.
//
// Typed chat (ai-therapist-367, PR #84): chatTherapy.service executes the
// model's tool calls and returns the visual ones to the browser as toolEvents;
// chatOverlayEvent decides which.
//
// Voice (GPT-Live sideband and the Grok proxy): the browser used to open an
// overlay the moment the model called the tool, before the server had run it,
// so a failed safety plan or worksheet looked saved and a screener the 7-day
// cadence REFUSED (a consent-form commitment) still appeared. Now the voice
// manager, once the call has run, builds a voiceOverlayEvent and hands it to
// reportVoiceToolOutcome, which pushes it to the participant's session room
// (`session:tool-outcome`, the socket the app already uses for server-pushed
// session events) and keeps it so the browser can ask for it over HTTP when the
// socket message is lost (GET /api/sessions/:id/tool-outcome/:callId). The
// browser opens the overlay only on that outcome, except the crisis-resource
// card, which it always opens at once (client/main/lib/voiceOverlayGate.ts).

import type { ExecutedToolCall } from './toolExecution.helpers.js';
import {
  TOOL_OVERLAYS,
  OVERLAY_NOT_SHOWN_NOTE,
  OVERLAY_UNCONFIRMED_NOTE,
  classifyToolCall,
  overlayDecision,
  type OverlayDecision,
  type OverlayPolicy,
  type ToolCallOutcome,
  type ToolOverlayOutcome,
} from '../../shared/toolOverlayPolicy.js';

export type { OverlayDecision, OverlayPolicy, ToolCallOutcome, ToolOverlayOutcome };
export { TOOL_OVERLAYS };

/** The overlays the typed-chat client renders, with their policy. */
export const CHAT_OVERLAY_POLICY: Readonly<Record<string, OverlayPolicy>> = Object.fromEntries(
  Object.entries(TOOL_OVERLAYS)
    .filter(([, spec]) => spec.chat)
    .map(([name, spec]) => [name, spec.policy]),
);

/** One executed tool call surfaced to the chat client (ai-therapist-118). */
export interface ChatToolEvent {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  /** The write behind this overlay did not confirm (timed out or failed): the
   *  client shows it as "may not have been saved". Absent when it did. */
  unconfirmed?: true;
}

/** How a tool call ended. See shared/toolOverlayPolicy.ts classifyToolCall. */
export function toolCallOutcome(executed: ExecutedToolCall): ToolCallOutcome {
  return classifyToolCall(executed);
}

/** The overlay event for one executed call, or null when the chat client
 *  must not open one. */
export function chatOverlayEvent(
  name: string,
  args: Record<string, unknown>,
  executed: ExecutedToolCall,
): ChatToolEvent | null {
  if (!CHAT_OVERLAY_POLICY[name]) return null;
  const decision = overlayDecision(name, classifyToolCall(executed));
  if (decision === null || decision === 'hidden') return null;
  const event: ChatToolEvent = { name, args, result: executed.result };
  return decision === 'unconfirmed' ? { ...event, unconfirmed: true } : event;
}

/** The voice outcome for one executed call, or null for a tool with no overlay. */
export function voiceOverlayEvent(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  executed: ExecutedToolCall,
): ToolOverlayOutcome | null {
  const overlay = overlayDecision(name, classifyToolCall(executed));
  if (overlay === null) return null;
  return { callId, name, args, overlay };
}

/**
 * The tool result handed to the voice model, with a plain `screen` line when
 * the overlay did not open (or opened marked unconfirmed), so the model never
 * says "I've put a questionnaire on your screen" for one that is not there.
 * Results that are not objects, and tools whose overlay opened, are unchanged.
 */
export function withScreenNote(output: unknown, event: ToolOverlayOutcome | null): unknown {
  if (!event || event.overlay === 'shown') return output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  return {
    ...(output as Record<string, unknown>),
    screen: event.overlay === 'hidden' ? OVERLAY_NOT_SHOWN_NOTE : OVERLAY_UNCONFIRMED_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Delivery to the participant's browser
// ---------------------------------------------------------------------------

/** How long an outcome stays answerable over HTTP: well past the browser's
 *  own deadline (VOICE_OVERLAY_CONFIRM_DEADLINE_MS). */
export const VOICE_OUTCOME_TTL_MS = 5 * 60 * 1000;

const outcomes = new Map<string, Map<string, { at: number; event: ToolOverlayOutcome }>>();

function prune(now: number): void {
  for (const [sessionId, calls] of outcomes) {
    for (const [callId, entry] of calls) {
      if (now - entry.at > VOICE_OUTCOME_TTL_MS) calls.delete(callId);
    }
    if (calls.size === 0) outcomes.delete(sessionId);
  }
}

/**
 * Tell the participant's browser how a voice tool call ended: emitted to the
 * session room and kept for the HTTP fallback. Never throws: a delivery
 * problem must not break tool execution.
 */
export function reportVoiceToolOutcome(sessionId: string, event: ToolOverlayOutcome, now = Date.now()): void {
  try {
    const calls = outcomes.get(sessionId) ?? new Map<string, { at: number; event: ToolOverlayOutcome }>();
    calls.set(event.callId, { at: now, event });
    outcomes.set(sessionId, calls);
    if (calls.size > 200 || outcomes.size > 500) prune(now);
    global.io?.to(`session:${sessionId}`).emit('session:tool-outcome', { sessionId, ...event });
  } catch (err) {
    console.error(`[ToolOverlays] outcome delivery failed for ${sessionId.substring(0, 12)}...:`, err);
  }
}

/** The outcome kept for one call, or null when none is known (yet). */
export function getVoiceToolOutcome(sessionId: string, callId: string, now = Date.now()): ToolOverlayOutcome | null {
  const entry = outcomes.get(sessionId)?.get(callId);
  if (!entry || now - entry.at > VOICE_OUTCOME_TTL_MS) return null;
  return entry.event;
}

/** Drop kept outcomes (session end / tests). */
export function clearVoiceToolOutcomes(sessionId?: string): void {
  if (sessionId === undefined) outcomes.clear();
  else outcomes.delete(sessionId);
}
