// Data-access for care_notes (caseworker portal, migration 071): therapist
// progress notes + caseworker case notes in one table. Lifecycle:
// draft (author edits/deletes freely) -> sign (sign_hash computed, content
// immutable via DB trigger) -> amend (new linked draft; signing the amendment
// flips the original to 'amended' in the same transaction).
import { createHash } from 'crypto';
import { pool } from '../config/db.js';
import type { CareTeamRole } from '../../shared/roles.js';

export type CareNoteType = 'progress' | 'case';
export type CareNoteStatus = 'draft' | 'signed' | 'amended';
export type CaseNoteKind = 'contact' | 'referral' | 'coordination' | 'safety_check' | 'other';

export interface CareNoteRow {
  note_id: number;
  org_id: number;
  client_id: number;
  author_id: number | null;
  author_name: string;
  author_role: CareTeamRole;
  note_type: CareNoteType;
  case_note_kind: CaseNoteKind | null;
  session_id: string | null;
  seed_source: 'ai_soap' | null;
  seed_model: string | null;
  content: Record<string, unknown>;
  status: CareNoteStatus;
  shared_with_care_team: boolean;
  signed_at: string | null;
  sign_hash: string | null;
  amends_note_id: number | null;
  created_at: string;
  updated_at: string;
}

const NOTE_COLUMNS = `note_id, org_id, client_id, author_id, author_name, author_role,
       note_type, case_note_kind, session_id, seed_source, seed_model, content,
       status, shared_with_care_team, signed_at::text AS signed_at, sign_hash,
       amends_note_id, created_at::text AS created_at, updated_at::text AS updated_at`;

function toBigintId(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 hex of the note's canonical signing payload. Exported for tests
 *  and for verify-on-read tooling. */
export function computeSignHash(note: {
  note_id: number;
  client_id: number;
  author_id: number | null;
  author_name: string;
  note_type: string;
  content: unknown;
  signed_at: string;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        note_id: toBigintId(note.note_id),
        client_id: note.client_id,
        author_id: note.author_id,
        author_name: note.author_name,
        note_type: note.note_type,
        content: note.content,
        signed_at: note.signed_at,
      })
    )
    .digest('hex');
}

export interface CreateCareNoteInput {
  orgId: number;
  clientId: number;
  authorId: number;
  authorName: string;
  authorRole: CareTeamRole;
  noteType: CareNoteType;
  caseNoteKind?: CaseNoteKind | null;
  sessionId?: string | null;
  seedSource?: 'ai_soap' | null;
  seedModel?: string | null;
  content: Record<string, unknown>;
  amendsNoteId?: number | null;
}

/** Insert a new draft note. DB CHECKs enforce role/type consistency
 *  (caseworkers author case notes only). */
export async function createCareNote(input: CreateCareNoteInput): Promise<CareNoteRow> {
  const result = await pool.query<CareNoteRow>(
    `INSERT INTO care_notes
       (org_id, client_id, author_id, author_name, author_role, note_type,
        case_note_kind, session_id, seed_source, seed_model, content, amends_note_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${NOTE_COLUMNS}`,
    [
      input.orgId,
      input.clientId,
      input.authorId,
      input.authorName,
      input.authorRole,
      input.noteType,
      input.caseNoteKind ?? null,
      input.sessionId ?? null,
      input.seedSource ?? null,
      input.seedModel ?? null,
      JSON.stringify(input.content),
      input.amendsNoteId ?? null,
    ]
  );
  return result.rows[0];
}

/** One note by id, or null. */
export async function getCareNoteById(noteId: number): Promise<CareNoteRow | null> {
  const result = await pool.query<CareNoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM care_notes WHERE note_id = $1`,
    [noteId]
  );
  return result.rows[0] ?? null;
}

export interface NoteViewer {
  userId: number;
  role: CareTeamRole;
}

/**
 * A client's notes visible to the viewer, newest first (section 2 matrix):
 * therapist sees all care-team notes; caseworker sees case notes, shared
 * progress notes, and their own drafts. Caller has already passed
 * requireClientAccess, so caseload membership is assumed.
 */
export async function listCareNotesForClient(
  clientId: number,
  viewer: NoteViewer,
  limit = 100
): Promise<CareNoteRow[]> {
  const visibility =
    viewer.role === 'therapist'
      ? ''
      : ` AND (note_type = 'case' OR shared_with_care_team = TRUE OR author_id = $3)`;
  const params: unknown[] =
    viewer.role === 'therapist' ? [clientId, limit] : [clientId, limit, viewer.userId];
  const result = await pool.query<CareNoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM care_notes
     WHERE client_id = $1${visibility}
     ORDER BY created_at DESC, note_id DESC
     LIMIT $2`,
    params
  );
  return result.rows;
}

/**
 * Update a draft's editable fields. Guarded to the author's own draft
 * (author_id AND status='draft'); returns the updated row or null when the
 * guard did not match (signed, amended, or someone else's note).
 * `caseNoteKind` distinguishes undefined (leave unchanged) from an explicit
 * null (clear the kind) — a COALESCE would silently swallow the clear.
 */
export async function updateCareNoteDraft(
  noteId: number,
  authorId: number,
  updates: { content?: Record<string, unknown>; caseNoteKind?: CaseNoteKind | null }
): Promise<CareNoteRow | null> {
  const setKind = updates.caseNoteKind !== undefined;
  const result = await pool.query<CareNoteRow>(
    `UPDATE care_notes
     SET content = COALESCE($3, content),
         case_note_kind = CASE WHEN $5::boolean THEN $4 ELSE case_note_kind END,
         updated_at = now()
     WHERE note_id = $1 AND author_id = $2 AND status = 'draft'
     RETURNING ${NOTE_COLUMNS}`,
    [
      noteId,
      authorId,
      updates.content === undefined ? null : JSON.stringify(updates.content),
      updates.caseNoteKind ?? null,
      setKind,
    ]
  );
  return result.rows[0] ?? null;
}

