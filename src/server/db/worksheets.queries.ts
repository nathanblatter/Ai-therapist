// Personalized worksheet instances (ai-therapist-73): the model fills a
// vetted worksheet TEMPLATE's structure (from knowledge_chunks kind='worksheet')
// with participant-specific wording via the create_custom_worksheet tool.
// Stored for researcher review and possible promotion into the vetted corpus.
import { pool } from '../config/db.js';

export type WorksheetSectionType = 'text' | 'textarea' | 'scale';

export interface WorksheetSection {
  type: WorksheetSectionType;
  label: string;
  placeholder?: string;
}

export interface WorksheetInstanceInput {
  sessionId: string;
  templateChunkId: number | null;
  templateTitle: string | null;
  title: string;
  intro: string | null;
  sections: WorksheetSection[];
}

export interface WorksheetInstanceRow {
  instance_id: number;
  session_id: string;
  template_chunk_id: number | null;
  template_title: string | null;
  title: string;
  intro: string | null;
  sections: WorksheetSection[];
  responses: Record<string, string> | null;
  status: 'draft' | 'completed';
  promoted: boolean;
  created_at: Date;
  completed_at: Date | null;
}

export type WorksheetReviewStatus = 'pending' | 'promoted' | 'rejected';

export async function insertWorksheetInstance(input: WorksheetInstanceInput): Promise<number> {
  const result = await pool.query<{ instance_id: number }>(
    `INSERT INTO worksheet_instances
       (session_id, template_chunk_id, template_title, title, intro, sections)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING instance_id`,
    [
      input.sessionId,
      input.templateChunkId,
      input.templateTitle,
      input.title,
      input.intro,
      JSON.stringify(input.sections),
    ],
  );
  return result.rows[0].instance_id;
}

