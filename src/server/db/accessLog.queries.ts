// Data-access audit log (migration 091): append-only record of WHO viewed
// transcripts, streamed recordings, or ran research exports. Writes are
// strictly fire-and-forget — an audit-log failure is loudly logged but must
// never block or fail the data access it records.
import { pool } from '../config/db.js';

export type DataAccessAction =
  | 'transcript_view'
  | 'recording_stream'
  /** Whole-file download of a recording (ai-therapist-199): audio left the system. */
  | 'recording_download'
  | 'export'
  | 'dataset_export'
  /** Reading a participant's access history (ai-therapist-197): the audit
   *  trail is self-auditing; the global list view is NOT logged. */
  | 'audit_log_view';

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

// ---------------------------------------------------------------------------
// Reads (ai-therapist-197). The audit trail was cited to the IRB as the
// control answering "who can see participant data", so it must be readable.
// Every row is joined to the actor's username and — via the therapy session
// when the writer did not stamp user_id (recording streams) — to the
// participant it concerns. Rows outlive account deletion, so both joins are
// LEFT and usernames may be null.
// ---------------------------------------------------------------------------

/** Every action value the log may hold, including the self-audit row. */
export const DATA_ACCESS_ACTIONS: readonly DataAccessAction[] = [
  'transcript_view',
  'recording_stream',
  'recording_download',
  'export',
  'dataset_export',
  'audit_log_view',
] as const;

export function isDataAccessAction(value: unknown): value is DataAccessAction {
  return typeof value === 'string' && (DATA_ACCESS_ACTIONS as readonly string[]).includes(value);
}

export interface DataAccessLogRow {
  id: number;
  accessed_by: number | null;
  actor_username: string | null;
  role: string | null;
  action: DataAccessAction;
  session_id: string | null;
  /** The participant the row concerns: the stamped user_id, else the owner
   *  of session_id. Null for participant-less rows (dataset exports). */
  participant_user_id: number | null;
  participant_username: string | null;
  detail: unknown;
  created_at: string;
}

export interface DataAccessLogFilters {
  participantUserId?: number | null;
  sessionId?: string | null;
  /** Case-insensitive substring match on the actor's username. */
  actorUsername?: string | null;
  action?: DataAccessAction | null;
  /** ISO timestamps (inclusive lower / exclusive upper bound). */
  since?: string | null;
  until?: string | null;
  limit: number;
  offset: number;
}

export interface DataAccessLogPage {
  rows: DataAccessLogRow[];
  total: number;
}

// Shared FROM/JOIN clause: resolve the participant through the therapy
// session when the writer only knew the session id. therapy_sessions.
// session_id is a UUID while the log stores text, so compare as text.
const DATA_ACCESS_FROM = `
  FROM data_access_log dal
  LEFT JOIN therapy_sessions ts ON dal.session_id IS NOT NULL AND ts.session_id::text = dal.session_id
  LEFT JOIN users actor ON actor.userid = dal.accessed_by
  LEFT JOIN users participant ON participant.userid = COALESCE(dal.user_id, ts.user_id)`;

const DATA_ACCESS_SELECT = `
  SELECT dal.id, dal.accessed_by, actor.username AS actor_username, dal.role, dal.action,
         dal.session_id, COALESCE(dal.user_id, ts.user_id) AS participant_user_id,
         participant.username AS participant_username, dal.detail,
         dal.created_at::text AS created_at`;

/**
 * Filtered, paginated page of the data-access log with a total count.
 * `orgId` (C13 researcher scoping): when set, only rows whose actor or
 * participant belongs to that organization are returned; null = unscoped.
 */
export async function listDataAccessLog(
  filters: DataAccessLogFilters,
  orgId: number | null = null
): Promise<DataAccessLogPage> {
  const where = `
    WHERE ($1::int IS NULL OR COALESCE(dal.user_id, ts.user_id) = $1)
      AND ($2::text IS NULL OR dal.session_id = $2)
      AND ($3::text IS NULL OR actor.username ILIKE '%' || $3 || '%')
      AND ($4::text IS NULL OR dal.action = $4)
      AND ($5::timestamptz IS NULL OR dal.created_at >= $5)
      AND ($6::timestamptz IS NULL OR dal.created_at < $6)
      AND ($7::int IS NULL OR actor.organization_id = $7 OR participant.organization_id = $7)`;
  const params = [
    filters.participantUserId ?? null,
    filters.sessionId ?? null,
    filters.actorUsername ?? null,
    filters.action ?? null,
    filters.since ?? null,
    filters.until ?? null,
    orgId,
  ];
  const [page, count] = await Promise.all([
    pool.query<DataAccessLogRow>(
      `${DATA_ACCESS_SELECT} ${DATA_ACCESS_FROM} ${where}
       ORDER BY dal.id DESC
       LIMIT $8 OFFSET $9`,
      [...params, filters.limit, filters.offset]
    ),
    pool.query<{ count: string }>(`SELECT COUNT(*) AS count ${DATA_ACCESS_FROM} ${where}`, params),
  ]);
  return { rows: page.rows, total: parseInt(count.rows[0].count, 10) };
}

/** One actor x action line of a participant's access history. */
export interface ParticipantAccessActor {
  accessed_by: number | null;
  actor_username: string | null;
  role: string | null;
  action: DataAccessAction;
  count: number;
  first_at: string;
  last_at: string;
}

export interface ParticipantAccessHistory extends DataAccessLogPage {
  /** Every (actor, action) pair that touched this participant, most recent first. */
  actors: ParticipantAccessActor[];
}

/**
 * Everything anyone has done to one participant's data: rows stamped with
 * their user_id plus rows against any of their therapy sessions, with a
 * per-actor rollup so "who has seen my sessions?" is one read.
 */
export async function getParticipantAccessHistory(
  participantUserId: number,
  page: { limit: number; offset: number }
): Promise<ParticipantAccessHistory> {
  const where = 'WHERE COALESCE(dal.user_id, ts.user_id) = $1';
  const [rows, count, actors] = await Promise.all([
    pool.query<DataAccessLogRow>(
      `${DATA_ACCESS_SELECT} ${DATA_ACCESS_FROM} ${where}
       ORDER BY dal.id DESC
       LIMIT $2 OFFSET $3`,
      [participantUserId, page.limit, page.offset]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count ${DATA_ACCESS_FROM} ${where}`,
      [participantUserId]
    ),
    pool.query<ParticipantAccessActor>(
      `SELECT dal.accessed_by, actor.username AS actor_username, dal.role, dal.action,
              COUNT(*)::int AS count,
              MIN(dal.created_at)::text AS first_at, MAX(dal.created_at)::text AS last_at
       ${DATA_ACCESS_FROM} ${where}
       GROUP BY dal.accessed_by, actor.username, dal.role, dal.action
       ORDER BY MAX(dal.created_at) DESC`,
      [participantUserId]
    ),
  ]);
  return { rows: rows.rows, total: parseInt(count.rows[0].count, 10), actors: actors.rows };
}