/** Delete the author's own draft. Returns true when a row was deleted. */
export async function deleteCareNoteDraft(noteId: number, authorId: number): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM care_notes WHERE note_id = $1 AND author_id = $2 AND status = 'draft'`,
    [noteId, authorId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Sign the author's own draft: stamps signed_at, computes the sign hash over
 * the canonical payload, and — when the note amends another — flips the
 * original to 'amended' in the same transaction. Returns the signed row, or
 * null when the note is not the author's signable draft (caller 409s).
 */
export async function signCareNote(noteId: number, authorId: number): Promise<CareNoteRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<CareNoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM care_notes
       WHERE note_id = $1 AND author_id = $2 AND status = 'draft'
       FOR UPDATE`,
      [noteId, authorId]
    );
    const note = locked.rows[0];
    if (!note) {
      await client.query('ROLLBACK');
      return null;
    }
    const signedAt = new Date().toISOString();
    const signHash = computeSignHash({ ...note, signed_at: signedAt });
    const updated = await client.query<CareNoteRow>(
      `UPDATE care_notes
       SET status = 'signed', signed_at = $3, sign_hash = $4, updated_at = now()
       WHERE note_id = $1 AND author_id = $2 AND status = 'draft'
       RETURNING ${NOTE_COLUMNS}`,
      [noteId, authorId, signedAt, signHash]
    );
    let signedRow = updated.rows[0] ?? null;
    if (note.amends_note_id !== null) {
      const flipped = await client.query<{ session_id: string | null }>(
        `UPDATE care_notes SET status = 'amended', updated_at = now()
         WHERE note_id = $1 AND status = 'signed'
         RETURNING session_id`,
        [note.amends_note_id]
      );
      // Carry the session linkage onto the now-live amendment. The amendment
      // draft is created with session_id NULL because the signed original
      // still holds the live-note slot in the partial unique index
      // (idx_care_notes_session_progress); once the original flips to
      // 'amended' it leaves that index, so the amendment can take over the
      // session_id — keeping getLiveProgressNoteForSession pointed at the
      // current note and blocking a duplicate re-seed from insights.
      const inheritedSessionId = flipped.rows[0]?.session_id ?? null;
      if (signedRow && signedRow.session_id == null && inheritedSessionId !== null) {
        const carried = await client.query<CareNoteRow>(
          `UPDATE care_notes SET session_id = $2 WHERE note_id = $1
           RETURNING ${NOTE_COLUMNS}`,
          [noteId, inheritedSessionId]
        );
        signedRow = carried.rows[0] ?? signedRow;
      }
    }
    await client.query('COMMIT');
    return signedRow;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Start an amendment: a new draft copying the signed note's content, linked
 * via amends_note_id. Returns null when the source note is not signed or the
 * author differs (only the author amends their own documentation in v1).
 * session_id is deliberately NULL on the draft: the signed original still
 * holds the live-note slot in idx_care_notes_session_progress, so the draft
 * cannot carry it without a unique violation. signCareNote transfers the
 * session_id to the amendment in the same transaction that flips the
 * original to 'amended', so the linkage is never lost.
 */
export async function createCareNoteAmendment(
  noteId: number,
  authorId: number
): Promise<CareNoteRow | null> {
  const result = await pool.query<CareNoteRow>(
    `INSERT INTO care_notes
       (org_id, client_id, author_id, author_name, author_role, note_type,
        case_note_kind, session_id, seed_source, seed_model, content, amends_note_id)
     SELECT org_id, client_id, author_id, author_name, author_role, note_type,
            case_note_kind, NULL, seed_source, seed_model, content, note_id
     FROM care_notes
     WHERE note_id = $1 AND author_id = $2 AND status = 'signed'
     RETURNING ${NOTE_COLUMNS}`,
    [noteId, authorId]
  );
  return result.rows[0] ?? null;
}

/** Toggle care-team sharing on the author's own progress note. */
export async function setCareNoteShared(
  noteId: number,
  authorId: number,
  shared: boolean
): Promise<CareNoteRow | null> {
  const result = await pool.query<CareNoteRow>(
    `UPDATE care_notes SET shared_with_care_team = $3, updated_at = now()
     WHERE note_id = $1 AND author_id = $2
     RETURNING ${NOTE_COLUMNS}`,
    [noteId, authorId, shared]
  );
  return result.rows[0] ?? null;
}

/** The live (non-amended) progress note for a session, or null. Backs the
 *  unique partial index idempotency of notes-from-insights seeding. */
export async function getLiveProgressNoteForSession(sessionId: string): Promise<CareNoteRow | null> {
  const result = await pool.query<CareNoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM care_notes
     WHERE session_id = $1 AND note_type = 'progress' AND status <> 'amended'
     LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] ?? null;
}

/** A client's most recent signed notes visible to the viewer (prep brief's
 *  recent-notes card). */
export async function getRecentSignedNotes(
  clientId: number,
  viewer: NoteViewer,
  limit = 3
): Promise<CareNoteRow[]> {
  const visibility =
    viewer.role === 'therapist'
      ? ''
      : ` AND (note_type = 'case' OR shared_with_care_team = TRUE OR author_id = $3)`;
  const params: unknown[] =
    viewer.role === 'therapist' ? [clientId, limit] : [clientId, limit, viewer.userId];
  const result = await pool.query<CareNoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM care_notes
     WHERE client_id = $1 AND status = 'signed'${visibility}
     ORDER BY signed_at DESC NULLS LAST, note_id DESC
     LIMIT $2`,
    params
  );
  return result.rows;
}
