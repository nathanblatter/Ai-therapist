// Source of truth for the active consent copy. As of migration 047 this lives
// in the consent_documents table (versioned, hash-verified) rather than a
// hardcoded constant: the active document is the newest row with
// effective_at <= now(). As of migration 078 documents are audience-tagged
// ('research' | 'clinical'); which audience participants see is resolved from
// system_config.deployment_mode ('clinical' -> clinical copy, anything else ->
// research copy). getActiveConsent() caches lookups ~30s so requireConsent
// doesn't hit the DB on every /token poll; publishing a new version via the
// admin API busts the caches immediately (same-process).
//
// NOTE: cache invalidation is single-process. With one server that's exact;
// if multiple processes ever serve /token, a newly published version can take
// up to CACHE_TTL_MS to gate everywhere. Acceptable for the current topology.
import { sha256Hex } from './crypto.js';
import { getActiveConsentDocument, type ConsentAudience } from '../db/consent.queries.js';
import { getSystemConfigByKey } from '../db/config.queries.js';
import { createLogger } from './logger.js';

const log = createLogger('consent');

export type { ConsentAudience };

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
  /** Which audience's document was served (post-078). The clinical->research
   *  fallback reports 'research' — it is the research copy being served. */
  audience: ConsentAudience;
}

const CACHE_TTL_MS = 30_000;
const caches = new Map<ConsentAudience, { value: ActiveConsent; at: number }>();
let audienceCache: { value: ConsentAudience; at: number } | null = null;

// Re-export for existing importers; the implementation moved to utils/crypto.
export { sha256Hex };

/** Bust every cached consent lookup (call after publishing a new version or
 *  changing deployment_mode). */
export function invalidateConsentCache(): void {
  caches.clear();
  audienceCache = null;
}

/**
 * Which consent audience the deployment serves: 'clinical' when
 * system_config.deployment_mode.mode === 'clinical', otherwise 'research'
 * (the pre-078 posture, and the fail-safe on any lookup error). Cached ~30s.
 */
export async function resolveConsentAudience(): Promise<ConsentAudience> {
  const now = Date.now();
  if (audienceCache && now - audienceCache.at < CACHE_TTL_MS) return audienceCache.value;
  try {
    const row = await getSystemConfigByKey('deployment_mode');
    const mode = (row?.config_value as { mode?: string } | null)?.mode;
    const audience: ConsentAudience = mode === 'clinical' ? 'clinical' : 'research';
    audienceCache = { value: audience, at: now };
    return audience;
  } catch (err) {
    if (audienceCache) return audienceCache.value;
    log.error({ err }, 'deployment_mode lookup failed; defaulting consent audience to research');
    return 'research';
  }
}

function fallbackConsent(): ActiveConsent {
  return {
    version: CURRENT_CONSENT_VERSION,
    body: FALLBACK_CONSENT_BODY,
    bodyHash: sha256Hex(FALLBACK_CONSENT_BODY),
    audience: 'research',
  };
}

/**
 * The active consent copy (version + body + hash) for the given audience —
 * resolved from deployment_mode when omitted. Cached ~30s per audience.
 *
 * Fallback ladder (never blocks session start):
 *   clinical requested but no clinical doc -> research doc (logged warning)
 *   table empty (pre-047 boot)             -> hardcoded fallback copy
 *   DB error                               -> last cached value, else fallback
 */
export async function getActiveConsent(audience?: ConsentAudience): Promise<ActiveConsent> {
  const aud = audience ?? (await resolveConsentAudience());
  const now = Date.now();
  const cached = caches.get(aud);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    let doc = await getActiveConsentDocument(aud);
    let served: ConsentAudience = aud;
    if (!doc && aud === 'clinical') {
      log.warn('no clinical consent document exists; falling back to the research copy');
      doc = await getActiveConsentDocument('research');
      served = 'research';
    }
    if (doc) {
      const value: ActiveConsent = {
        version: doc.version,
        body: doc.body,
        bodyHash: doc.body_hash,
        audience: served,
      };
      caches.set(aud, { value, at: now });
      return value;
    }
    // Table empty — pre-migration boot. Serve the fallback but don't cache it
    // long, so we pick up the real document as soon as it exists.
    log.warn('consent_documents is empty; serving hardcoded fallback consent copy');
    return fallbackConsent();
  } catch (err) {
    if (cached) {
      log.error({ err }, 'active-consent lookup failed; serving last cached value (stale-on-error)');
      return cached.value;
    }
    log.error({ err }, 'active-consent lookup failed and no cache; serving hardcoded fallback');
    return fallbackConsent();
  }
}
