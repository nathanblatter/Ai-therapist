// Source of truth for the active consent copy. As of migration 047 this lives
// in the consent_documents table (versioned, hash-verified) rather than a
// hardcoded constant: the active document is the newest row with
// effective_at <= now(). getActiveConsent() caches the lookup ~30s so
// requireConsent doesn't hit the DB on every /token poll; publishing a new
// version via the admin API busts the cache immediately (same-process).
//
// NOTE: cache invalidation is single-process. With one server that's exact;
// if multiple processes ever serve /token, a newly published version can take
// up to CACHE_TTL_MS to gate everywhere. Acceptable for the current topology.
import { createHash } from 'node:crypto';
import { getActiveConsentDocument } from '../db/consent.queries.js';
import { createLogger } from './logger.js';

const log = createLogger('consent');

// Deprecated fallback: only used if consent_documents is empty (e.g. the server
// boots before migration 047 has run). Kept byte-identical to the 047 v1
// backfill so the fallback hash matches the eventual DB row.
export const CURRENT_CONSENT_VERSION = '2026-07-30.1';

const FALLBACK_CONSENT_BODY = `## Before we begin

Please review and accept to start your session.

- **Transcription.** What you say is transcribed to text so the assistant can respond and so your session can be reviewed as part of this study.
- **Live monitoring.** A researcher or therapist may be monitoring sessions in real time and can send messages into your conversation if needed.
- **Data retention.** Session content is retained only as long as needed for the study and is redacted of identifying details before long-term storage. Raw content is automatically deleted after the retention period.
- **Crisis protocol.** If anything you say suggests you may be in danger, our system may show you crisis resources (e.g. the 988 Suicide & Crisis Lifeline), and in some cases a member of our team may be notified so they can reach out to you directly.`;

export interface ActiveConsent {
  version: string;
  body: string;
  bodyHash: string;
}

const CACHE_TTL_MS = 30_000;
let cache: { value: ActiveConsent; at: number } | null = null;

/** hex sha256 of a UTF-8 string (matches PG encode(sha256(convert_to(...,'UTF8')),'hex')). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Bust the cached active-consent lookup (call after publishing a new version). */
export function invalidateConsentCache(): void {
  cache = null;
}

/**
 * The active consent copy (version + body + hash). Cached ~30s. On a DB error
 * the last cached value is returned (stale-on-error) so a transient outage
 * doesn't 500 token issuance; if there's no cache yet, the hardcoded fallback
 * is used and a warning is logged.
 */
export async function getActiveConsent(): Promise<ActiveConsent> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  try {
    const doc = await getActiveConsentDocument();
    if (doc) {
      const value: ActiveConsent = { version: doc.version, body: doc.body, bodyHash: doc.body_hash };
      cache = { value, at: now };
      return value;
    }
    // Table empty — pre-migration boot. Serve the fallback but don't cache it
    // long, so we pick up the real document as soon as it exists.
    log.warn('consent_documents is empty; serving hardcoded fallback consent copy');
    return { version: CURRENT_CONSENT_VERSION, body: FALLBACK_CONSENT_BODY, bodyHash: sha256Hex(FALLBACK_CONSENT_BODY) };
  } catch (err) {
    if (cache) {
      log.error({ err }, 'active-consent lookup failed; serving last cached value (stale-on-error)');
      return cache.value;
    }
    log.error({ err }, 'active-consent lookup failed and no cache; serving hardcoded fallback');
    return { version: CURRENT_CONSENT_VERSION, body: FALLBACK_CONSENT_BODY, bodyHash: sha256Hex(FALLBACK_CONSENT_BODY) };
  }
}