/** Record the participant's completed answers. Returns false if the instance doesn't exist. */
export async function completeWorksheetInstance(
  instanceId: number,
  sessionId: string,
  responses: Record<string, string>,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE worksheet_instances
     SET responses = $3::jsonb, status = 'completed', completed_at = CURRENT_TIMESTAMP
     WHERE instance_id = $1 AND session_id = $2`,
    [instanceId, sessionId, JSON.stringify(responses)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Most recent still-open (draft) worksheet instance for a session. The client
 *  never receives the instance_id the server generated (it renders straight
 *  from the model's function-call args, same as the other overlay tools), so
 *  the completion round-trip resolves the instance by recency instead. Only
 *  one worksheet is realistically open at a time per session. */
export async function getLatestDraftWorksheetInstance(sessionId: string): Promise<{ instance_id: number } | null> {
  const result = await pool.query<{ instance_id: number }>(
    `SELECT instance_id FROM worksheet_instances
     WHERE session_id = $1 AND status = 'draft'
     ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

// ---- Researcher review queue (ai-therapist-89, migration 113) ----
//
// A completed instance waits with review_status='pending' until a researcher
// promotes its de-personalised template into knowledge_chunks or rejects it.
// The queue list carries no participant content; the detail read does (the
// route logs it as a 'worksheet_review' data access).

/** Queue row: structure and a pseudo-reference (session id + participant
 *  user id, never a username), no answers. */
export interface WorksheetReviewQueueRow {
  instance_id: number;
  session_id: string;
  user_id: number | null;
  template_chunk_id: number | null;
  template_title: string | null;
  title: string;
  section_count: number;
  created_at: Date;
  completed_at: Date | null;
}

export async function listWorksheetInstancesForReview(
  page: { limit?: number; offset?: number } = {},
): Promise<{ rows: WorksheetReviewQueueRow[]; total: number }> {
  const limit = Math.min(Math.max(page.limit ?? 50, 1), 200);
  const offset = Math.max(page.offset ?? 0, 0);
  const result = await pool.query<WorksheetReviewQueueRow & { total_count: string | number }>(
    `SELECT w.instance_id, w.session_id, ts.user_id, w.template_chunk_id, w.template_title, w.title,
            jsonb_array_length(w.sections)::int AS section_count,
            w.created_at, w.completed_at,
            COUNT(*) OVER() AS total_count
     FROM worksheet_instances w
     LEFT JOIN therapy_sessions ts ON ts.session_id::text = w.session_id
     WHERE w.status = 'completed' AND w.review_status = 'pending'
     ORDER BY w.completed_at DESC NULLS LAST, w.instance_id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const total = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
  return { rows: result.rows.map(({ total_count: _ignored, ...row }) => row), total };
}

/** Everything the reviewer sees for one instance: the filled worksheet plus
 *  the vetted template it was generated from (content + metadata), so the
 *  stripped template can carry the rationale forward. */
export interface WorksheetReviewDetail extends WorksheetInstanceRow {
  user_id: number | null;
  review_status: WorksheetReviewStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  promoted_chunk_id: number | null;
  template_content: string | null;
  template_topic: string | null;
  template_metadata: Record<string, unknown> | null;
}

export async function getWorksheetInstanceForReview(instanceId: number): Promise<WorksheetReviewDetail | null> {
  const result = await pool.query<WorksheetReviewDetail>(
    `SELECT w.instance_id, w.session_id, ts.user_id, w.template_chunk_id, w.template_title, w.title, w.intro,
            w.sections, w.responses, w.status, w.promoted, w.created_at, w.completed_at,
            w.review_status, w.reviewed_by, w.reviewed_at, w.review_note, w.promoted_chunk_id,
            kc.content AS template_content, kc.topic AS template_topic, kc.metadata AS template_metadata
     FROM worksheet_instances w
     LEFT JOIN therapy_sessions ts ON ts.session_id::text = w.session_id
     LEFT JOIN knowledge_chunks kc ON kc.chunk_id = w.template_chunk_id
     WHERE w.instance_id = $1`,
    [instanceId],
  );
  return result.rows[0] ?? null;
}

/** Reject a pending completed instance. Returns false when it does not
 *  exist or is no longer pending (already promoted/rejected). */
export async function markWorksheetRejected(
  instanceId: number,
  reviewer: string,
  note: string | null,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE worksheet_instances
     SET review_status = 'rejected', reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, review_note = $3
     WHERE instance_id = $1 AND status = 'completed' AND review_status = 'pending'`,
    [instanceId, reviewer, note],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface PromoteWorksheetInput {
  instanceId: number;
  reviewer: string;
  note: string | null;
  /** Reviewer-confirmed, de-personalised template (see utils/worksheetTemplate). */
  title: string;
  content: string;
  content_hash: string;
  embedding: number[];
  topic: string | null;
  /** Non-provenance metadata carried onto the chunk (section structure, render tool). */
  metadata: Record<string, unknown>;
  /** Stored under metadata.provenance.template_kind. */
  template_kind: string;
}

export type PromoteWorksheetResult =
  | { outcome: 'promoted'; chunk_id: number }
  | { outcome: 'already_promoted'; chunk_id: number }
  | { outcome: 'not_pending' }
  | { outcome: 'duplicate_content' };

/**
 * Promote one instance's template into knowledge_chunks (kind='worksheet',
 * source='worksheet_promotion', pending approval like every other new chunk)
 * and mark the instance promoted, in one transaction. Idempotent per
 * instance: a second call returns the chunk already linked. Identical
 * template text elsewhere in the corpus (UNIQUE content_hash) is refused
 * rather than silently re-pointed at the other chunk.
 */
export async function promoteWorksheetToKnowledgeChunk(input: PromoteWorksheetInput): Promise<PromoteWorksheetResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ status: string; review_status: string; promoted_chunk_id: number | null }>(
      `SELECT status, review_status, promoted_chunk_id FROM worksheet_instances WHERE instance_id = $1 FOR UPDATE`,
      [input.instanceId],
    );
    const row = current.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { outcome: 'not_pending' };
    }
    if (row.promoted_chunk_id !== null && row.review_status === 'promoted') {
      await client.query('ROLLBACK');
      return { outcome: 'already_promoted', chunk_id: Number(row.promoted_chunk_id) };
    }
    if (row.status !== 'completed' || row.review_status !== 'pending') {
      await client.query('ROLLBACK');
      return { outcome: 'not_pending' };
    }

    const promotedAt = new Date().toISOString();
    const metadata = {
      ...input.metadata,
      provenance: {
        worksheet_instance_id: input.instanceId,
        reviewer: input.reviewer,
        promoted_at: promotedAt,
        template_kind: input.template_kind,
      },
    };
    const inserted = await client.query<{ chunk_id: number }>(
      `INSERT INTO knowledge_chunks
         (topic, title, content, source, source_url, license, kind, modality, metadata, content_hash, embedding, active)
       VALUES ($1, $2, $3, 'worksheet_promotion', NULL, NULL, 'worksheet', NULL, $4, $5, $6::vector, FALSE)
       ON CONFLICT (content_hash) DO NOTHING
       RETURNING chunk_id`,
      [
        input.topic,
        input.title,
        input.content,
        JSON.stringify(metadata),
        input.content_hash,
        `[${input.embedding.join(',')}]`,
      ],
    );
    const chunkId = inserted.rows[0]?.chunk_id;
    if (chunkId === undefined) {
      await client.query('ROLLBACK');
      return { outcome: 'duplicate_content' };
    }
    await client.query(
      `UPDATE worksheet_instances
       SET review_status = 'promoted', promoted = TRUE, promoted_chunk_id = $2,
           reviewed_by = $3, reviewed_at = $4::timestamptz, review_note = $5
       WHERE instance_id = $1`,
      [input.instanceId, chunkId, input.reviewer, promotedAt, input.note],
    );
    await client.query('COMMIT');
    return { outcome: 'promoted', chunk_id: Number(chunkId) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
