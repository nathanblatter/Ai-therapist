// Summary-tier ALLOWLIST projections for crisis/risk/insights payloads
// (caseworker portal, docs/caseworker-portal.md section 3; ai-therapist-146).
//
// Caseworkers get the 'summary' data tier (dataTierFor): scores, severities,
// timestamps, and actors pass through; free-text / matched-snippet columns
// that can quote verbatim participant messages must never reach them.
//
// This module used to DENY-list the sensitive fields (scrubRows + delete),
// which meant any column added to these SELECT *-shaped queries later flowed
// straight through to caseworkers unless someone remembered to extend the
// list — exactly how /flagged drifted into leaking (ai-therapist-143). It now
// ALLOW-lists what a summary-tier viewer may see: a new column is invisible
// to caseworkers until it is deliberately added here.
//
// Keep each list in sync with what the caseworker client actually renders
// (CrisisManagement.tsx, RiskTimeline.tsx, FlaggedMessageRow.tsx,
// SessionInsightsPanel.tsx) — the 2026-09-02 audit of those components is
// what these lists were written from.

/** crisis_events rows (+ joined session_name/username) — everything EXCEPT
 *  risk_factors, intervention_details, notes. */
export const CRISIS_EVENT_SUMMARY_FIELDS = [
  'event_id', 'session_id', 'session_name', 'user_id', 'username',
  'client_user_id', 'origin', 'thread_message_id', 'thread_id',
  'event_type', 'severity', 'previous_severity', 'risk_score',
  'previous_risk_score', 'triggered_by', 'trigger_method', 'message_id',
  'created_at',
] as const;

/** risk_score_history rows — everything EXCEPT score_factors (stage-2 LLM
 *  reasoning can quote messages). */
export const RISK_HISTORY_SUMMARY_FIELDS = [
  'history_id', 'session_id', 'session_name', 'message_id',
  'risk_score', 'severity', 'calculated_at',
] as const;

/** intervention_actions rows — everything EXCEPT action_details and notes. */
export const INTERVENTION_SUMMARY_FIELDS = [
  'action_id', 'session_id', 'session_name', 'action_type', 'risk_score',
  'performed_by', 'performed_at', 'outcome',
] as const;

/** Flagged message-origin crisis events (/api/admin/messaging/flagged) —
 *  everything EXCEPT risk_factors and notes. */
export const FLAGGED_EVENT_SUMMARY_FIELDS = [
  'event_id', 'origin', 'session_id', 'thread_message_id', 'thread_id',
  'client_user_id', 'user_id', 'username', 'event_type', 'severity',
  'risk_score', 'triggered_by', 'trigger_method', 'created_at',
] as const;

/** The assembled session-insights payload — summary, affect curve (derived
 *  non-verbatim affect, ai-therapist-86), safety plan, screeners, and the
 *  authored-note pointer; everything soap_* / notes_* stays therapist-only. */
export const SESSION_INSIGHTS_SUMMARY_FIELDS = [
  'session_id', 'user_id', 'summary', 'affect_curve', 'model',
  'created_at', 'updated_at', 'safety_plan', 'scale_responses',
  'authored_note',
] as const;

/** Project each row down to ONLY the allowlisted fields (shallow copy;
 *  non-destructive; absent fields stay absent rather than becoming null, so
 *  client "render if present" checks behave the same as before). */
export function projectRows<T extends Record<string, unknown>>(
  rows: T[],
  allow: readonly string[]
): Record<string, unknown>[] {
  return rows.map((row) => projectRow(row, allow));
}

/** Single-object variant of projectRows. */
export function projectRow<T extends Record<string, unknown>>(
  row: T,
  allow: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of allow) {
    if (field in row) out[field] = row[field];
  }
  return out;
}
