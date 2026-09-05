// Data-access audit log (migration 091): append-only record of WHO viewed
// transcripts, streamed recordings, or ran research exports. Writes are
// strictly fire-and-forget — an audit-log failure is loudly logged but must
// never block or fail the data access it records.
import { pool } from '../config/db.js';

export type DataAccessAction =
  | 'transcript_view'
  | 'recording_stream'
  | 'export'
  | 'dataset_export';

export interface DataAccessLogInput {
  /** userid of the account performing the access (null if unknown). */
  accessedBy: number | null;
  /** Session role of the accessor at access time. */
  role: string | null;
  action: DataAccessAction;
  /** Therapy session the access concerns, when applicable. */
  sessionId?: string | null;
  /** Participant/user the access concerns, when applicable. */
  userId?: number | null;
  /** Free-form context (export type, format, filters, ...). */
  detail?: unknown;
}

/**
 * Append one data-access row. Fire-and-forget: never throws, never rejects.
 * Call without awaiting from request handlers.
 */
export function logDataAccess(input: DataAccessLogInput): Promise<void> {
  return pool
    .query(
      `INSERT INTO data_access_log (accessed_by, role, action, session_id, user_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.accessedBy,
        input.role,
        input.action,
        input.sessionId ?? null,
        input.userId ?? null,
        input.detail === undefined ? null : JSON.stringify(input.detail),
      ]
    )
    .then(() => undefined)
    .catch((err) => {
      console.error('[data-access-log] failed to record access row:', err);
    });
}
