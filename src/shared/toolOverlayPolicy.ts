// Which tool overlays the participant's screen may show, given what the tool
// call actually did. ONE policy for every channel: typed chat (ai-therapist-367,
// PR #84) and both voice backends, GPT-Live and Grok (this file's voice half).
//
// The server executes every model tool call (toolRegistry.service) and decides
// from how the call ended whether its overlay is shown, hidden, or shown marked
// "may not have been saved". Chat returns that decision with the reply
// (server/services/toolOverlays.ts, chatOverlayEvent). Voice sends it to the
// browser as a `tool_outcome` message once the call has run (voiceOverlayEvent):
// the browser does NOT open an overlay because the model asked for it, except
// the crisis-resource card (client/main/lib/voiceOverlayGate.ts).
//
// Per tool, from what its handler does:
//
//   always          show_resource_card. The crisis-resource card is static
//                   (988, Crisis Text Line, 911) and is shown whatever happened
//                   to the call, even when the tool is switched off. On voice it
//                   opens the moment the model calls it, before the server has
//                   run anything. Never make this one stricter or slower.
//   on_success      shown only when the call succeeded. Display-only tools with
//                   no write (thought record, journaling prompt, session recap,
//                   the voice exercises); and the two whose handler can REFUSE:
//                   administer_scale (the 7-day cadence the consent form
//                   promises) and create_custom_worksheet (template validation,
//                   then the instance write the participant's answers attach
//                   to). On an error or a timeout the model is told the tool did
//                   not happen, so an overlay would contradict it.
//   saved_or_unconfirmed
//                   create_safety_plan. Saved: shown. Refused (missing warning
//                   signs or coping steps, tool switched off): hidden. The write
//                   timed out or threw: shown, marked "may not have been saved".
//
// Voice only: what the browser does if the server's word never comes
// (`withoutOutcome`): 'show_now' (the resource card: it never waits),
// 'show_after_bound' (display-only overlays: shown after
// VOICE_OVERLAY_FALLBACK_MS so a lost message cannot swallow a breathing
// exercise), 'never' (a screener or a saved artefact: never shown without
// the server's confirmation).

export type OverlayPolicy = 'always' | 'on_success' | 'saved_or_unconfirmed';

/** What the participant's screen does with one tool call. */
export type OverlayDecision = 'shown' | 'hidden' | 'unconfirmed';

/** How a tool call ended, as far as the overlay is concerned. */
export type ToolCallOutcome = 'ok' | 'refused' | 'failed' | 'timed_out';

export interface ToolOverlaySpec {
  policy: OverlayPolicy;
  /** Voice: what the browser does when the server's outcome never arrives. */
  withoutOutcome: 'show_now' | 'show_after_bound' | 'never';
  /** The typed-chat client renders this overlay (PR #84's set). The voice
   *  exercises are realtime-only tools and never reach chat. */
  chat: boolean;
}

export const TOOL_OVERLAYS: Readonly<Record<string, ToolOverlaySpec>> = {
  show_resource_card: { policy: 'always', withoutOutcome: 'show_now', chat: true },
  start_thought_record: { policy: 'on_success', withoutOutcome: 'show_after_bound', chat: true },
  show_journaling_prompt: { policy: 'on_success', withoutOutcome: 'show_after_bound', chat: true },
  display_session_recap: { policy: 'on_success', withoutOutcome: 'show_after_bound', chat: true },
  start_breathing_exercise: { policy: 'on_success', withoutOutcome: 'show_after_bound', chat: false },
  start_grounding_exercise: { policy: 'on_success', withoutOutcome: 'show_after_bound', chat: false },
  start_body_scan: { policy: 'on_success', withoutOutcome: 'show_after_bound', chat: false },
  start_values_sort: { policy: 'on_success', withoutOutcome: 'show_after_bound', chat: false },
  start_fear_ladder: { policy: 'on_success', withoutOutcome: 'show_after_bound', chat: false },
  administer_scale: { policy: 'on_success', withoutOutcome: 'never', chat: true },
  create_custom_worksheet: { policy: 'on_success', withoutOutcome: 'never', chat: true },
  create_safety_plan: { policy: 'saved_or_unconfirmed', withoutOutcome: 'never', chat: true },
};

/**
 * Voice: how long the browser waits for the server's outcome before it asks
 * for it over HTTP, and, for a display-only overlay, before it shows it anyway.
 * The handlers behind these overlays take milliseconds; what the participant
 * waits for is one database insert, the handler, and one socket hop (typically
 * well under half a second), so this is only reached when the message was lost.
 */
export const VOICE_OVERLAY_FALLBACK_MS = 1_500;

/**
 * Voice: when the browser stops waiting for the outcome of a screener or a
 * saved artefact and drops it unshown. The registry answers every overlay tool
 * within its 5 s timeout (toolTimeouts.ts), so a real outcome exists by then;
 * the margin covers the logging around it.
 */
export const VOICE_OVERLAY_CONFIRM_DEADLINE_MS = 15_000;

/** When the browser asks again over HTTP for an outcome it has not received. */
export const VOICE_OVERLAY_POLL_AT_MS: readonly number[] = [VOICE_OVERLAY_FALLBACK_MS, 4_000, 8_000, 15_000];

/**
 * The outcome of one voice tool call, sent server -> browser on the session
 * socket (`session:tool-outcome`), on the Grok voice socket (`tool_outcome`),
 * and answered by GET /api/sessions/:id/tool-outcome/:callId.
 */
export interface ToolOverlayOutcome {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  overlay: OverlayDecision;
}

/** The decision for one tool given how its call ended; null for a tool with no overlay. */
export function overlayDecision(name: string, outcome: ToolCallOutcome | null): OverlayDecision | null {
  const spec = TOOL_OVERLAYS[name];
  if (!spec) return null;
  if (spec.policy === 'always') return 'shown';
  if (outcome === 'ok') return 'shown';
  if (spec.policy === 'saved_or_unconfirmed' && (outcome === 'timed_out' || outcome === 'failed')) {
    return 'unconfirmed';
  }
  return 'hidden';
}

/**
 * 'timed_out': the registry's timeout answered (the handler may still finish).
 * 'failed': the handler threw. 'refused': the handler returned an error
 * envelope ({ error } or success: false): validation, the scale cadence, the
 * admin kill switch. 'ok': anything else.
 */
export function classifyToolCall(executed: { result: unknown; success: boolean; timedOut?: boolean }): ToolCallOutcome {
  if (executed.timedOut) return 'timed_out';
  if (!executed.success) return 'failed';
  const result = executed.result;
  if (result && typeof result === 'object') {
    const r = result as { error?: unknown; success?: unknown };
    if ((r.error !== undefined && r.error !== null) || r.success === false) return 'refused';
  }
  return 'ok';
}

/** Set on the model's tool result when the overlay did not open, so the voice
 *  model never says something is on the participant's screen that is not. */
export const OVERLAY_NOT_SHOWN_NOTE =
  "Nothing from this call is on the participant's screen. Do not say or suggest that it is.";

/** Set on the model's tool result when the safety plan is shown but its save
 *  did not confirm. */
export const OVERLAY_UNCONFIRMED_NOTE =
  "The plan is on the participant's screen with a note that it may not have been saved. Do not say it was saved; " +
  'suggest they take a screenshot so they keep it.';
