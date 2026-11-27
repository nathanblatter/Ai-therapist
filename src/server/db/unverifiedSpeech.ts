// The mark on a participant voice message nobody spoke (ai-therapist-412).
// No imports, so any query module can use it.

/**
 * Metadata key set on a participant voice message the app has positive
 * evidence nobody spoke (ai-therapist-412: the voice vendor transcribed a
 * muted microphone). The row and its text are kept; the mark is what the
 * crisis context, the exports and the staff transcript views read.
 */
export const UNVERIFIED_SPEECH_KEY = 'unverified_speech';

/**
 * Metadata keys only the server may write: the mark, its reason and the
 * microphone evidence. A browser-supplied metadata blob is stripped of them
 * (stripServerOnlySpeechKeys), so a client can neither mark its own message
 * unverified (which would take it out of the crisis context) nor put text
 * under a key the redacted views let through.
 */
export const SERVER_ONLY_SPEECH_KEYS: readonly string[] = [
  UNVERIFIED_SPEECH_KEY,
  'unverified_speech_reason',
  'mic_audio',
];

/** A copy of client-supplied metadata without the server-only speech keys; other values pass through. */
export function stripServerOnlySpeechKeys<T>(metadata: T): T {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const copy: Record<string, unknown> = { ...(metadata as Record<string, unknown>) };
  for (const key of SERVER_ONLY_SPEECH_KEYS) delete copy[key];
  return copy as T;
}

const MIC_AUDIO_NUMBER_KEYS = ['received_ms', 'muted_ms', 'unmuted_ms', 'unmuted_rms_dbfs'];
const MIC_AUDIO_STATES = new Set(['muted']);

/**
 * The microphone evidence as the redacted views may show it: the known
 * numeric fields and the fixed state, nothing else. Null when none remain.
 */
export function safeMicAudio(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of MIC_AUDIO_NUMBER_KEYS) {
    const v = source[key];
    if (v === null || (typeof v === 'number' && Number.isFinite(v))) safe[key] = v;
  }
  if (typeof source.state === 'string' && MIC_AUDIO_STATES.has(source.state)) safe.state = source.state;
  return Object.keys(safe).length > 0 ? safe : null;
}

/** SQL predicate: the message (alias optional) is NOT marked unverified speech. */
export function notUnverifiedSpeechSql(alias = ''): string {
  const q = alias ? `${alias}.` : '';
  return `COALESCE(${q}metadata->>'${UNVERIFIED_SPEECH_KEY}', '') <> 'true'`;
}
