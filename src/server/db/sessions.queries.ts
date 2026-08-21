// Data-access for therapy sessions and their configuration: lifecycle CRUD,
// ownership/status read checks, and the session_configurations upsert/read.
import { pool } from '../config/db.js';

export interface SessionRow {
  session_id: string;
  user_id: number | null;
  session_name: string | null;
  status: string;
  session_type: string;
  created_at: Date;
  updated_at: Date;
  ended_at: Date | null;
  ended_by: string | null;
  crisis_flagged?: boolean;
  crisis_severity?: string | null;
  crisis_risk_score?: number | null;
  crisis_flagged_at?: Date | null;
  crisis_flagged_by?: string | null;
  openai_call_id?: string | null;
  sideband_connected?: boolean;
  sideband_connected_at?: Date | null;
  sideband_disconnected_at?: Date | null;
  sideband_error?: string | null;
}

export interface CreateSessionConfig {
  sessionId: string;
  userId?: number | null;
  sessionName?: string | null;
  status?: string;
  sessionType?: string;
  isDemo?: boolean;
}

export interface SessionConfigRow {
  session_id: string;
  voice: string | null;
  modalities: string[] | null;
  instructions: string | null;
  turn_detection: Record<string, unknown> | null;
  tools: unknown[] | null;
  temperature: number | null;
  max_response_output_tokens: number | null;
  language: string | null;
  modality: string | null;
  ai_model: string | null;
  transcription_model: string | null;
  theme: string | null;
  proactive_offering: boolean | null;
}

export interface UpsertSessionConfigInput {
  voice?: string;
  modalities?: string[];
  instructions?: string | null;
  turn_detection?: Record<string, unknown> | null;
  tools?: unknown[] | null;
  temperature?: number;
  max_response_output_tokens?: number;
  language?: string;
  /** Therapeutic modality preset active when instructions were assembled. */
  modality?: string | null;
  /** Exact realtime model used (resolved snapshot when known, else the configured alias). */
  ai_model?: string | null;
  /** Exact input-audio transcription model used. */
  transcription_model?: string | null;
  /** UI theme active at session start ('default', 'sage', 'ocean', 'dusk', 'dark'). */
  theme?: string | null;
  /** ai-therapist-74 A/B condition resolved for this session; null = not evaluated. */
  proactive_offering?: boolean | null;
}

export interface SessionAccessInfo {
  status: string;
  user_id: number | string | null;
  session_type: string;
}

/**
 * Create a therapy session. Accepts either a config object (preferred) or the
 * legacy (userId, sessionName) parameter form.
 */
export async function createSession(userId: number | CreateSessionConfig | null = null, sessionName: string | null = null): Promise<SessionRow> {
  if (typeof userId === 'object' && userId !== null) {
    const config = userId as CreateSessionConfig;
    const result = await pool.query<SessionRow>(
      `INSERT INTO therapy_sessions (session_id, user_id, session_name, status, session_type, is_demo, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        config.sessionId,
        config.userId || null,
        config.sessionName || null,
        config.status || 'active',
        config.sessionType || 'realtime',
        config.isDemo ?? false
      ]
    );
    return result.rows[0];
  } else {
    const result = await pool.query<SessionRow>(
      `INSERT INTO therapy_sessions (user_id, session_name, status, created_at, updated_at)
       VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [userId, sessionName]
    );
    return result.rows[0];
  }
}

/** Get a session by id, or null. */
export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const result = await pool.query<SessionRow>(
    'SELECT * FROM therapy_sessions WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] || null;
}

