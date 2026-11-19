// Which tool overlays the typed-chat client is told to open, given what the
// tool call actually did (ai-therapist-367).
//
// The chat pipeline executes the model's tool calls on the server
// (chatTherapy.service) and returns the visual ones to the browser as
// toolEvents; the browser opens the matching overlay. Until 2026-11-19 every
// overlay tool was returned whatever its result, so a create_safety_plan or
// create_custom_worksheet that failed or timed out still opened on the
// participant's screen as if it had been saved, and an administer_scale the
// server refused (the 7-day screener cadence the consent form promises) still
// showed the screener.
//
// Per tool, from what its handler does (toolRegistry.service):
//
//   always          show_resource_card. The crisis-resource card is static
//                   (988, Crisis Text Line, 911) and is shown whatever
//                   happened to the call, even when the tool is switched off.
//                   Never make this one stricter.
//   on_success      pure display tools with no write: thought record,
//                   journaling prompt, session recap; and the two whose
//                   handler can REFUSE: administer_scale (cadence) and
//                   create_custom_worksheet (template validation, then the
//                   instance write the participant's answers attach to). On
//                   an error or a timeout the model is told the tool did not
//                   happen ("tell them plainly that you could not do it", or
//                   for the worksheet "not sure it went through"), so an
//                   overlay would contradict it; and a worksheet whose
//                   instance was never written would have its answers filed
//                   against an older draft, or lost.
//   saved_or_unconfirmed
//                   create_safety_plan. Saved: shown. Refused by the handler
//                   (missing warning signs or coping steps, tool switched
//                   off): not shown, nothing was saved and the plan is
//                   incomplete. The write timed out or threw: shown, marked
//                   "may not have been saved" (the client says so in plain
//                   words). The plan is the participant's own words, and
//                   seeing it helps; it must not look saved.
//
// Tools not listed here never reach the chat client (data-only tools stay
// server-side; set_session_goal and assign_practice have no overlay).

import type { ExecutedToolCall } from './toolExecution.helpers.js';

export type ChatOverlayPolicy = 'always' | 'on_success' | 'saved_or_unconfirmed';

export const CHAT_OVERLAY_POLICY: Readonly<Record<string, ChatOverlayPolicy>> = {
  show_resource_card: 'always',
  start_thought_record: 'on_success',
  show_journaling_prompt: 'on_success',
  display_session_recap: 'on_success',
  administer_scale: 'on_success',
  create_custom_worksheet: 'on_success',
  create_safety_plan: 'saved_or_unconfirmed',
};

/** One executed tool call surfaced to the chat client (ai-therapist-118). */
export interface ChatToolEvent {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  /** The write behind this overlay did not confirm (timed out or failed): the
   *  client shows it as "may not have been saved". Absent when it did. */
  unconfirmed?: true;
}

/** How a tool call ended, as far as the overlay is concerned. */
export type ToolCallOutcome = 'ok' | 'refused' | 'failed' | 'timed_out';

/**
 * 'timed_out': the registry's timeout answered (the handler may still finish).
 * 'failed': the handler threw. 'refused': the handler returned an error
 * envelope ({ error } or success: false): validation, the scale cadence, the
 * admin kill switch. 'ok': anything else.
 */
export function toolCallOutcome(executed: ExecutedToolCall): ToolCallOutcome {
  if (executed.timedOut) return 'timed_out';
  if (!executed.success) return 'failed';
  const result = executed.result;
  if (result && typeof result === 'object') {
    const r = result as { error?: unknown; success?: unknown };
    if ((r.error !== undefined && r.error !== null) || r.success === false) return 'refused';
  }
  return 'ok';
}

/** The overlay event for one executed call, or null when the chat client
 *  must not open one. */
export function chatOverlayEvent(
  name: string,
  args: Record<string, unknown>,
  executed: ExecutedToolCall,
): ChatToolEvent | null {
  const policy = CHAT_OVERLAY_POLICY[name];
  if (!policy) return null;
  const event: ChatToolEvent = { name, args, result: executed.result };
  if (policy === 'always') return event;
  const outcome = toolCallOutcome(executed);
  if (outcome === 'ok') return event;
  if (policy === 'saved_or_unconfirmed' && (outcome === 'timed_out' || outcome === 'failed')) {
    return { ...event, unconfirmed: true };
  }
  return null;
}
