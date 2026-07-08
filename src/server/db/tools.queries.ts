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
}

/** Per-tool usage counts for the admin tools panel. */
export async function getToolInvocationStats(): Promise<ToolInvocationStats[]> {
  const result = await pool.query<{ tool_name: string; invocations: string; sessions: string; last_used: Date | null }>(
    `SELECT tool_name, COUNT(*) AS invocations,
            COUNT(DISTINCT session_id) AS sessions, MAX(created_at) AS last_used
     FROM tool_invocations
     GROUP BY tool_name
     ORDER BY COUNT(*) DESC`
  );
  return result.rows.map(r => ({
    tool_name: r.tool_name,
    invocations: parseInt(r.invocations, 10),
    sessions: parseInt(r.sessions, 10),
    last_used: r.last_used,
  }));
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
