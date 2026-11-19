// Muting the assistant's voice on the participant's own device (the speaker
// button next to the mic button in a voice session; docs/gpt-live.md
// "Muting the assistant's voice").
//
// What mute touches, and what it must never touch:
//  - It silences PLAYBACK only: the <audio> element that plays the GPT-Live
//    remote track (`muted`), or the output gain that sits between the Grok
//    playback chain and the speakers (grokVoiceClient.ts createPlaybackChain).
//  - The session recording taps the assistant's MediaStream itself
//    (audioTee.ts startMixedTee), upstream of both, so the mix keeps the
//    assistant's voice while the participant has it muted. The remote track is
//    never disabled and the tee's source is never touched.
//  - Nothing is sent to the model or the server about it, apart from the
//    numbers-only `speaker_timeline` client event at the end of the session.
//
// Crisis rule (decided in this PR, see docs/gpt-live.md): a crisis signal does
// NOT unmute. A participant who muted may have done so because someone came
// into the room, and saying crisis content out loud then could expose them.
// Instead the crisis resource card carries a pinned "Tap to hear the
// assistant" button, and the browser's own spoken lines at a vendor cut are
// skipped when the participant had the voice muted. The card, the numbers and
// the hand-off appear exactly as they do unmuted.
//
// Everything here is pure or works on a minimal interface, so it is unit
// tested without a browser (speakerMute.test.ts); the real audio paths are
// checked in headless Chromium by scripts/speaker-mute-check.ts.

/** Toggles kept for the speaker_timeline report (client event detail is capped at 2 KB). */
export const MAX_SPEAKER_TOGGLES = 60;

export interface SpeakerTimelineReport {
  /** [ms since the session's audio started; 1 = audible, 0 = muted], first entry at 0. */
  toggles: Array<[number, 0 | 1]>;
  truncated: boolean;
  mutedMs: number;
  totalMs: number;
  /** Crisis signals (resource card from the server, crisis message) that arrived while muted. */
  crisisSignalsWhileMuted: number;
}

export interface SpeakerTimeline {
  /** Record the state at `now` (a no-op when it does not change). */
  set: (muted: boolean, now: number) => void;
  /** A crisis signal arrived at `now`; counted only while muted. */
  crisisSignal: (now: number) => void;
  isMuted: () => boolean;
  /** Numbers only. Closes the open stretch at `now`. */
  report: (now: number) => SpeakerTimelineReport;
}

/**
 * The participant's mute/unmute history for one voice session, timed on a
 * monotonic clock the caller passes in (performance.now in the app), so a
 * wall-clock change cannot produce negative or inflated stretches.
 */
export function createSpeakerTimeline(startedAt: number, startMuted: boolean): SpeakerTimeline {
  const toggles: Array<[number, 0 | 1]> = [[0, startMuted ? 0 : 1]];
  let truncated = false;
  let muted = startMuted;
  let mutedSince = startMuted ? startedAt : null;
  let mutedMs = 0;
  let crisisSignalsWhileMuted = 0;
  const offset = (now: number) => Math.max(0, Math.round(now - startedAt));

  return {
    set(next, now) {
      if (next === muted) return;
      muted = next;
      if (next) {
        mutedSince = now;
      } else if (mutedSince !== null) {
        mutedMs += Math.max(0, now - mutedSince);
        mutedSince = null;
      }
      if (toggles.length < MAX_SPEAKER_TOGGLES) toggles.push([offset(now), next ? 0 : 1]);
      else truncated = true;
    },
    crisisSignal() {
      if (muted) crisisSignalsWhileMuted += 1;
    },
    isMuted: () => muted,
    report(now) {
      const open = mutedSince !== null ? Math.max(0, now - mutedSince) : 0;
      return {
        toggles: toggles.map(([t, s]) => [t, s] as [number, 0 | 1]),
        truncated,
        mutedMs: Math.round(mutedMs + open),
        totalMs: offset(now),
        crisisSignalsWhileMuted,
      };
    },
  };
}

/**
 * Whether a voice session starts muted.
 *
 * Every session the participant starts (a new one, or a return to voice from
 * a text hand-off chat) starts unmuted. The one exception is a recovery voice
 * session after a vendor cut, which continues the same conversation without
 * the participant touching anything: if they had the voice muted at the cut,
 * it stays muted, for the same reason a crisis signal does not unmute it.
 */
