// Tool-invocation analytics (ai-therapist-32): one row per model tool call,
// stamped with the session's risk score at invocation time.
import { pool } from '../config/db.js';

export async function insertToolInvocation(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown> | null,
  success: boolean
): Promise<void> {
  await pool.query(
    `INSERT INTO tool_invocations (session_id, tool_name, arguments, success, risk_score_at)
     VALUES ($1, $2, $3, $4,
       (SELECT risk_score FROM risk_score_history
        WHERE session_id = $1 ORDER BY calculated_at DESC LIMIT 1))`,
    [sessionId, toolName, args ? JSON.stringify(args) : null, success]
  );
}

export interface ToolInvocationStats {
  tool_name: string;
  invocations: number;
  sessions: number;
  last_used: Date | null;
  failures: number;
  failure_rate: number;
}

/** Per-tool usage counts for the admin tools panel (ai-therapist-75: now
 *  includes failure/misfire counts alongside frequency). */
export async function getToolInvocationStats(): Promise<ToolInvocationStats[]> {
  const result = await pool.query<{
    tool_name: string; invocations: string; sessions: string; last_used: Date | null; failures: string;
  }>(
    `SELECT tool_name, COUNT(*) AS invocations,
            COUNT(DISTINCT session_id) AS sessions, MAX(created_at) AS last_used,
            COUNT(*) FILTER (WHERE success IS FALSE) AS failures
     FROM tool_invocations
     GROUP BY tool_name
     ORDER BY COUNT(*) DESC`
  );
  return result.rows.map(r => {
    const invocations = parseInt(r.invocations, 10);
    const failures = parseInt(r.failures, 10);
    return {
      tool_name: r.tool_name,
      invocations,
      sessions: parseInt(r.sessions, 10),
      last_used: r.last_used,
      failures,
      failure_rate: invocations > 0 ? Math.round((failures / invocations) * 1000) / 10 : 0,
    };
  });
}

export interface ToolsPerSessionBucket {
  distinct_tool_count: number;
  session_count: number;
}

/** Histogram of how many distinct tools were used per session that used at
 *  least one tool (ai-therapist-75). Sessions that never called a tool are
 *  intentionally excluded — the caller can subtract from total session count
 *  to get the zero-tool bucket. */
export async function getToolsPerSessionDistribution(): Promise<ToolsPerSessionBucket[]> {
  const result = await pool.query<{ distinct_tool_count: string; session_count: string }>(
    `SELECT distinct_tool_count, COUNT(*) AS session_count
     FROM (
       SELECT session_id, COUNT(DISTINCT tool_name) AS distinct_tool_count
       FROM tool_invocations
       GROUP BY session_id
     ) per_session
     GROUP BY distinct_tool_count
     ORDER BY distinct_tool_count`
  );
  return result.rows.map(r => ({
    distinct_tool_count: parseInt(r.distinct_tool_count, 10),
    session_count: parseInt(r.session_count, 10),
  }));
}

/** Total sessions and how many of them invoked at least one tool — lets the
 *  UI derive the "0 tools used" bucket alongside getToolsPerSessionDistribution. */
export async function getToolUsageSessionCounts(): Promise<{ total_sessions: number; sessions_with_tool_use: number }> {
  const result = await pool.query<{ total_sessions: string; sessions_with_tool_use: string }>(
    `SELECT
       (SELECT COUNT(*) FROM therapy_sessions WHERE is_demo IS NOT TRUE) AS total_sessions,
       (SELECT COUNT(DISTINCT session_id) FROM tool_invocations) AS sessions_with_tool_use`
  );
  const row = result.rows[0];
  return {
    total_sessions: parseInt(row?.total_sessions ?? '0', 10),
    sessions_with_tool_use: parseInt(row?.sessions_with_tool_use ?? '0', 10),
  };
}

/** The model-set goal for a session (set_session_goal / recall_session_goal). */
export async function setSessionGoal(sessionId: string, goal: string): Promise<void> {
  await pool.query(
    'UPDATE therapy_sessions SET session_goal = $2 WHERE session_id = $1',
    [sessionId, goal]
  );
}

