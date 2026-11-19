import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SPEAKER_TOGGLES,
  createSpeakerMuteController,
  createSpeakerTimeline,
  elementSink,
  mayBrowserSpeakAtCut,
  speakerMutedAtStart,
  type MutableMediaElement,
  type SpeakerSink,
} from './speakerMute';
import { createPlaybackChain } from './grokVoiceClient';
import { startMixedTee } from './audioTee';

// Monotonic test clock: offsets only, never the real clock.
function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('speaker timeline (speaker_timeline client event)', () => {
  it('starts with one entry at 0 and records each change as [offset ms, 1 audible / 0 muted]', () => {
    const c = clock();
    const tl = createSpeakerTimeline(c.now(), false);
    c.advance(2_000);
    tl.set(true, c.now());
    c.advance(3_000);
    tl.set(false, c.now());
    c.advance(1_000);
    expect(tl.report(c.now())).toEqual({
      toggles: [
        [0, 1],
        [2_000, 0],
        [5_000, 1],
      ],
      truncated: false,
      mutedMs: 3_000,
      totalMs: 6_000,
      crisisSignalsWhileMuted: 0,
    });
  });

  it('ignores a set to the current state', () => {
    const c = clock();
    const tl = createSpeakerTimeline(c.now(), false);
    tl.set(false, c.now());
    c.advance(10);
    tl.set(true, c.now());
    tl.set(true, c.now());
    expect(tl.report(c.now()).toggles).toEqual([
      [0, 1],
      [10, 0],
    ]);
  });

  it('counts an open muted stretch up to the report, and a session that starts muted', () => {
    const c = clock();
    const tl = createSpeakerTimeline(c.now(), true);
    c.advance(4_500);
    const r = tl.report(c.now());
    expect(r.toggles).toEqual([[0, 0]]);
    expect(r.mutedMs).toBe(4_500);
    expect(r.totalMs).toBe(4_500);
  });

  it('caps the toggle list (2 KB detail limit) but keeps counting muted time', () => {
    const c = clock();
    const tl = createSpeakerTimeline(c.now(), false);
    for (let i = 0; i < 200; i++) {
      c.advance(100);
      tl.set(i % 2 === 0, c.now());
    }
    const r = tl.report(c.now());
    expect(r.toggles).toHaveLength(MAX_SPEAKER_TOGGLES);
    expect(r.truncated).toBe(true);
    expect(r.mutedMs).toBe(100 * 100);
    expect(JSON.stringify(r).length).toBeLessThan(2048);
  });

  it('counts crisis signals only while muted', () => {
    const c = clock();
    const tl = createSpeakerTimeline(c.now(), false);
    tl.crisisSignal(c.now());
    tl.set(true, c.now());
    tl.crisisSignal(c.now());
    tl.crisisSignal(c.now());
    expect(tl.report(c.now()).crisisSignalsWhileMuted).toBe(2);
  });

  it('reports numbers only', () => {
    const c = clock();
    const tl = createSpeakerTimeline(c.now(), false);
    c.advance(7);
    tl.set(true, c.now());
    const values = JSON.stringify(tl.report(c.now()))
      .replace(/"[a-zA-Z]+":/g, '')
      .replace(/[[\]{},]/g, ' ')
      .trim()
      .split(/\s+/);
    for (const v of values) expect(v === 'false' || v === 'true' || /^\d+$/.test(v)).toBe(true);
  });
});

describe('reset rules', () => {
  it('every session the participant starts begins unmuted, whatever came before', () => {
    expect(speakerMutedAtStart({ recovery: false, mutedAtCut: false })).toBe(false);
    expect(speakerMutedAtStart({ recovery: false, mutedAtCut: true })).toBe(false);
  });

  it('a recovery voice session after a vendor cut keeps the mute the participant had at the cut', () => {
    expect(speakerMutedAtStart({ recovery: true, mutedAtCut: true })).toBe(true);
    expect(speakerMutedAtStart({ recovery: true, mutedAtCut: false })).toBe(false);
  });
});

describe('crisis rule: nothing unmutes on the participant’s behalf', () => {
  it('a crisis signal is counted and leaves the voice muted', () => {
    const c = clock();
    const sink = { setMuted: vi.fn() };
    const api = createSpeakerMuteController({ onChange: () => {}, now: c.now });
    api.begin(sink, false);
    api.set(true);
    sink.setMuted.mockClear();
    api.crisisSignal();
    expect(api.isMuted()).toBe(true);
    expect(sink.setMuted).not.toHaveBeenCalled();
    expect(api.end()?.crisisSignalsWhileMuted).toBe(1);
  });

  it('the browser speaks its own lines at a cut only when the voice was not muted', () => {
    expect(mayBrowserSpeakAtCut(false)).toBe(true);
    expect(mayBrowserSpeakAtCut(true)).toBe(false);
  });
});