/** The user's most recent active session, or null (idempotency checks). */
export async function getActiveSessionForUser(userId: number | string): Promise<SessionRow | null> {
  if (!userId) return null;

  const result = await pool.query<SessionRow>(
    `SELECT * FROM therapy_sessions
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

/** All of a user's sessions, optionally filtered by status, newest first. */
export async function getUserSessions(userId: number | string, status: string | null = null): Promise<SessionRow[]> {
  const query = status
    ? 'SELECT * FROM therapy_sessions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC'
    : 'SELECT * FROM therapy_sessions WHERE user_id = $1 ORDER BY created_at DESC';

  const params = status ? [userId, status] : [userId];
  const result = await pool.query<SessionRow>(query, params);
  return result.rows;
}

/** Paginated admin view of all sessions with username + message counts.
 *  When scopeTherapistId is set (caseload RBAC, ai-therapist-119), rows are
 *  restricted to that therapist's assigned clients; null/undefined = unscoped
 *  (researchers), preserving today's SQL exactly. */
export async function getAllSessions(limit = 50, offset = 0, scopeTherapistId?: number | null): Promise<Array<SessionRow & { username?: string; message_count?: string }>> {
  const scoped = scopeTherapistId !== null && scopeTherapistId !== undefined;
  const scopeClause = scoped
    ? `
     WHERE EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $3 AND tc.client_id = ts.user_id)`
    : '';
  const params: unknown[] = scoped ? [limit, offset, scopeTherapistId] : [limit, offset];
  const result = await pool.query<SessionRow & { username?: string; message_count?: string }>(
    `SELECT
      ts.*,
      u.username,
      COUNT(m.message_id) as message_count
     FROM therapy_sessions ts
     LEFT JOIN users u ON ts.user_id = u.userid
     LEFT JOIN messages m ON ts.session_id = m.session_id${scopeClause}
     GROUP BY ts.session_id, u.username
     ORDER BY ts.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );
  return result.rows;
}

/** Update a session's status (idempotent); stamps ended_at/by when ending. */
export async function updateSessionStatus(sessionId: string, status: string, endedBy: string | null = null): Promise<SessionRow> {
  const currentSession = await getSession(sessionId);
  if (!currentSession) {
    throw new Error('Session not found');
  }

  // Already in the target status — return as-is (idempotent).
  if (currentSession.status === status) {
    return currentSession;
  }

  const result = await pool.query<SessionRow>(
    `UPDATE therapy_sessions
     SET status = $1,
         updated_at = CURRENT_TIMESTAMP,
         ended_at = ${status === 'ended' ? "CURRENT_TIMESTAMP" : 'ended_at'},
         ended_by = ${status === 'ended' && endedBy ? '$3' : 'ended_by'}
     WHERE session_id = $2
     RETURNING *`,
    status === 'ended' && endedBy ? [status, sessionId, endedBy] : [status, sessionId]
  );
  return result.rows[0];
}

/** Set a session's name (typically auto-generated after it ends). */
export async function updateSessionName(sessionId: string, sessionName: string): Promise<SessionRow> {
  const result = await pool.query<SessionRow>(
    `UPDATE therapy_sessions
     SET session_name = $1, updated_at = CURRENT_TIMESTAMP
     WHERE session_id = $2
     RETURNING *`,
    [sessionName, sessionId]
  );
  return result.rows[0];
}

/** Delete a session and all its messages/config in one transaction. */
export async function deleteSession(sessionId: string): Promise<SessionRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sessionResult = await client.query<SessionRow>(
      'SELECT * FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {
      throw new Error('Session not found');
    }

    const session = sessionResult.rows[0];

    await client.query('DELETE FROM messages WHERE session_id = $1', [sessionId]);
    await client.query('DELETE FROM session_configurations WHERE session_id = $1', [sessionId]);
    await client.query('DELETE FROM therapy_sessions WHERE session_id = $1', [sessionId]);

    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Create or update a session's realtime configuration. */
