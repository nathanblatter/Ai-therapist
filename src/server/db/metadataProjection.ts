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
    if (SAFE_KEY_SET.has(key)) safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

/**
 * Apply {@link projectSafeMetadata} to one field of every row (the export and
 * admin-transcript queries alias metadata to `extras`).
 */
export function projectRowsMetadata<T extends Record<string, unknown>>(
  rows: T[],
  field = 'extras'
): T[] {
  return rows.map(row =>
    field in row ? { ...row, [field]: projectSafeMetadata(row[field]) } : row
  );
}
