import { describe, it, expect } from 'vitest';
import {
  buildSidecar,
  excludedRanges,
  recordingSidecarKey,
  summarizeTrack,
  type TrackSidecar,
} from './recordingSidecar.js';

function track(over: Partial<TrackSidecar> = {}): TrackSidecar {
  return {
    object: 'participant.wav',
    sampleRate: 48000,
    totalSamples: 48000 * 10,
    sequenced: true,
    chunkSamples: 4096,
    chunksReceived: 100,
    chunksStale: 0,
    chunksMissing: 0,
    clientChunksPushed: 100,
    insertedSilenceSamples: 0,
    gapCount: 0,
    gaps: [],
    gapsTruncated: false,
    muted: [],
    mutedSamples: 0,
    mutedTruncated: false,
    timelineIntact: true,
    complete: true,
    ...over,
  };
}

describe('recording sidecar (ai-therapist-384)', () => {
  it('lives next to the WAVs', () => {
    expect(recordingSidecarKey('live_abc')).toBe('sessions/live_abc/recording-tracks.json');
  });

  it('merges gaps and muted stretches into sorted, non-overlapping exclusions', () => {
    const t = track({
      gaps: [
        { start: 500, length: 100, chunks: 1, reason: 'sequence_gap' },
        { start: 0, length: 50, chunks: 1, reason: 'sequence_gap' },
      ],
      muted: [
        { start: 50, length: 20 },
        { start: 550, length: 200 },
        { start: 900, length: 0 },
      ],
    });
    expect(excludedRanges(t)).toEqual([
      { start: 0, length: 70 },
      { start: 500, length: 250 },
    ]);
  });

  it('calls two tracks aligned only when both timelines are intact with the same rate and chunk size', () => {
    expect(buildSidecar({ mixed: track({ object: 'recording.wav' }), participant: track() }).tracksAligned).toBe(true);
    expect(buildSidecar({ participant: track() }).tracksAligned).toBe(false);
    expect(buildSidecar({ mixed: track(), participant: track({ timelineIntact: false }) }).tracksAligned).toBe(false);
    expect(buildSidecar({ mixed: track(), participant: track({ sampleRate: 24000 }) }).tracksAligned).toBe(false);
  });

  it('summarises a track in milliseconds for the admin view', () => {
    expect(
      summarizeTrack(track({ insertedSilenceSamples: 24000, gapCount: 3, mutedSamples: 96000, complete: false })),
    ).toEqual({
      durationMs: 10_000,
      insertedSilenceMs: 500,
      gapCount: 3,
      mutedMs: 2000,
      sequenced: true,
      complete: false,
      timelineIntact: true,
    });
  });
});
