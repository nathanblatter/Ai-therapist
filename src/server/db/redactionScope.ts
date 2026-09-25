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