export async function upsertSessionConfig(sessionId: string, config: UpsertSessionConfigInput): Promise<SessionConfigRow> {
  const {
    voice = 'alloy',
    modalities = ['text', 'audio'],
    instructions = null,
    turn_detection = null,
    tools = null,
    temperature = 0.8,
    max_response_output_tokens = 4096,
    language = 'en',
    modality = null,
    ai_model = null,
    transcription_model = null,
    theme = 'default',
    proactive_offering = null
  } = config;

  // JSONB fields: stringify when present, otherwise pass null.
  const turnDetectionJson = turn_detection ? JSON.stringify(turn_detection) : null;
  const toolsJson = tools ? JSON.stringify(tools) : null;

  const result = await pool.query<SessionConfigRow>(
    `INSERT INTO session_configurations
     (session_id, voice, modalities, instructions, turn_detection, tools, temperature, max_response_output_tokens, language, modality, ai_model, transcription_model, theme, proactive_offering)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (session_id)
     DO UPDATE SET
       voice = EXCLUDED.voice,
       modalities = EXCLUDED.modalities,
       instructions = EXCLUDED.instructions,
       turn_detection = EXCLUDED.turn_detection,
       tools = EXCLUDED.tools,
       temperature = EXCLUDED.temperature,
       max_response_output_tokens = EXCLUDED.max_response_output_tokens,
       language = EXCLUDED.language,
       modality = EXCLUDED.modality,
       -- Model stamps record what the session was CREATED with; a later upsert
       -- with no model info (e.g. the /logs/batch lazy default) must not wipe
       -- them.
       ai_model = COALESCE(EXCLUDED.ai_model, session_configurations.ai_model),
       transcription_model = COALESCE(EXCLUDED.transcription_model, session_configurations.transcription_model),
       theme = EXCLUDED.theme,
       proactive_offering = EXCLUDED.proactive_offering
     RETURNING *`,
    [sessionId, voice, modalities, instructions, turnDetectionJson, toolsJson, temperature, max_response_output_tokens, language, modality, ai_model, transcription_model, theme, proactive_offering]
  );
  return result.rows[0];
}

/** A session's realtime configuration, or null. */
export async function getSessionConfig(sessionId: string): Promise<SessionConfigRow | null> {
  const result = await pool.query<SessionConfigRow>(
    'SELECT * FROM session_configurations WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] || null;
}

/** Status / owner / type for a session, or null if it doesn't exist. */
export async function getSessionAccessInfo(sessionId: string): Promise<SessionAccessInfo | null> {
  const result = await pool.query<SessionAccessInfo>(
    'SELECT status, user_id, session_type FROM therapy_sessions WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] ?? null;
}

/** Attach the OpenAI realtime call id to a session (used by register-call). */
export async function setSessionCallId(sessionId: string, callId: string): Promise<void> {
  await pool.query(
    'UPDATE therapy_sessions SET openai_call_id = $1 WHERE session_id = $2',
    [callId, sessionId]
  );
}

/** Create an active realtime session for the OpenAI-issued id (no-op if it exists). */
export async function createActiveRealtimeSession(
  sessionId: string,
  userId: number | string | null,
  isDemo = false
): Promise<void> {
  await pool.query(
    `INSERT INTO therapy_sessions (session_id, user_id, status, is_demo, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, userId, isDemo]
  );
}

/**
 * Whether a session belongs to a magic-link demo account. Used to keep demo
 * activity out of the real crisis-alert/SMS pipeline. Missing sessions count as
 * non-demo (fail safe toward normal processing).
 */
export async function getSessionIsDemo(sessionId: string): Promise<boolean> {
  const result = await pool.query<{ is_demo: boolean }>(
    'SELECT is_demo FROM therapy_sessions WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0]?.is_demo ?? false;
}

/**
 * Whether a session belongs to a magic-link DEMO account (users.role='demo').
 * Distinct from is_demo on the session row: the eval harness's sessions are
 * is_demo-marked so analytics/exports exclude them, but they must still
 * exercise the REAL safety pipelines (crisis, minor gate) — that's what the
 * evals assert. Behavioral skips (no scoring/flags/pages for demo viewers)
 * key on this, not on the analytics flag. Anonymous sessions → false.
 */
export async function isDemoAccountSession(sessionId: string): Promise<boolean> {
  const result = await pool.query<{ role: string | null }>(
    `SELECT u.role FROM therapy_sessions ts
     LEFT JOIN users u ON u.userid = ts.user_id
     WHERE ts.session_id = $1`,
    [sessionId]
  );
  return result.rows[0]?.role === 'demo';
}
