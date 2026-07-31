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

export async function getWorksheetInstance(instanceId: number): Promise<WorksheetInstanceRow | null> {
  const result = await pool.query<WorksheetInstanceRow>(
    `SELECT instance_id, session_id, template_chunk_id, template_title, title, intro,
            sections, responses, status, promoted, created_at, completed_at
     FROM worksheet_instances WHERE instance_id = $1`,
    [instanceId],
  );
  return result.rows[0] ?? null;
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
