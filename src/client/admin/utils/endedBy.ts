// How a therapy session ended (therapy_sessions.ended_by), in words. The
// column is free text; these are the values the server writes.
import { ACCOUNT_CHANGED_END_REASON } from '../../../shared/accountSignedOut';

/** The fixed choices of the "ended by" filters. */
export const ENDED_BY_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'admin', label: 'Admin' },
  { value: 'system', label: 'System' },
  // Staff changed the account's role or deleted the account mid-session.
  { value: ACCOUNT_CHANGED_END_REASON, label: 'Account changed' },
];

/** The label for one stored value; an unlisted one is shown with a capital. */
export function endedByLabel(endedBy: string | null | undefined): string {
  if (!endedBy) return '';
  const known = ENDED_BY_OPTIONS.find((option) => option.value === endedBy);
  return known ? known.label : endedBy.charAt(0).toUpperCase() + endedBy.slice(1);
}
