// Voice tool overlays open on the server's outcome, not on the model's request
// (shared/toolOverlayPolicy.ts). One gate for both voice backends:
//
//   GPT-Live  the model's call arrives on the WebRTC data channel
//             (response.output_item.done); the outcome on the session socket
//             (`session:tool-outcome`).
//   Grok      the call arrives as the proxy's `tool_call` notice; the outcome
//             as its `tool_outcome` message, and on the session socket too.
//
// Either may arrive first, and either may be lost:
//   - the crisis-resource card opens on the model's call, at once, whatever
//     happens next. It never waits for anything.
//   - any other overlay waits. If no outcome has arrived after
//     VOICE_OVERLAY_FALLBACK_MS the gate asks the server over HTTP. A
//     display-only overlay (breathing, grounding, thought record...) is then
//     shown anyway if the server has no answer yet; a screener, a worksheet or
//     a safety plan is NOT shown without the server's confirmation: the gate
//     keeps asking until VOICE_OVERLAY_CONFIRM_DEADLINE_MS and then drops it.
//   - every call id is settled once. A repeated notice, an outcome replayed
//     after a reconnect, or an outcome for a card already open does nothing.
//
// The browser sends nothing on the data channel here (PR #20's lock: only
// session.close goes that way); the HTTP read is an ordinary owner-gated GET.

import { TOOL_OVERLAYS, VOICE_OVERLAY_POLL_AT_MS, type ToolOverlayOutcome } from '../../../shared/toolOverlayPolicy';

export interface PendingOverlay {
  callId: string;
  name: string;
  since: number;
}

export interface VoiceOverlayGateDeps {
  /** Open the overlay (the App's per-tool fns). */
  open: (name: string, args: Record<string, unknown>, opts: { unconfirmed?: boolean }) => void;
  /** Ask the server for one call's outcome; null when it has none yet. */
  fetchOutcome: (callId: string) => Promise<ToolOverlayOutcome | null>;
  /** The overlays still waiting for the server's word (drives the pending notice). */
  onPendingChange?: (pending: PendingOverlay[]) => void;
  now?: () => number;
}

interface PendingEntry extends PendingOverlay {
  args: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout> | null;
  poll: number;
}

export class VoiceOverlayGate {
  private settled = new Set<string>();
  private pending = new Map<string, PendingEntry>();
  private generation = 0;

  constructor(private readonly deps: VoiceOverlayGateDeps) {}

  /** Is this a tool the gate handles (one with an overlay)? */
  static handles(name: string): boolean {
    return TOOL_OVERLAYS[name] !== undefined;
  }

  /**
   * The model called a tool (data channel, or the Grok proxy's notice).
   * Returns false for a tool with no overlay: the caller handles it as before.
   */
  onModelCall(callId: string, name: string, args: Record<string, unknown>): boolean {
    const spec = TOOL_OVERLAYS[name];
    if (!spec) return false;
    if (this.settled.has(callId) || this.pending.has(callId)) return true;
    if (spec.withoutOutcome === 'show_now') {
      // The crisis-resource card: shown now, never conditional on anything.
      this.settled.add(callId);
      this.safeOpen(name, args, {});
      return true;
    }
    const entry: PendingEntry = { callId, name, args, since: this.now(), timer: null, poll: 0 };
    this.pending.set(callId, entry);
    this.schedulePoll(entry);
    this.emitPending();
    return true;
  }

  /** The server's outcome for one call (socket, Grok socket or HTTP). */
  onOutcome(event: ToolOverlayOutcome | null | undefined): void {
    if (!event || typeof event.callId !== 'string' || typeof event.name !== 'string') return;
    if (this.settled.has(event.callId)) return;
    this.settled.add(event.callId);
    const entry = this.pending.get(event.callId);
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(event.callId);
      this.emitPending();
    }
    if (!TOOL_OVERLAYS[event.name]) return;
    const args = event.args && typeof event.args === 'object' ? event.args : (entry?.args ?? {});
    if (event.overlay === 'shown') this.safeOpen(event.name, args, {});
    else if (event.overlay === 'unconfirmed') this.safeOpen(event.name, args, { unconfirmed: true });
  }

  /** Session over: forget everything and stop every timer. */
  reset(): void {
    this.generation += 1;
    for (const entry of this.pending.values()) if (entry.timer) clearTimeout(entry.timer);
    this.pending.clear();
    this.settled.clear();
    this.emitPending();
  }

  private schedulePoll(entry: PendingEntry): void {
    const at = VOICE_OVERLAY_POLL_AT_MS[entry.poll];
    const delay = Math.max(0, entry.since + at - this.now());
    const generation = this.generation;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.poll(entry, generation);
    }, delay);
  }

  private async poll(entry: PendingEntry, generation: number): Promise<void> {
    if (generation !== this.generation || this.pending.get(entry.callId) !== entry) return;
    let outcome: ToolOverlayOutcome | null = null;
    try {
      outcome = await this.deps.fetchOutcome(entry.callId);
    } catch {
      outcome = null;
    }
    if (generation !== this.generation || this.pending.get(entry.callId) !== entry) return;
    if (outcome && outcome.callId === entry.callId) {
      this.onOutcome(outcome);
      return;
    }
    const spec = TOOL_OVERLAYS[entry.name];
    if (spec?.withoutOutcome === 'show_after_bound') {
      // Display-only: a lost message must not swallow a breathing exercise.
      this.pending.delete(entry.callId);
      this.settled.add(entry.callId);
      this.emitPending();
      this.safeOpen(entry.name, entry.args, {});
      return;
    }
    entry.poll += 1;
    if (entry.poll >= VOICE_OVERLAY_POLL_AT_MS.length) {
      // A screener or a saved artefact the server never confirmed: not shown.
      // A late outcome can still open it (settled stays unset).
      this.pending.delete(entry.callId);
      this.emitPending();
      console.warn(`[VoiceOverlay] No outcome for ${entry.name} (${entry.callId}); not shown.`);
      return;
    }
    this.schedulePoll(entry);
  }

  private safeOpen(name: string, args: Record<string, unknown>, opts: { unconfirmed?: boolean }): void {
    try {
      this.deps.open(name, args, opts);
    } catch (err) {
      console.error(`[VoiceOverlay] Failed to open ${name}:`, err);
    }
  }

  private emitPending(): void {
    this.deps.onPendingChange?.(
      [...this.pending.values()]
        .filter((e) => TOOL_OVERLAYS[e.name]?.withoutOutcome === 'never')
        .map(({ callId, name, since }) => ({ callId, name, since })),
    );
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