describe('speaker mute controller', () => {
  function setup(startMuted = false) {
    const c = clock();
    const changes: boolean[] = [];
    const sink: SpeakerSink & { calls: boolean[] } = {
      calls: [],
      setMuted(m) {
        this.calls.push(m);
      },
    };
    const api = createSpeakerMuteController({ onChange: (m) => changes.push(m), now: c.now });
    api.begin(sink, startMuted);
    return { c, changes, sink, api };
  }

  it('applies the starting state to the sink and the UI', () => {
    const { sink, changes, api } = setup(true);
    expect(sink.calls).toEqual([true]);
    expect(changes).toEqual([true]);
    expect(api.isMuted()).toBe(true);
  });

  it('toggles the sink, the UI and the timeline together', () => {
    const { c, sink, changes, api } = setup();
    c.advance(1_000);
    api.toggle();
    c.advance(500);
    api.toggle();
    expect(sink.calls).toEqual([false, true, false]);
    expect(changes).toEqual([false, true, false]);
    expect(api.end()?.toggles).toEqual([
      [0, 1],
      [1_000, 0],
      [1_500, 1],
    ]);
  });

  it('end() reports once, resets to unmuted and detaches the sink', () => {
    const { c, sink, changes, api } = setup();
    api.set(true);
    c.advance(2_000);
    const report = api.end();
    expect(report?.mutedMs).toBe(2_000);
    expect(changes.at(-1)).toBe(false);
    expect(api.isMuted()).toBe(false);
    expect(api.end()).toBeNull();
    api.set(true); // a late tap after teardown reaches no playback
    expect(sink.calls).toEqual([false, true]);
  });

  it('wasMuted() still answers for a session whose teardown already ended the timeline', () => {
    const { api } = setup();
    api.set(true);
    api.end();
    expect(api.isMuted()).toBe(false);
    expect(api.wasMuted()).toBe(true);
    api.begin({ setMuted: () => {} }, false);
    expect(api.wasMuted()).toBe(false);
  });

  it('a new session always starts from its own begin(): a muted session does not leak into the next', () => {
    const { api } = setup();
    api.set(true);
    api.end();
    const next = { setMuted: vi.fn() };
    api.begin(next, speakerMutedAtStart({ recovery: false, mutedAtCut: api.wasMuted() }));
    expect(next.setMuted).toHaveBeenCalledWith(false);
    expect(api.isMuted()).toBe(false);
  });

  it('a sink that throws (playback already gone) does not break the toggle', () => {
    const c = clock();
    const api = createSpeakerMuteController({ onChange: () => {}, now: c.now });
    api.begin(
      {
        setMuted: (m) => {
          if (m) throw new Error('gone');
        },
      },
      false,
    );
    expect(() => api.set(true)).not.toThrow();
    expect(api.isMuted()).toBe(true);
  });
});

describe('elementSink (GPT-Live <audio> element)', () => {
  function fakeEl(paused = false): MutableMediaElement & { play: ReturnType<typeof vi.fn> } {
    return { muted: false, paused, srcObject: {}, play: vi.fn(() => Promise.resolve()) };
  }

  it('uses `muted`, never `volume`, and leaves a playing element playing', () => {
    const el = fakeEl();
    const sink = elementSink(el);
    sink.setMuted(true);
    expect(el.muted).toBe(true);
    expect('volume' in el).toBe(false);
    sink.setMuted(false);
    expect(el.muted).toBe(false);
    expect(el.play).not.toHaveBeenCalled();
  });

  it('unmuting a paused element (autoplay refused) tries play() inside the tap', async () => {
    const el = fakeEl(true);
    const refused = vi.fn();
    el.play.mockReturnValueOnce(Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })));
    elementSink(el, refused).setMuted(false);
    expect(el.play).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(refused).toHaveBeenCalledWith('NotAllowedError');
  });

  it('muting never calls play()', () => {
    const el = fakeEl(true);
    elementSink(el).setMuted(true);
    expect(el.play).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The recording keeps the assistant's voice while it is muted.
//
// A minimal Web Audio stand-in: each node knows what it is connected to and,
// for a gain node, its gain. `level(stream)` gives a source's constant
// amplitude; the amplitude reaching a node is the sum over every path of the
// product of the gains on it (a linear graph, which is what these are). The
// REAL startMixedTee and createPlaybackChain run against it, and the tee's
// ScriptProcessor is driven with whatever amplitude reaches it.
// ---------------------------------------------------------------------------

type FakeStream = MediaStream & { level: number };

class FakeNode {
  outs: FakeNode[] = [];
  gain = { value: 1 };
  constructor(
    readonly kind: string,
    readonly level = 0,
  ) {}
  connect(n: FakeNode) {
    this.outs.push(n);
    return n;
  }
  disconnect() {
    this.outs = [];
  }
}

class FakeProcessor extends FakeNode {
  onaudioprocess: ((e: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
}

class FakeCtx {
  static last: FakeCtx | null = null;
  sampleRate = 48_000;
  state = 'running';
  nodes: FakeNode[] = [];
  destination = new FakeNode('destination');
  constructor() {
    FakeCtx.last = this;
  }
  private add<T extends FakeNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  createGain() {
    return this.add(new FakeNode('gain'));
  }
  createMediaStreamSource(stream: FakeStream) {
    return this.add(new FakeNode('source', stream.level));
  }
  createMediaStreamDestination() {
    const node = this.add(new FakeNode('streamdest'));
    return Object.assign(node, { stream: { node } });
  }
  createScriptProcessor() {
    return this.add(new FakeProcessor('processor'));
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  /** Amplitude reaching `target` from every source in this context. */
  amplitudeAt(target: FakeNode, extraSources: FakeNode[] = []): number {
    const walk = (n: FakeNode, acc: number): number =>
      (n === target ? acc : 0) + n.outs.reduce((sum, o) => sum + walk(o, acc * o.gain.value), 0);
    return [...this.nodes.filter((n) => n.kind === 'source'), ...extraSources].reduce(
      (sum, s) => sum + walk(s, s.level * s.gain.value),
      0,
    );
  }
}

/** Drive a tee processor once with the amplitude reaching it; returns the decoded PCM16 peak. */
function runProcessor(ctx: FakeCtx, chunks: string[]): number {
  const processor = ctx.nodes.find((n): n is FakeProcessor => n instanceof FakeProcessor)!;
  const amp = ctx.amplitudeAt(processor);
  processor.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(256).fill(amp) } });
  const bin = atob(chunks.at(-1)!);
  const pcm = new Int16Array(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)).buffer);
  return Math.max(...Array.from(pcm, Math.abs));
}

