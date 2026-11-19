// What a participant is told when the database could not answer
// (ai-therapist-373). It is sent exactly when the database is down, so it must
// never need it: the configured crisis contact is used when this process
// already holds it (the system config cache, any age), and the fixed text
// (DATABASE_RETRY_MESSAGE) otherwise.
//
// Language: there is no localisation for server-sent participant strings in
// this codebase (the session-limit refusal, the minor goodbye and this message
// are all English), so this stays English like them.
import type { OpeningCrisisContact } from '../../shared/openingPrompt.js';
import { DATABASE_RETRY_MESSAGE } from './dbErrors.js';
import { peekCachedSystemConfig } from './sessionHelpers.js';

const RETRY_SENTENCE = 'We could not reach our system just now. Please wait a moment and try again.';

/** The retry message for this contact, or the fixed text when the contact is
 *  missing, disabled or incomplete. Pure; exported for tests. */
export function buildDatabaseRetryMessage(contact: OpeningCrisisContact | null | undefined): string {
  const hotline = typeof contact?.hotline === 'string' ? contact.hotline.trim() : '';
  const phone = typeof contact?.phone === 'string' ? contact.phone.trim() : '';
  if (!contact || contact.enabled === false || !hotline || !phone) return DATABASE_RETRY_MESSAGE;
  const text = typeof contact.text === 'string' ? contact.text.trim() : '';
  const textPart = text ? `, or ${text.charAt(0).toLowerCase()}${text.slice(1)}` : '';
  return `${RETRY_SENTENCE} If you are in crisis, contact the ${hotline} at ${phone}${textPart}, or call 911.`;
}

/** The message to send now. Never reads the database; never throws. */
export function databaseRetryMessage(): string {
  try {
    const contact = peekCachedSystemConfig()?.crisis_contact as OpeningCrisisContact | undefined;
    return buildDatabaseRetryMessage(contact);
  } catch {
    return DATABASE_RETRY_MESSAGE;
  }
}
