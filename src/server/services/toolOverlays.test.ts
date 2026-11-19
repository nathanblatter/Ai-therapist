// Which overlay each channel opens for each tool, on success, on a handler
// refusal, on a thrown error and on a timeout: typed chat (ai-therapist-367)
// and voice (both backends share voiceOverlayEvent; their own tests drive it
// through the managers).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CHAT_OVERLAY_POLICY,
  chatOverlayEvent,
  clearVoiceToolOutcomes,
  getVoiceToolOutcome,
  reportVoiceToolOutcome,
  toolCallOutcome,
  voiceOverlayEvent,
  withScreenNote,
  VOICE_OUTCOME_TTL_MS,
} from './toolOverlays.js';
import { toolTimeoutMessage } from './toolTimeouts.js';
import type { ExecutedToolCall } from './toolExecution.helpers.js';
import {
  CHAT_OVERLAY_TOOLS,
  EXPECTED_OVERLAY,
  OUTCOME_CASES,
  OVERLAY_ARGS,
  type OutcomeCase,
} from './toolOverlays.testTable.js';
import {
  OVERLAY_NOT_SHOWN_NOTE,
  OVERLAY_UNCONFIRMED_NOTE,
  TOOL_OVERLAYS,
  VOICE_OVERLAY_CONFIRM_DEADLINE_MS,
  VOICE_OVERLAY_FALLBACK_MS,
  VOICE_OVERLAY_POLL_AT_MS,
} from '../../shared/toolOverlayPolicy.js';
import { TOOL_TIMEOUT_DEFAULT_MS, toolTimeoutMs } from './toolTimeouts.js';

// The shapes executeLoggedToolCall (and both voice managers) produce for each
// way a call can end.
const OUTCOMES: Record<OutcomeCase, (name: string) => ExecutedToolCall> = {
  success: () => ({ result: { success: true, guidance: 'shown' }, success: true, timedOut: false }),
  refused: () => ({ result: { error: 'scale_recently_administered' }, success: true, timedOut: false }),
  error: () => ({ result: { error: 'connection terminated', success: false }, success: false, timedOut: false }),
  timeout: (name) => ({ result: { error: toolTimeoutMessage(name), success: false }, success: false, timedOut: true }),
};

describe('one policy table for every channel', () => {
  it('covers exactly the overlay tools, and chat keeps exactly the PR #84 set', () => {
    expect(Object.keys(TOOL_OVERLAYS).sort()).toEqual(Object.keys(EXPECTED_OVERLAY).sort());
    expect(Object.keys(CHAT_OVERLAY_POLICY).sort()).toEqual([...CHAT_OVERLAY_TOOLS].sort());
  });

  it('only the crisis-resource card shows without waiting; screeners and saved artefacts never show unconfirmed', () => {
    const now = Object.entries(TOOL_OVERLAYS).filter(([, s]) => s.withoutOutcome === 'show_now');
    expect(now.map(([n]) => n)).toEqual(['show_resource_card']);
    for (const name of ['administer_scale', 'create_custom_worksheet', 'create_safety_plan']) {
      expect(TOOL_OVERLAYS[name].withoutOutcome).toBe('never');
    }
  });

  it('the browser waits past every overlay tool timeout before it gives up', () => {
    for (const name of Object.keys(TOOL_OVERLAYS)) {
      expect(toolTimeoutMs(name)).toBe(TOOL_TIMEOUT_DEFAULT_MS);
      expect(VOICE_OVERLAY_CONFIRM_DEADLINE_MS).toBeGreaterThanOrEqual(toolTimeoutMs(name) * 2);
    }
    expect(VOICE_OVERLAY_POLL_AT_MS[0]).toBe(VOICE_OVERLAY_FALLBACK_MS);
    expect(VOICE_OVERLAY_POLL_AT_MS[VOICE_OVERLAY_POLL_AT_MS.length - 1]).toBe(VOICE_OVERLAY_CONFIRM_DEADLINE_MS);
  });
});

