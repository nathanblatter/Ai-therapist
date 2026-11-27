import { safeMicAudio } from './unverifiedSpeech.js';

// messages.metadata projection for redacted (non-owner) read paths.
//
// Why this exists (ai-therapist-217): the export and admin-transcript queries
// deliberately serve `content_redacted` to roles that may not see raw
// participant text — and then selected `m.metadata as extras` right next to
// it. messages.metadata carries verbatim participant free text: tool-call
// `arguments` (thought-record fields, scale free text, journal entries), tool
// `response` payloads, admin-injected `text`, and the client-supplied `extras`
// blob accepted wholesale by POST /logs/batch. That bypassed the redaction.
//
// The fix is an allowlist (default deny): only keys that are structurally
// telemetry — identifiers, enums, timings, flags — survive into a redacted
// row. Anything not enumerated here is dropped, so a new metadata writer
// cannot silently widen the exposure; it has to come here first.
//
// Inventory of current writers (grep `insertMessagesBatch` / `insertMessage` /
// `logSidebandAction` / `updateMessage`):
//   toolExecution.helpers, sidebandManager, grokVoiceManager  -> tool_name,
//     call_id, delegation_id, channel, status, item_id, start_ms, end_ms,
//     plus PHI-bearing `arguments`, `response`, `error`
//   toolRegistry (flag_notable_moment)                        -> category
//     (fixed enum), plus PHI-bearing `reason`
//   index.ts admin intervention                               -> message_type,
//     delivered_via, sent_at, plus staff `admin_username`
//   sideband.routes via logSidebandAction                     -> action,
//     role, respond, out_of_band, plus staff `admin_user`, `fields`, and
//     PHI-bearing `text` / `args`
//   messages.queries updateMessage                            -> edited,
//     edited_at, plus staff `edited_by`
//   messages.queries markMessageUnverifiedSpeech              -> unverified_speech,
//     unverified_speech_reason, mic_audio (numbers and a fixed state)
//   logs.routes POST /logs/batch                              -> arbitrary
//     client-supplied `extras` (the reason this is an allowlist, not a
//     blocklist)
//
// Staff identities (admin_username, admin_user, edited_by) are intentionally
// NOT allowlisted: these rows are the de-identified/anonymized research views,
// which replace identities with research ids.

/** Keys that may appear in metadata served alongside `content_redacted`. */
export const SAFE_MESSAGE_METADATA_KEYS: readonly string[] = [
  // Tool-call telemetry: which tool, which call, which delegation, outcome.
  'tool_name',
  'call_id',
  'delegation_id',
  'status',
  // Transport / backend channel ('chat' | 'live' | 'grok' | 'realtime').
  'channel',
  // Provenance enums for non-tool system rows.
  'source',
  'action',
  'message_type',
  'delivered_via',
  'role',
  // flag_notable_moment's fixed enum (its free-text `reason` is excluded).
  'category',
  // Realtime turn identifiers and timings.
  'item_id',
  'start_ms',
  'end_ms',
  // Booleans and timestamps.
  'respond',
  'out_of_band',
  'edited',
  'edited_at',
  'sent_at',
  // Unverified speech (ai-therapist-412): the flag and fixed-enum reason on a
  // voice transcript the vendor produced from a muted microphone, and the
  // microphone evidence beside every voice turn (durations, a level and a
  // fixed state; numbers and enums only, written by the server). Redacted
  // readers need the flag to leave such a row out of an analysis.
  'unverified_speech',
  'unverified_speech_reason',
  'mic_audio',
];

const SAFE_KEY_SET = new Set(SAFE_MESSAGE_METADATA_KEYS);

/**
 * Project a message's metadata down to the telemetry-safe allowlist.
 * Returns null when the input is absent or projects to nothing, so redacted
 * rows never carry an empty-object artifact where they used to carry data.
 */
export function projectSafeMetadata(metadata: unknown): Record<string, unknown> | null {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return null;

  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (!SAFE_KEY_SET.has(key)) continue;
    // The speech keys are shaped, not passed through: a flag, a fixed reason,
    // and numbers (ai-therapist-412).
    if (key === 'unverified_speech') {
      if (value === true) safe[key] = true;
    } else if (key === 'unverified_speech_reason') {
      if (value === 'mic_muted') safe[key] = value;
    } else if (key === 'mic_audio') {
      const mic = safeMicAudio(value);
      if (mic) safe[key] = mic;
    } else safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

/**
 * Apply {@link projectSafeMetadata} to one field of every row (the export and
 * admin-transcript queries alias metadata to `extras`).
 */
export function projectRowsMetadata<T extends Record<string, unknown>>(rows: T[], field = 'extras'): T[] {
  return rows.map((row) => (field in row ? { ...row, [field]: projectSafeMetadata(row[field]) } : row));
}