export async function getSessionGoal(sessionId: string): Promise<string | null> {
  const result = await pool.query<{ session_goal: string | null }>(
    'SELECT session_goal FROM therapy_sessions WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0]?.session_goal ?? null;
}

// ---------- Wave 2: safety plans, user memories, scale responses ----------

export interface SafetyPlan {
  warning_signs?: string[];
  coping_strategies?: string[];
  support_contacts?: string[];
  reasons_worth_living?: string[];
  professional_resources?: string[];
}

export async function insertSafetyPlan(
  sessionId: string,
  userId: number | null,
  plan: SafetyPlan
): Promise<void> {
  await pool.query(
    'INSERT INTO safety_plans (session_id, user_id, plan) VALUES ($1, $2, $3)',
    [sessionId, userId, JSON.stringify(plan)]
  );
}

export async function getSessionSafetyPlan(sessionId: string): Promise<{ plan: SafetyPlan; created_at: Date } | null> {
  const result = await pool.query<{ plan: SafetyPlan; created_at: Date }>(
    'SELECT plan, created_at FROM safety_plans WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1',
    [sessionId]
  );
  return result.rows[0] ?? null;
}

/** Facts the participant explicitly asked the AI to remember (remember_this).
 *  The optional embedding powers semantic recall (recall_relevant_history);
 *  passing undefined stores the fact without an embedding (still listable). */
export async function insertUserMemory(
  userId: number,
  fact: string,
  sessionId: string | null,
  embedding?: number[],
): Promise<void> {
  const vec = embedding ? `[${embedding.join(',')}]` : null;
  await pool.query(
    'INSERT INTO user_memories (user_id, fact, session_id, embedding) VALUES ($1, $2, $3, $4::vector)',
    [userId, fact, sessionId, vec]
  );
}

export async function getUserMemories(userId: number, limit = 10): Promise<string[]> {
  const result = await pool.query<{ fact: string }>(
    'SELECT fact FROM user_memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit]
  );
  return result.rows.map(r => r.fact);
}

export interface UserMemoryFact {
  fact: string;
  session_id: string | null;
  created_at: Date;
}

/** Same rows as getUserMemories but with provenance (when/where each fact was stored). */
export async function getUserMemoriesWithDates(userId: number, limit = 10): Promise<UserMemoryFact[]> {
  const result = await pool.query<UserMemoryFact>(
    'SELECT fact, session_id, created_at FROM user_memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit]
  );
  return result.rows;
}

export interface RelevantMemory {
  fact: string;
  created_at: Date;
  similarity: number;
}

/** Cosine-nearest embedded memories belonging to one user (recall_relevant_history). */
export async function searchUserMemories(
  userId: number,
  embedding: number[],
  limit: number,
): Promise<RelevantMemory[]> {
  const vec = `[${embedding.join(',')}]`;
  const result = await pool.query<RelevantMemory>(
    `SELECT fact, created_at, 1 - (embedding <=> $2::vector) AS similarity
     FROM user_memories
     WHERE user_id = $1 AND embedding IS NOT NULL
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [userId, vec, limit]
  );
  return result.rows;
}

export async function insertScaleResponse(
  sessionId: string,
  scale: string,
  answers: number[],
  score: number
): Promise<void> {
  await pool.query(
    'INSERT INTO scale_responses (session_id, scale, answers, score) VALUES ($1, $2, $3, $4)',
    [sessionId, scale, JSON.stringify(answers), score]
  );
}

export interface ScaleResponseRow {
  scale: string;
  answers: number[];
  score: number;
  created_at: Date;
}

export async function getSessionScaleResponses(sessionId: string): Promise<ScaleResponseRow[]> {
  const result = await pool.query<ScaleResponseRow>(
    'SELECT scale, answers, score, created_at FROM scale_responses WHERE session_id = $1 ORDER BY created_at',
    [sessionId]
  );
  return result.rows;
}
