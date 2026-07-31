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
}

export interface ConsentRow {
  consent_id: number;
  session_id: string | null;
  user_id: number | null;
  consent_version: string;
  accepted_at: Date;
  recording_enabled: boolean;
  created_at: Date;
}

/** Persist a consent acceptance record. */
export async function recordConsent(input: RecordConsentInput): Promise<ConsentRow> {
  const result = await pool.query<ConsentRow>(
    `INSERT INTO participant_consents (session_id, user_id, consent_version, recording_enabled)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.sessionId ?? null, input.userId ?? null, input.consentVersion, input.recordingEnabled]
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
