// Pure state machine for the voice orb's listening/speaking label.
//
// The label used to follow the assistant's audio level frame by frame, so
// every pause between words flipped it between "AI is speaking" and
// "Listening..." (reported by a 2026-09-22 stage tester as distracting,
// ai-therapist-247). Speech has gaps of a few hundred milliseconds inside a
// single turn, so the label now (1) enters "speaking" as soon as the level
// crosses the on-threshold, and (2) leaves it only after the level has stayed
// below a lower off-threshold for SPEAKING_HOLD_MS. The orb's visual pulse is
// unaffected: it still tracks the raw level every frame.
export type OrbState = 'idle' | 'listening' | 'speaking';

export const SPEAKING_ON_LEVEL = 0.02;
export const SPEAKING_OFF_LEVEL = 0.01;
export const SPEAKING_HOLD_MS = 450;

export interface OrbTracker {
  state: OrbState;
  /** Timestamp of the last frame whose remote level was above the off-threshold. */
  lastLoudAt: number;
}

export function createOrbTracker(): OrbTracker {
  return { state: 'idle', lastLoudAt: -Infinity };
}

/** Advance the tracker one frame; returns the state to display. */
export function nextOrbState(t: OrbTracker, remoteLevel: number, micEnabled: boolean, now: number): OrbState {
  if (remoteLevel > SPEAKING_OFF_LEVEL) t.lastLoudAt = now;
  const restState: OrbState = micEnabled ? 'listening' : 'idle';
  if (t.state === 'speaking') {
    // Hold through intra-turn pauses; drop only after a sustained silence.
    t.state = now - t.lastLoudAt >= SPEAKING_HOLD_MS ? restState : 'speaking';
  } else {
    t.state = remoteLevel > SPEAKING_ON_LEVEL ? 'speaking' : restState;
  }
  return t.state;
}
