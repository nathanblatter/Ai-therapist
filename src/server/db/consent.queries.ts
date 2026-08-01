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

export interface ConsentDocumentRow {
  document_id: number;
  version: string;
  body: string;
  body_hash: string;
  effective_at: Date;
  published_by: string;
  created_at: Date;
}

/** Newest document with effective_at <= now(), or null if the table is empty. */
export async function getActiveConsentDocument(): Promise<ConsentDocumentRow | null> {
  const result = await pool.query<ConsentDocumentRow>(
    `SELECT document_id, version, body, body_hash, effective_at, published_by, created_at
     FROM consent_documents
     WHERE effective_at <= CURRENT_TIMESTAMP
     ORDER BY effective_at DESC
     LIMIT 1`
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
            cd.published_by, cd.created_at,
            COUNT(pc.consent_id)::int AS acceptance_count
     FROM consent_documents cd
     LEFT JOIN participant_consents pc ON pc.consent_version = cd.version
     GROUP BY cd.document_id
     ORDER BY cd.effective_at DESC, cd.document_id DESC`
  );
  return result.rows;
}

/** Publish a new consent document. Throws on duplicate version (PG 23505). */
export async function insertConsentDocument(input: {
  version: string;
  body: string;
  bodyHash: string;
  effectiveAt: Date | null;
  publishedBy: string;
}): Promise<ConsentDocumentRow> {
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

/** The consent record tied to a specific session, or null. */
export async function getConsentForSession(sessionId: string): Promise<ConsentRow | null> {
  const result = await pool.query<ConsentRow>(
    `SELECT * FROM participant_consents WHERE session_id = $1 ORDER BY accepted_at DESC LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] ?? null;
}
