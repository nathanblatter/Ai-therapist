// Which overlay the typed-chat client opens for each tool, on success, on a
// handler refusal, on a thrown error and on a timeout (ai-therapist-367).
import { describe, it, expect } from 'vitest';
import { CHAT_OVERLAY_POLICY, chatOverlayEvent, toolCallOutcome } from './chatToolOverlays.js';
import { toolTimeoutMessage } from './toolTimeouts.js';
import type { ExecutedToolCall } from './toolExecution.helpers.js';

const ARGS: Record<string, Record<string, unknown>> = {
  show_resource_card: { resource_type: 'suicide' },
  start_thought_record: {},
  show_journaling_prompt: { prompt: 'What would you say?' },
  display_session_recap: { focus: 'sleep', takeaway: 'one step' },
  administer_scale: { scale: 'phq2' },
  create_custom_worksheet: { template_id: 3, title: 'My plan', sections: [{ type: 'text', label: 'One' }] },
  create_safety_plan: { warning_signs: ['cannot sleep'], coping_strategies: ['walk'] },
};

// The shapes executeLoggedToolCall returns for each way a call can end.
const OUTCOMES: Record<string, (name: string) => ExecutedToolCall> = {
  success: () => ({ result: { success: true, guidance: 'shown' }, success: true, timedOut: false }),
  // The handler returned an error envelope: validation, the scale cadence,
  // or the admin kill switch.
  refused: () => ({ result: { error: 'scale_recently_administered' }, success: true, timedOut: false }),
  error: () => ({ result: { error: 'connection terminated', success: false }, success: false, timedOut: false }),
  timeout: (name) => ({ result: { error: toolTimeoutMessage(name), success: false }, success: false, timedOut: true }),
};

// shown | hidden | unconfirmed (shown, marked "may not have been saved").
const EXPECTED: Record<string, Record<string, 'shown' | 'hidden' | 'unconfirmed'>> = {
  show_resource_card: { success: 'shown', refused: 'shown', error: 'shown', timeout: 'shown' },
  start_thought_record: { success: 'shown', refused: 'hidden', error: 'hidden', timeout: 'hidden' },
  show_journaling_prompt: { success: 'shown', refused: 'hidden', error: 'hidden', timeout: 'hidden' },
  display_session_recap: { success: 'shown', refused: 'hidden', error: 'hidden', timeout: 'hidden' },
  administer_scale: { success: 'shown', refused: 'hidden', error: 'hidden', timeout: 'hidden' },
  create_custom_worksheet: { success: 'shown', refused: 'hidden', error: 'hidden', timeout: 'hidden' },
  create_safety_plan: { success: 'shown', refused: 'hidden', error: 'unconfirmed', timeout: 'unconfirmed' },
};

describe('chat overlay per tool and outcome', () => {
  it('covers exactly the tools the chat client renders', () => {
    expect(Object.keys(CHAT_OVERLAY_POLICY).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [tool, byOutcome] of Object.entries(EXPECTED)) {
    for (const [outcome, want] of Object.entries(byOutcome)) {
      it(`${tool}, ${outcome}: ${want}`, () => {
        const executed = OUTCOMES[outcome](tool);
        const event = chatOverlayEvent(tool, ARGS[tool], executed);
        if (want === 'hidden') {
          expect(event).toBeNull();
          return;
        }
        expect(event).toMatchObject({ name: tool, args: ARGS[tool], result: executed.result });
        if (want === 'unconfirmed') expect(event?.unconfirmed).toBe(true);
        else expect(event).not.toHaveProperty('unconfirmed');
      });
    }
  }

  it('the crisis-resource card shows whatever the call returned, even with no result at all', () => {
    for (const executed of [
      { result: undefined, success: false },
      { result: { error: 'The show_resource_card tool is currently unavailable.' }, success: true },
      { result: null, success: true, timedOut: true },
    ] as ExecutedToolCall[]) {
      expect(chatOverlayEvent('show_resource_card', {}, executed)).toMatchObject({ name: 'show_resource_card' });
    }
  });

  it('tools with no chat overlay never produce an event, whatever happened', () => {
    for (const tool of ['set_session_goal', 'assign_practice', 'remember_this', 'escalate_to_human', 'end_session']) {
      expect(chatOverlayEvent(tool, {}, OUTCOMES.success(tool))).toBeNull();
    }
  });

  it('classifies outcomes: timeout before failure, an error envelope as a refusal', () => {
    expect(toolCallOutcome({ result: {}, success: false, timedOut: true })).toBe('timed_out');
    expect(toolCallOutcome({ result: {}, success: false })).toBe('failed');
    expect(toolCallOutcome({ result: { error: 'x' }, success: true })).toBe('refused');
    expect(toolCallOutcome({ result: { success: false }, success: true })).toBe('refused');
    expect(toolCallOutcome({ result: { assigned: true }, success: true })).toBe('ok');
    expect(toolCallOutcome({ result: 'done', success: true })).toBe('ok');
    expect(toolCallOutcome({ result: { error: null, success: true }, success: true })).toBe('ok');
  });
});
