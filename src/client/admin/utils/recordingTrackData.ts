// One compact line per recording track for the admin session view
// (ai-therapist-384): the track's length, the silence the server inserted for
// audio lost in transit, and (participant track) the time the mic was muted.
// The full ranges are in the recording sidecar (Track data download).

/** Mirrors TrackSummary in src/server/services/recordingSidecar.ts. */
export interface TrackSummary {
  durationMs: number;
  insertedSilenceMs: number;
  gapCount: number;
  mutedMs: number;
  sequenced: boolean | 'partial';
  complete: boolean | null;
  timelineIntact: boolean;
}

export interface TrackData {
  url: string;
  mixed: TrackSummary | null;
  participant: TrackSummary | null;
  tracksAligned: boolean;
}

/** Mirrors trackDataStatus in the recording-info response (review of #105). */
export type TrackDataStatus = 'stored' | 'failed' | 'predates' | 'unknown';

/**
 * The line shown when a recording has no track data, or null when nothing
 * needs saying (stored, or a recording from before track data existed).
 */
export function trackDataMissingNotice(status: TrackDataStatus | undefined): string | null {
  if (status === 'failed') return 'Track data missing: inserted silence cannot be told from a muted microphone';
  if (status === 'unknown')
    return 'Track data could not be read: inserted silence cannot be told from a muted microphone';
  return null;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** 'ok' when nothing was lost; 'gaps' when silence was inserted or the track is incomplete; 'unknown' for older clients. */
export type TrackDataTone = 'ok' | 'gaps' | 'unknown';

export function describeTrack(t: TrackSummary, opts: { showMuted: boolean }): { text: string; tone: TrackDataTone } {
  const parts = [`${formatClock(t.durationMs)} long`];
  let tone: TrackDataTone;
  if (!t.sequenced) {
    parts.push('lost audio not tracked (older app version)');
    tone = 'unknown';
  } else if (t.sequenced === 'partial') {
    parts.push('app updated mid-session: lost audio only partly tracked, timeline not intact');
    tone = 'gaps';
  } else if (t.gapCount > 0) {
    parts.push(
      `${seconds(t.insertedSilenceMs)} of silence inserted for lost audio in ${t.gapCount} ${t.gapCount === 1 ? 'gap' : 'gaps'}`,
    );
    if (!t.timelineIntact) parts.push('timeline not intact after a capped gap');
    tone = 'gaps';
  } else if (t.complete === false) {
    parts.push('audio incomplete (server write error)');
    tone = 'gaps';
  } else {
    parts.push('complete, no silence inserted');
    tone = 'ok';
  }
  if (opts.showMuted) parts.push(`${seconds(t.mutedMs)} muted`);
  return { text: parts.join(' • '), tone };
}
