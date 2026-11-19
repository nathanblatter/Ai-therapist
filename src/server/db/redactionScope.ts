// The single definition of "which message rows are in scope for PHI redaction".
//
// This predicate used to be copy-pasted into the redaction job, the content-wipe
// sweep and the admin status read, and the three copies drifted
// (ai-therapist-225): the job and the sweep were widened to cover tool_event_%
// rows but the status read was not, so the admin UI reported a session as fully
// redacted while participant free text from thought records and fear ladders sat
// unredacted.
//
// Scope rule: role='user'/'assistant' rows are participant/model turns. Other
// role='system' rows are machine-authored (steering, tool calls) and need no
// redaction — EXCEPT message_type LIKE 'tool_event_%', whose body is verbatim
// participant-typed free text carrying names, places and dates.
//
// Every query that answers "does this row still need redaction / has it been
// redacted / how many are outstanding" must build its filter from here.

/**
 * SQL boolean fragment selecting the message rows that PHI redaction covers.
 *
 * @param alias optional table alias/qualifier for the `messages` table (e.g. 'm').
 */
export function redactableRowsSql(alias?: string): string {
  const q = alias ? `${alias}.` : '';
  return `(${q}role IN ('user', 'assistant') OR ${q}message_type LIKE 'tool_event_%')`;
}

/** Unqualified form, for queries with a single (unaliased) `messages` table. */
export const REDACTABLE_ROWS_SQL = redactableRowsSql();

/**
 * SQL boolean fragment: the row has NOT been marked as a rejected redaction
 * (ai-therapist-382). When the model's output for a message fails validation
 * (a refusal, a reply, a fragment), the row keeps content_redacted NULL and
 * gets metadata.redaction_rejected plus a redaction_error. The automatic jobs
 * (the end-of-session job and the 15-minute gap sweep) must not pick such a
 * row up again: the same text would most likely be refused again, every 15
 * minutes, forever. It waits for an explicit re-run
 * (src/database/scripts/findInvalidRedactions.ts --re-redact) or a manual
 * redaction. COALESCE because `NULL ? key` is NULL, which would drop rows
 * with no metadata at all.
 */
export function notRejectedSql(alias?: string): string {
  const q = alias ? `${alias}.` : '';
  return `NOT (COALESCE(${q}metadata, '{}'::jsonb) ? 'redaction_rejected')`;
}
