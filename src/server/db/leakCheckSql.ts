// The single definition of the redaction leak-check states in SQL
// (messages.metadata.redaction_check, written by redactionVerifier.service.ts).
//
// A row's leak check is in exactly one of these states:
//
//   never checked  no redaction_check key (verifier off, empty text, or not
//                  run yet)
//   checked        the model answered; `flagged` says whether p_leak reached
//                  the threshold
//   errored        the check did not run to an answer (ai-therapist-288).
//                  Since 2026-11-19 written as status='errored'. Rows from
//                  before that (the ai-therapist-284 outage among them) carry
//                  only `error` (with flagged=false, p_leak=-1), so both
//                  shapes count.
//
// "Could not check" must never read as "checked and clean": every place that
// treats a flagged row specially (the review queue, its counts, the semantic
// search gate) treats an errored row the same way until a researcher has
// reviewed it. Build those filters from here so the two cannot drift.

function col(alias?: string): string {
  return `${alias ? `${alias}.` : ''}metadata->'redaction_check'`;
}

/** The leak check ran and judged the text to still contain an identifier. */
export function leakCheckFlaggedSql(alias?: string): string {
  return `(COALESCE(${col(alias)}->>'flagged', 'false') = 'true')`;
}

/** The leak check was attempted and did not produce an answer. */
export function leakCheckErroredSql(alias?: string): string {
  const c = col(alias);
  return `(COALESCE(${c}->>'status', '') = 'errored' OR COALESCE(${c} ? 'error', false))`;
}

/** A researcher has corrected or approved the row since its check. */
export function leakCheckReviewedSql(alias?: string): string {
  return `(COALESCE(${col(alias)}->>'reviewed', 'false') = 'true')`;
}

export function leakCheckFlaggedUnreviewedSql(alias?: string): string {
  return `(${leakCheckFlaggedSql(alias)} AND NOT ${leakCheckReviewedSql(alias)})`;
}

export function leakCheckErroredUnreviewedSql(alias?: string): string {
  return `(${leakCheckErroredSql(alias)} AND NOT ${leakCheckReviewedSql(alias)})`;
}

/** Flagged or errored, and nobody has reviewed it: a researcher must look. */
export function leakCheckNeedsReviewSql(alias?: string): string {
  return `((${leakCheckFlaggedSql(alias)} OR ${leakCheckErroredSql(alias)}) AND NOT ${leakCheckReviewedSql(alias)})`;
}