describe('chat overlay per tool and outcome', () => {
  for (const tool of CHAT_OVERLAY_TOOLS) {
    for (const outcome of OUTCOME_CASES) {
      const want = EXPECTED_OVERLAY[tool][outcome];
      it(`${tool}, ${outcome}: ${want}`, () => {
        const executed = OUTCOMES[outcome](tool);
        const event = chatOverlayEvent(tool, OVERLAY_ARGS[tool], executed);
        if (want === 'hidden') {
          expect(event).toBeNull();
          return;
        }
        expect(event).toMatchObject({ name: tool, args: OVERLAY_ARGS[tool], result: executed.result });
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

  it('tools with no chat overlay never produce an event, whatever happened (voice exercises included)', () => {
    for (const tool of [
      'set_session_goal',
      'assign_practice',
      'remember_this',
      'escalate_to_human',
      'end_session',
      'start_breathing_exercise',
      'start_values_sort',
    ]) {
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

describe('voice overlay per tool and outcome', () => {
  for (const [tool, byOutcome] of Object.entries(EXPECTED_OVERLAY)) {
    for (const outcome of OUTCOME_CASES) {
      it(`${tool}, ${outcome}: ${byOutcome[outcome]}`, () => {
        const event = voiceOverlayEvent('call_1', tool, OVERLAY_ARGS[tool], OUTCOMES[outcome](tool));
        expect(event).toEqual({ callId: 'call_1', name: tool, args: OVERLAY_ARGS[tool], overlay: byOutcome[outcome] });
      });
    }
  }

  it('tools with no overlay produce no outcome', () => {
    for (const tool of ['find_worksheet', 'escalate_to_human', 'end_session', 'set_session_goal']) {
      expect(voiceOverlayEvent('c', tool, {}, OUTCOMES.success(tool))).toBeNull();
    }
  });
});

describe('the tool result the voice model hears', () => {
  const ev = (overlay: 'shown' | 'hidden' | 'unconfirmed') => ({
    callId: 'c',
    name: 'administer_scale',
    args: {},
    overlay,
  });

  it('a refused screener says nothing is on the screen, keeping the refusal guidance', () => {
    const refusal = { error: 'scale_recently_administered', guidance: 'Continue without the screener.' };
    expect(withScreenNote(refusal, ev('hidden'))).toEqual({ ...refusal, screen: OVERLAY_NOT_SHOWN_NOTE });
  });

  it('an unconfirmed safety plan says it may not have been saved', () => {
    expect(withScreenNote({ error: 'x', success: false }, ev('unconfirmed'))).toMatchObject({
      screen: OVERLAY_UNCONFIRMED_NOTE,
    });
  });

  it('leaves a shown overlay, a tool with no overlay and a non-object result unchanged', () => {
    const ok = { success: true };
    expect(withScreenNote(ok, ev('shown'))).toBe(ok);
    expect(withScreenNote(ok, null)).toBe(ok);
    expect(withScreenNote('text', ev('hidden'))).toBe('text');
    expect(withScreenNote(undefined, ev('hidden'))).toBeUndefined();
  });
});

describe('delivery to the browser', () => {
  beforeEach(() => clearVoiceToolOutcomes());

  it('emits session:tool-outcome to the session room and keeps it for the HTTP fallback', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    (global as unknown as { io: unknown }).io = { to };
    const event = { callId: 'c1', name: 'administer_scale', args: { scale: 'phq2' }, overlay: 'hidden' as const };
    reportVoiceToolOutcome('s1', event, 1_000);
    expect(to).toHaveBeenCalledWith('session:s1');
    expect(emit).toHaveBeenCalledWith('session:tool-outcome', { sessionId: 's1', ...event });
    expect(getVoiceToolOutcome('s1', 'c1', 2_000)).toEqual(event);
    expect(getVoiceToolOutcome('s1', 'other', 2_000)).toBeNull();
    expect(getVoiceToolOutcome('s2', 'c1', 2_000)).toBeNull();
    expect(getVoiceToolOutcome('s1', 'c1', 1_000 + VOICE_OUTCOME_TTL_MS + 1)).toBeNull();
    (global as unknown as { io: unknown }).io = undefined;
  });

  it('never throws, and still keeps the outcome, when the socket server is missing or broken', () => {
    (global as unknown as { io: unknown }).io = undefined;
    const event = { callId: 'c2', name: 'create_safety_plan', args: {}, overlay: 'unconfirmed' as const };
    expect(() => reportVoiceToolOutcome('s1', event)).not.toThrow();
    expect(getVoiceToolOutcome('s1', 'c2')).toEqual(event);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (global as unknown as { io: unknown }).io = {
      to: () => {
        throw new Error('adapter down');
      },
    };
    expect(() => reportVoiceToolOutcome('s1', { ...event, callId: 'c3' })).not.toThrow();
    expect(getVoiceToolOutcome('s1', 'c3')).toMatchObject({ callId: 'c3' });
    (global as unknown as { io: unknown }).io = undefined;
  });
});
