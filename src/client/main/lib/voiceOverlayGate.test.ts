// The browser half of the voice overlay policy (shared/toolOverlayPolicy.ts):
// GPT-Live and Grok feed the same gate, so the same calls and outcomes must
// open the same overlays whichever backend delivered them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VoiceOverlayGate, type PendingOverlay } from './voiceOverlayGate';
import {
  TOOL_OVERLAYS,
  VOICE_OVERLAY_CONFIRM_DEADLINE_MS,
  VOICE_OVERLAY_FALLBACK_MS,
  type OverlayDecision,
  type ToolOverlayOutcome,
} from '../../../shared/toolOverlayPolicy';

function makeGate(fetchOutcome: (callId: string) => Promise<ToolOverlayOutcome | null> = async () => null) {
  const open = vi.fn();
  const pending: PendingOverlay[][] = [];
  const fetchMock = vi.fn(fetchOutcome);
  const gate = new VoiceOverlayGate({
    open,
    fetchOutcome: fetchMock,
    onPendingChange: (p) => pending.push(p),
  });
  return { gate, open, fetchMock, pending, lastPending: () => pending[pending.length - 1] ?? [] };
}

const outcome = (callId: string, name: string, overlay: OverlayDecision, args: Record<string, unknown> = {}) => ({
  callId,
  name,
  args,
  overlay,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the model asks; the server decides', () => {
  it('nothing but the crisis card opens on the model call alone', () => {
    const { gate, open } = makeGate();
    for (const name of Object.keys(TOOL_OVERLAYS)) {
      expect(gate.onModelCall(`c_${name}`, name, {})).toBe(true);
    }
    expect(open.mock.calls.map((c) => c[0])).toEqual(['show_resource_card']);
  });

  it('tools with no overlay are left to the caller', () => {
    const { gate, open } = makeGate();
    expect(gate.onModelCall('c1', 'end_session', {})).toBe(false);
    expect(gate.onModelCall('c2', 'find_worksheet', {})).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ['shown', [['administer_scale', { scale: 'phq2' }, {}]]],
    ['hidden', []],
    ['unconfirmed', [['administer_scale', { scale: 'phq2' }, { unconfirmed: true }]]],
  ] as const)('outcome %s', (overlay, opened) => {
    const { gate, open } = makeGate();
    gate.onModelCall('c1', 'administer_scale', { scale: 'phq2' });
    gate.onOutcome(outcome('c1', 'administer_scale', overlay, { scale: 'phq2' }));
    expect(open.mock.calls).toEqual(opened);
  });

  it('a screener the server refused never opens, whatever arrives later', async () => {
    const { gate, open } = makeGate(async (id) => outcome(id, 'administer_scale', 'shown'));
    gate.onModelCall('c1', 'administer_scale', { scale: 'phq2' });
    gate.onOutcome(outcome('c1', 'administer_scale', 'hidden'));
    gate.onModelCall('c1', 'administer_scale', { scale: 'phq2' }); // redelivered notice
    gate.onOutcome(outcome('c1', 'administer_scale', 'shown')); // replayed after a reconnect
    await vi.advanceTimersByTimeAsync(VOICE_OVERLAY_CONFIRM_DEADLINE_MS * 2);
    expect(open).not.toHaveBeenCalled();
  });

  it('an outcome that beats the model call opens once, and the late call does nothing', () => {
    const { gate, open } = makeGate();
    gate.onOutcome(outcome('c1', 'start_thought_record', 'shown'));
    expect(gate.onModelCall('c1', 'start_thought_record', {})).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('the same tool called twice is two calls: each follows its own outcome', () => {
    const { gate, open } = makeGate();
    gate.onModelCall('c1', 'administer_scale', { scale: 'phq2' });
    gate.onModelCall('c2', 'administer_scale', { scale: 'gad2' });
    gate.onOutcome(outcome('c2', 'administer_scale', 'hidden', { scale: 'gad2' }));
    gate.onOutcome(outcome('c1', 'administer_scale', 'shown', { scale: 'phq2' }));
    expect(open.mock.calls).toEqual([['administer_scale', { scale: 'phq2' }, {}]]);
  });

  it('ignores malformed outcomes and outcomes for tools with no overlay', () => {
    const { gate, open } = makeGate();
    gate.onOutcome(undefined);
    gate.onOutcome(null);
    gate.onOutcome({ callId: 1 } as unknown as ToolOverlayOutcome);
    gate.onOutcome(outcome('c9', 'end_session', 'shown'));
    expect(open).not.toHaveBeenCalled();
  });
});

describe('the crisis-resource card', () => {
  it('opens at once on the model call, with no socket, no HTTP and no outcome', () => {
    const { gate, open, fetchMock } = makeGate(async () => {
      throw new Error('offline');
    });
    gate.onModelCall('card', 'show_resource_card', { resource_type: 'all' });
    expect(open).toHaveBeenCalledWith('show_resource_card', { resource_type: 'all' }, {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens on the outcome too when that arrives first (GPT-Live socket faster than the data channel), once', () => {
    const { gate, open } = makeGate();
    gate.onOutcome(outcome('card', 'show_resource_card', 'shown'));
    gate.onModelCall('card', 'show_resource_card', {});
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('is not re-opened by its later outcome (a participant who closed it keeps it closed)', () => {
    const { gate, open } = makeGate();
    gate.onModelCall('card', 'show_resource_card', {});
    gate.onOutcome(outcome('card', 'show_resource_card', 'shown'));
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('when the server message never arrives', () => {
  it('a display-only overlay asks over HTTP at the bound and shows if the server has no answer', async () => {
    const { gate, open, fetchMock } = makeGate();
    gate.onModelCall('b1', 'start_breathing_exercise', { duration_seconds: 60 });
    await vi.advanceTimersByTimeAsync(VOICE_OVERLAY_FALLBACK_MS - 1);
    expect(open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledWith('b1');
    expect(open).toHaveBeenCalledWith('start_breathing_exercise', { duration_seconds: 60 }, {});
  });

  it('a display-only overlay the server reports hidden over HTTP stays hidden', async () => {
    const { gate, open } = makeGate(async (id) => outcome(id, 'start_breathing_exercise', 'hidden'));
    gate.onModelCall('b1', 'start_breathing_exercise', {});
    await vi.advanceTimersByTimeAsync(VOICE_OVERLAY_FALLBACK_MS);
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['administer_scale', 'create_custom_worksheet', 'create_safety_plan'])(
    '%s is never shown without the server confirming it, and the pending state clears at the deadline',
    async (name) => {
      const { gate, open, fetchMock, lastPending } = makeGate();
      gate.onModelCall('x1', name, {});
      expect(lastPending()).toEqual([{ callId: 'x1', name, since: Date.now() }]);
      await vi.advanceTimersByTimeAsync(VOICE_OVERLAY_CONFIRM_DEADLINE_MS + 1);
      expect(open).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(lastPending()).toEqual([]);
    },
  );

  it('a screener confirmed over HTTP after a lost socket message opens (reconnect mid-call)', async () => {
    let known: ToolOverlayOutcome | null = null;
    const { gate, open, lastPending } = makeGate(async () => known);
    gate.onModelCall('s1', 'administer_scale', { scale: 'gad2' });
    await vi.advanceTimersByTimeAsync(VOICE_OVERLAY_FALLBACK_MS);
    expect(open).not.toHaveBeenCalled();
    known = outcome('s1', 'administer_scale', 'shown', { scale: 'gad2' });
    await vi.advanceTimersByTimeAsync(VOICE_OVERLAY_CONFIRM_DEADLINE_MS);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('administer_scale', { scale: 'gad2' }, {});
    expect(lastPending()).toEqual([]);
  });

  it('an outcome on the socket before the bound means no HTTP request at all', async () => {
    const { gate, fetchMock } = makeGate();
    gate.onModelCall('s1', 'administer_scale', {});
    await vi.advanceTimersByTimeAsync(200);
    gate.onOutcome(outcome('s1', 'administer_scale', 'shown'));
    await vi.advanceTimersByTimeAsync(VOICE_OVERLAY_CONFIRM_DEADLINE_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only screeners and saved artefacts show as pending; display-only overlays do not', () => {
    const { gate, lastPending } = makeGate();
    gate.onModelCall('b1', 'start_breathing_exercise', {});
    expect(lastPending()).toEqual([]);
    gate.onModelCall('p1', 'create_safety_plan', {});
    expect(lastPending().map((p) => p.name)).toEqual(['create_safety_plan']);
    gate.onOutcome(outcome('p1', 'create_safety_plan', 'unconfirmed'));
    expect(lastPending()).toEqual([]);
  });

  it('a session end drops every pending overlay and stops asking', async () => {
    const { gate, open, fetchMock, lastPending } = makeGate(async (id) => outcome(id, 'start_thought_record', 'shown'));
    gate.onModelCall('t1', 'start_thought_record', {});
    gate.onModelCall('s1', 'administer_scale', {});
    gate.reset();
    expect(lastPending()).toEqual([]);
    await vi.advanceTimersByTimeAsync(VOICE_OVERLAY_CONFIRM_DEADLINE_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
