import { describe, it, expect } from 'vitest';
import { describeTrack, formatClock, trackDataMissingNotice, type TrackSummary } from './recordingTrackData';

const base: TrackSummary = {
  durationMs: 140_000,
  insertedSilenceMs: 0,
  gapCount: 0,
  mutedMs: 30_000,
  sequenced: true,
  complete: true,
  timelineIntact: true,
};

describe('recording track line in the admin session view (ai-therapist-384)', () => {
  it('formats the length as m:ss', () => {
    expect(formatClock(140_000)).toBe('2:20');
    expect(formatClock(4_400)).toBe('0:04');
  });

  it('a complete participant track: length, no silence inserted, muted time', () => {
    expect(describeTrack(base, { showMuted: true })).toEqual({
      text: '2:20 long • complete, no silence inserted • 30.0 s muted',
      tone: 'ok',
    });
  });

  it('a track with gaps names the inserted silence and the number of gaps; the mix shows no muted time', () => {
    const t = { ...base, insertedSilenceMs: 1_200, gapCount: 2, complete: false };
    expect(describeTrack(t, { showMuted: false })).toEqual({
      text: '2:20 long • 1.2 s of silence inserted for lost audio in 2 gaps',
      tone: 'gaps',
    });
    expect(describeTrack({ ...t, gapCount: 1 }, { showMuted: false }).text).toContain('in 1 gap');
    expect(describeTrack({ ...t, timelineIntact: false }, { showMuted: false }).text).toContain(
      'timeline not intact after a capped gap',
    );
  });

  it('an older client: lost audio not tracked', () => {
    const t = { ...base, sequenced: false, complete: null, timelineIntact: false };
    expect(describeTrack(t, { showMuted: true })).toEqual({
      text: '2:20 long • lost audio not tracked (older app version) • 30.0 s muted',
      tone: 'unknown',
    });
  });

  it('a track whose app was updated mid-session is not shown as intact (review of #105)', () => {
    const t = { ...base, sequenced: 'partial' as const, complete: null, timelineIntact: false };
    expect(describeTrack(t, { showMuted: false })).toEqual({
      text: '2:20 long • app updated mid-session: lost audio only partly tracked, timeline not intact',
      tone: 'gaps',
    });
  });

  it('says when track data failed to store, and nothing for a recording from before it existed (review of #105)', () => {
    expect(trackDataMissingNotice('failed')).toBe(
      'Track data missing: inserted silence cannot be told from a muted microphone',
    );
    expect(trackDataMissingNotice('unknown')).toBe(
      'Track data could not be read: inserted silence cannot be told from a muted microphone',
    );
    expect(trackDataMissingNotice('predates')).toBeNull();
    expect(trackDataMissingNotice('stored')).toBeNull();
    expect(trackDataMissingNotice(undefined)).toBeNull();
  });
});
