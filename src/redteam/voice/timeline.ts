// One continuously advancing timeline for a GPT-Live red-team run.
//
// Method from OpenAI's "GPT-Live evaluation guide" (cookbook
// examples/audio/voice_agent_evaluation, reference harness
// examples/audio/duplex_voice_agent_evaluation): GPT-Live is full duplex, so
// the evaluation must align audio and events on one clock instead of assuming
// clean alternating turns, and infer turns afterwards. This module is that
// clock for our TypeScript harness. The guide's Python harness was read, not
// vendored; nothing here is copied from it.
//
// Sources, all on the harness's wall clock (ms since the epoch):
// - caller audio: every 20 ms frame the headless participant writes to the
//   WebRTC track (speech and the silence the pump sends between utterances);
// - assistant audio: every decoded Opus frame received from the assistant,
//   stamped on arrival (WebRTC carries no playback timestamps, so arrival is
//   the participant's playback time, give or take the jitter buffer);
// - data-channel events: delegations, backend responses, tool calls,
//   content_filter errors, session.closed, session.usage.updated.
//
// Speech segments come from a frame-energy detector (below), so a caller turn
// ends at the end of AUDIBLE speech, not at the end of the trailing silence
// the harness pads each utterance with.
//
// Pure apart from Date.now() defaults; unit-tested in timeline.test.ts.

export const FRAME_MS = 20;

/** RMS (16-bit PCM units) above which a frame counts as speech. About -42
 *  dBFS: TTS and GPT-Live speech sit well above it, digital silence and Opus
 *  comfort noise well below. Noise-mixed WALK audio is labelled from the CLEAN
 *  source frame (see SegmentTracker.push's `speechHint`). */
export const SPEECH_RMS_THRESHOLD = 260;
/** Gaps shorter than this inside speech do not split a segment (word gaps,
 *  plosive closures). */
export const MERGE_GAP_MS = 350;
/** Segments shorter than this are dropped as clicks. */
export const MIN_SEGMENT_MS = 80;

export function frameRms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export interface Segment {
  start: number;
  end: number;
}

/** Online speech-segment builder over timestamped frames. */
export class SegmentTracker {
  readonly segments: Segment[] = [];
  private open: Segment | null = null;

  constructor(
    private readonly mergeGapMs = MERGE_GAP_MS,
    private readonly minSegmentMs = MIN_SEGMENT_MS,
  ) {}

  /** One frame at time `t` (its START) lasting `durMs`. `speechHint` overrides
   *  the energy test (used when the harness knows the frame's clean source). */
  push(t: number, pcm: Buffer | null, durMs = FRAME_MS, speechHint?: boolean): void {
    const speech = speechHint ?? (pcm ? frameRms(pcm) >= SPEECH_RMS_THRESHOLD : false);
    if (!speech) return;
    const end = t + durMs;
    if (this.open && t - this.open.end <= this.mergeGapMs) {
      this.open.end = Math.max(this.open.end, end);
      return;
    }
    this.flushOpen();
    this.open = { start: t, end };
  }

  private flushOpen(): void {
    if (this.open && this.open.end - this.open.start >= this.minSegmentMs) this.segments.push(this.open);
    this.open = null;
  }

  /** Segments so far, including the one still open. */
  all(): Segment[] {
    const out = [...this.segments];
    if (this.open && this.open.end - this.open.start >= this.minSegmentMs) out.push({ ...this.open });
    return out;
  }
}

export type TimelineEventKind =
  | 'session_started'
  | 'delegation_created'
  | 'backend_response_created'
  | 'backend_response_done'
  | 'tool_call'
  | 'content_filter'
  | 'session_closed'
  | 'usage'
  | 'assistant_transcript'
  | 'caller_transcript'
  | 'caller_turn_start'
  | 'caller_turn_end'
  | 'note';

export interface TimelineEvent {
  t: number;
  kind: TimelineEventKind;
  /** Therapy session (GPT-Live session) the event belongs to. */
  sessionId: string;
  delegationId?: string;
  /** Tool name, close reason, transcript text, beat id, note text. */
  detail?: string;
  /** usage.seconds for `usage`. */
  value?: number;
}

/** A spoken caller turn as the harness scheduled it. */
export interface CallerTurn {
  beatId: string;
  sessionId: string;
  /** First frame of the utterance handed to the track. */
  queuedAt: number;
  /** Last frame of the utterance (padding included) handed to the track. */
  playedOutAt: number;
}

/**
 * The run's shared timeline. One instance spans every GPT-Live session the
 * conversation used (the original and any recovery segment), so the gap
 * between a vendor cut and the recovery's first audio is measured on one
 * clock.
 */
export class Timeline {
  readonly t0: number;
  readonly events: TimelineEvent[] = [];
  readonly callerTurns: CallerTurn[] = [];
  /** Per role, per session: speech segments. */
  private readonly trackers = new Map<string, SegmentTracker>();

  constructor(t0 = Date.now()) {
    this.t0 = t0;
  }

  private tracker(role: 'caller' | 'assistant', sessionId: string): SegmentTracker {
    const key = `${role}:${sessionId}`;
    let tr = this.trackers.get(key);
    if (!tr) {
      tr = new SegmentTracker();
      this.trackers.set(key, tr);
    }
    return tr;
  }

  callerFrame(sessionId: string, t: number, pcm: Buffer, speechHint?: boolean): void {
    this.tracker('caller', sessionId).push(t, pcm, FRAME_MS, speechHint);
  }

  /** A decoded assistant frame; its duration comes from the sample count. */
  assistantFrame(sessionId: string, t: number, pcm: Buffer, sampleRate = 24_000): void {
    const durMs = ((pcm.length / 2) * 1000) / sampleRate;
    // Stamp the frame at its arrival minus its own length: arrival is when its
    // last sample is available to play.
    this.tracker('assistant', sessionId).push(t - durMs, pcm, durMs);
  }

  event(e: Omit<TimelineEvent, 't'> & { t?: number }): void {
    this.events.push({ t: e.t ?? Date.now(), ...e } as TimelineEvent);
  }

  callerTurn(turn: CallerTurn): void {
    this.callerTurns.push(turn);
  }

  segments(role: 'caller' | 'assistant', sessionId?: string): Segment[] {
    const out: Segment[] = [];
    for (const [key, tr] of this.trackers) {
      const [r, sid] = key.split(/:(.*)/s);
      if (r !== role) continue;
      if (sessionId && sid !== sessionId) continue;
      out.push(...tr.all());
    }
    return out.sort((a, b) => a.start - b.start);
  }

  sessions(): string[] {
    const ids = new Set<string>();
    for (const e of this.events) ids.add(e.sessionId);
    for (const t of this.callerTurns) ids.add(t.sessionId);
    return [...ids];
  }

  /** Compact JSON for summary.json / a run artifact (relative ms). */
  toJSON(): Record<string, unknown> {
    const rel = (t: number) => t - this.t0;
    return {
      t0: new Date(this.t0).toISOString(),
      callerSegments: this.segments('caller').map((s) => [rel(s.start), rel(s.end)]),
      assistantSegments: this.segments('assistant').map((s) => [rel(s.start), rel(s.end)]),
      callerTurns: this.callerTurns.map((c) => ({ ...c, queuedAt: rel(c.queuedAt), playedOutAt: rel(c.playedOutAt) })),
      events: this.events
        .filter((e) => e.kind !== 'assistant_transcript' && e.kind !== 'caller_transcript')
        .map((e) => ({ ...e, t: rel(e.t) })),
    };
  }
}
