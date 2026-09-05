// Data-access for participant consent acceptance (IRB requirement). Consent is
// recorded once when the participant accepts (session_id NULL, user_id set if
// logged in), then again per-session once a therapy session actually starts —
// see requireConsent + the /token and /api/chat/start handlers.
import { pool } from '../config/db.js';

export interface RecordConsentInput {
  sessionId?: string | null;
  userId?: number | null;
  consentVersion: string;
  recordingEnabled: boolean;
  /** sha256 of the exact consent body accepted (matches consent_documents.body_hash). */
  bodyHash?: string | null;
}

export interface ConsentRow {
  consent_id: number;
  session_id: string | null;
  user_id: number | null;
  consent_version: string;
  accepted_at: Date;
  recording_enabled: boolean;
  body_hash: string | null;
  created_at: Date;
}

/** Persist a consent acceptance record. */
export async function recordConsent(input: RecordConsentInput): Promise<ConsentRow> {
  const result = await pool.query<ConsentRow>(
    `INSERT INTO participant_consents (session_id, user_id, consent_version, recording_enabled, body_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.sessionId ?? null, input.userId ?? null, input.consentVersion, input.recordingEnabled, input.bodyHash ?? null]
  );
  return result.rows[0];
}

// ---- Versioned consent documents (migration 047) ----
// The active consent copy is the newest document with effective_at <= now().
// A published version with a future effective_at is "scheduled" and ignored
// until it takes effect.

/** Which deployment the consent copy addresses (migration 078). */
export type ConsentAudience = 'research' | 'clinical';

export interface ConsentDocumentRow {
  document_id: number;
  version: string;
  body: string;
  body_hash: string;
  effective_at: Date;
  published_by: string;
  created_at: Date;
  /** 'research' (IRB study copy) or 'clinical' (care-team copy); absent
   *  pre-078. */
  audience?: ConsentAudience;
}

/** Newest document for the audience with effective_at <= now(), or null.
 *  Defaults to 'research' — the pre-078 behavior exactly (every pre-078 row
 *  is backfilled audience='research'). */
export async function getActiveConsentDocument(
  audience: ConsentAudience = 'research'
): Promise<ConsentDocumentRow | null> {
  const result = await pool.query<ConsentDocumentRow>(
    `SELECT document_id, version, body, body_hash, effective_at, published_by, created_at, audience
     FROM consent_documents
     WHERE effective_at <= CURRENT_TIMESTAMP AND audience = $1
     ORDER BY effective_at DESC
     LIMIT 1`,
    [audience]
  );
  return result.rows[0] ?? null;
}

/** A single document by version (admin preview), or null. */
export async function getConsentDocumentByVersion(version: string): Promise<ConsentDocumentRow | null> {
  const result = await pool.query<ConsentDocumentRow>(
    `SELECT document_id, version, body, body_hash, effective_at, published_by, created_at
     FROM consent_documents WHERE version = $1`,
    [version]
  );
  return result.rows[0] ?? null;
}

export interface ConsentDocumentListRow extends ConsentDocumentRow {
  acceptance_count: number;
}

/** All documents, newest first, each with its per-version acceptance count. */
export async function listConsentDocuments(): Promise<ConsentDocumentListRow[]> {
  const result = await pool.query<ConsentDocumentListRow>(
    `SELECT cd.document_id, cd.version, cd.body, cd.body_hash, cd.effective_at,
            cd.published_by, cd.created_at, cd.audience,
            COUNT(pc.consent_id)::int AS acceptance_count
     FROM consent_documents cd
     LEFT JOIN participant_consents pc ON pc.consent_version = cd.version
     GROUP BY cd.document_id
     ORDER BY cd.effective_at DESC, cd.document_id DESC`
  );
  return result.rows;
}

/** Publish a new consent document. Throws on duplicate version (PG 23505).
 *  audience defaults at the DB layer to 'research' (078); when given, it is
 *  written explicitly. The audience-less SQL shape is kept for the default
 *  path so pre-078 call sites behave byte-identically. */
export async function insertConsentDocument(input: {
  version: string;
  body: string;
  bodyHash: string;
  effectiveAt: Date | null;
  publishedBy: string;
  audience?: ConsentAudience;
}): Promise<ConsentDocumentRow> {
  if (input.audience !== undefined) {
    const result = await pool.query<ConsentDocumentRow>(
      `INSERT INTO consent_documents (version, body, body_hash, effective_at, published_by, audience)
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_TIMESTAMP), $5, $6)
       RETURNING document_id, version, body, body_hash, effective_at, published_by, created_at, audience`,
      [input.version, input.body, input.bodyHash, input.effectiveAt, input.publishedBy, input.audience]
    );
    return result.rows[0];
  }
  const result = await pool.query<ConsentDocumentRow>(
    `INSERT INTO consent_documents (version, body, body_hash, effective_at, published_by)
     VALUES ($1, $2, $3, COALESCE($4, CURRENT_TIMESTAMP), $5)
     RETURNING document_id, version, body, body_hash, effective_at, published_by, created_at`,
    [input.version, input.body, input.bodyHash, input.effectiveAt, input.publishedBy]
  );
  return result.rows[0];
}

/** Most recent consent acceptance for a logged-in user, or null. */
export async function getLatestConsentForUser(userId: number): Promise<ConsentRow | null> {
  const result = await pool.query<ConsentRow>(
    `SELECT * FROM participant_consents WHERE user_id = $1 ORDER BY accepted_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

/**
 * Whether audio recording is consented for a session's owner (migration 086
 * enforcement): false only when the session is linked to a user whose LATEST
 * consent snapshot has recording_enabled = false. Sessions without a linked
 * user (demo/anonymous) or with no consent rows keep prior behavior (true) —
 * the global session_recording_enabled feature flag still gates them upstream.
 */
export async function isRecordingConsentedForSession(sessionId: string): Promise<boolean> {
  const result = await pool.query<{ recording_enabled: boolean }>(
    `SELECT pc.recording_enabled
     FROM therapy_sessions ts
     JOIN LATERAL (
       SELECT recording_enabled FROM participant_consents
       WHERE user_id = ts.user_id
       ORDER BY accepted_at DESC
       LIMIT 1
     ) pc ON true
     WHERE ts.session_id = $1 AND ts.user_id IS NOT NULL`,
    [sessionId]
  );
  return result.rows[0]?.recording_enabled ?? true;
}

/** The consent record tied to a specific session, or null. */
export async function getConsentForSession(sessionId: string): Promise<ConsentRow | null> {
  const result = await pool.query<ConsentRow>(
    `SELECT * FROM participant_consents WHERE session_id = $1 ORDER BY accepted_at DESC LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] ?? null;
}