export function speakerMutedAtStart(opts: { recovery: boolean; mutedAtCut: boolean }): boolean {
  return opts.recovery && opts.mutedAtCut;
}

/**
 * Whether the browser may speak one of its own lines at a vendor cut (the
 * recovery line, the hand-off bridge, the "could not continue" line;
 * lib/crisisRecovery.ts startInterimSpeech). Not when the participant had the
 * assistant's voice muted: same rule as the crisis card. The screens those
 * lines accompany are unchanged and stand on their own.
 */
export function mayBrowserSpeakAtCut(mutedAtCut: boolean): boolean {
  return !mutedAtCut;
}

export interface SpeakerMuteApi {
  /** Read by handlers registered in an earlier render (socket, vendor cut). */
  isMuted: () => boolean;
  /**
   * Muted now, or, once `end` has run, whether it was muted when the session's
   * audio ended. The vendor-cut path reads this: the cut may land after a
   * teardown already in flight has ended the timeline.
   */
  wasMuted: () => boolean;
  /** A voice session's playback exists: attach it and apply the starting state. */
  begin: (sink: SpeakerSink, startMuted: boolean) => void;
  set: (muted: boolean) => void;
  toggle: () => void;
  /** A crisis signal arrived (counted for the study while muted; never unmutes). */
  crisisSignal: () => void;
  /**
   * The session's audio is going away: detach, reset to unmuted, and return
   * the timeline once (null when there is no session or it was already ended).
   */
  end: () => SpeakerTimelineReport | null;
}

/**
 * The mute state of the current voice session, its playback sink and its
 * timeline, behind one object whose methods never change (socket handlers
 * registered in an earlier render call them). `onChange` drives the UI.
 */
export function createSpeakerMuteController(opts: {
  onChange: (muted: boolean) => void;
  now: () => number;
}): SpeakerMuteApi {
  let sink: SpeakerSink | null = null;
  let timeline: SpeakerTimeline | null = null;
  let muted = false;
  let mutedAtEnd = false;
  const apply = (next: boolean) => {
    muted = next;
    opts.onChange(next);
    try {
      sink?.setMuted(next);
    } catch {
      /* playback already torn down */
    }
    timeline?.set(next, opts.now());
  };
  return {
    isMuted: () => muted,
    wasMuted: () => (timeline ? muted : mutedAtEnd),
    begin(nextSink, startMuted) {
      mutedAtEnd = false;
      sink = nextSink;
      timeline = createSpeakerTimeline(opts.now(), startMuted);
      muted = startMuted;
      opts.onChange(startMuted);
      nextSink.setMuted(startMuted);
    },
    set: apply,
    toggle: () => apply(!muted),
    crisisSignal: () => timeline?.crisisSignal(opts.now()),
    end() {
      const ended = timeline;
      if (ended) mutedAtEnd = muted;
      timeline = null;
      sink = null;
      muted = false;
      opts.onChange(false);
      return ended ? ended.report(opts.now()) : null;
    },
  };
}

/** Whatever plays the assistant's voice: muted without stopping it. */
export interface SpeakerSink {
  setMuted: (muted: boolean) => void;
}

/** The parts of an HTMLMediaElement mute needs (so it can be tested in node). */
export interface MutableMediaElement {
  muted: boolean;
  paused: boolean;
  srcObject: unknown;
  play: () => Promise<void>;
}

/**
 * GPT-Live: mute the <audio> element that plays the remote WebRTC track.
 *
 * `muted` rather than `volume` because iOS Safari ignores `volume` on media
 * elements; `muted` works there and everywhere else. The element keeps
 * playing, so unmuting needs no new play() and no new user gesture. If the
 * element was paused anyway (the browser refused autoplay and the retry has
 * not landed yet), unmuting is a tap, so it also tries play() inside it.
 */
export function elementSink(el: MutableMediaElement, onPlayRefused?: (name: string) => void): SpeakerSink {
  return {
    setMuted(muted) {
      el.muted = muted;
      if (!muted && el.paused && el.srcObject) {
        el.play().catch((err: unknown) => {
          const name = err instanceof Error ? err.name : String(err);
          if (name !== 'AbortError') onPlayRefused?.(name);
        });
      }
    },
  };
}