const stream = (level: number) => {
  const tracks = [{ enabled: true }];
  return { level, getAudioTracks: () => tracks } as unknown as FakeStream;
};

describe('the recording tap still receives the assistant while muted', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubWebAudio() {
    vi.stubGlobal('window', { AudioContext: FakeCtx, addEventListener: () => {}, removeEventListener: () => {} });
  }

  it('GPT-Live: the element is muted, the tee on the remote stream still records the assistant', () => {
    stubWebAudio();
    const remote = stream(0.5); // the assistant
    const mic = stream(0); // a silent participant, so the mix is the assistant alone
    const el = { muted: false, paused: false, srcObject: remote, play: vi.fn(() => Promise.resolve()) };
    const sink = elementSink(el);
    const chunks: string[] = [];
    startMixedTee([mic, remote], (pcm) => chunks.push(pcm));
    const tee = FakeCtx.last!;

    const before = runProcessor(tee, chunks);
    sink.setMuted(true);
    const whileMuted = runProcessor(tee, chunks);

    expect(el.muted).toBe(true);
    expect(before).toBeGreaterThan(0);
    expect(whileMuted).toBe(before);
    // The mute never reached the track or the tee's source.
    expect(remote.getAudioTracks()[0].enabled).toBe(true);
  });

  it('Grok: the output gain silences the speakers; the record stream and the tee still carry the assistant', () => {
    const playCtx = new FakeCtx();
    const speakers = new FakeNode('speakers');
    const chain = createPlaybackChain(playCtx as unknown as AudioContext, speakers as unknown as AudioNode, false);
    const agent = new FakeNode('source', 0.5);
    agent.connect(chain.input as unknown as FakeNode);
    const record = chain.record as unknown as FakeNode;

    expect(playCtx.amplitudeAt(speakers, [agent])).toBeCloseTo(0.5);
    (chain.output as unknown as FakeNode).gain.value = 0; // what setSpeakerMuted(true) does
    expect(playCtx.amplitudeAt(speakers, [agent])).toBe(0);
    expect(playCtx.amplitudeAt(record, [agent])).toBeCloseTo(0.5);

    // The tee reads the record stream: hand it the level the stream carries.
    stubWebAudio();
    const chunks: string[] = [];
    startMixedTee([stream(0), stream(playCtx.amplitudeAt(record, [agent]))], (pcm) => chunks.push(pcm));
    expect(runProcessor(FakeCtx.last!, chunks)).toBeGreaterThan(0);
  });

  it('Grok: a chain built while muted starts silent at the speakers only', () => {
    const playCtx = new FakeCtx();
    const speakers = new FakeNode('speakers');
    const chain = createPlaybackChain(playCtx as unknown as AudioContext, speakers as unknown as AudioNode, true);
    const agent = new FakeNode('source', 0.5);
    agent.connect(chain.input as unknown as FakeNode);
    expect(playCtx.amplitudeAt(speakers, [agent])).toBe(0);
    expect(playCtx.amplitudeAt(chain.record as unknown as FakeNode, [agent])).toBeCloseTo(0.5);
  });
});
