// Summary-tier scrubbing for crisis/risk payloads (caseworker portal,
// docs/caseworker-portal.md section 3). Caseworkers get the 'summary' data tier
// (dataTierFor): scores, severities, timestamps, and actors pass through, but
// the free-text / matched-snippet columns that can quote verbatim participant
// messages must be stripped before a caseworker sees a crisis payload. Shared
// so every crisis-bearing endpoint scrubs the SAME fields (a per-route copy is
// how /flagged drifted into leaking them — ai-therapist-143).

/** crisis_events: risk_factors (matched keywords/snippets), intervention
 *  details, free-text notes. */
export const CRISIS_EVENT_VERBATIM_FIELDS = ['risk_factors', 'intervention_details', 'notes'] as const;
/** risk_score_history: score_factors (stage-2 LLM reasoning). */
export const RISK_HISTORY_VERBATIM_FIELDS = ['score_factors'] as const;
/** intervention_actions: action details + free-text notes. */
export const INTERVENTION_VERBATIM_FIELDS = ['action_details', 'notes'] as const;

/** Drop the named fields from each row (shallow copy; non-destructive). */
export function scrubRows<T extends Record<string, unknown>>(
  rows: T[],
  fields: readonly string[]
): Record<string, unknown>[] {
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const field of fields) delete copy[field];
    return copy;
  });
}
