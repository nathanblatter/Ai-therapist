// Product funnel (pass-3 telemetry): consent/start -> connected -> first user
// turn -> tool use -> graceful end, derived entirely from existing tables
// (therapy_sessions, messages, tool_invocations) — no new event writes.
//
// Stage definitions:
// - created:          a therapy_sessions row exists (participant accepted
//                     consent and hit Start; both flows create the row).
// - with_checkin:     the pre-session check-in was submitted (checkin JSONB).
// - connected:        the pipeline actually attached — realtime sessions with
//                     a sideband/call id, or any chat session (chat is live
//                     once /api/chat/start returns).
// - with_user_turn:   at least one user-role message was logged.
// - with_tool_use:    at least one tool invocation.
// - ended_gracefully: session ended with an ended_by attribution and lasted
//                     >= 60s — mirrors the abandonment definition in
//                     analytics.queries.ts (ended within 60s == abandoned).
import { pool } from '../config/db.js';

export interface FunnelCounts {
  created: number;
  with_checkin: number;
  connected: number;
  with_user_turn: number;
  with_tool_use: number;
  ended_gracefully: number;
}

export async function getFunnel(days: number): Promise<FunnelCounts> {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS created,
       COUNT(*) FILTER (WHERE s.checkin IS NOT NULL)::int AS with_checkin,
       COUNT(*) FILTER (
         WHERE s.session_type = 'chat'
            OR s.sideband_connected_at IS NOT NULL
            OR s.openai_call_id IS NOT NULL
       )::int AS connected,
       COUNT(*) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM messages m
           WHERE m.session_id = s.session_id AND m.role = 'user'
         )
       )::int AS with_user_turn,
       COUNT(*) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM tool_invocations ti
           WHERE ti.session_id = s.session_id
         )
       )::int AS with_tool_use,
       COUNT(*) FILTER (
         WHERE s.ended_by IS NOT NULL
           AND s.ended_at IS NOT NULL
           AND EXTRACT(EPOCH FROM (s.ended_at - s.created_at)) >= 60
       )::int AS ended_gracefully
     FROM therapy_sessions s
     WHERE s.created_at >= NOW() - make_interval(days => $1)
       AND s.is_demo IS NOT TRUE`,
    [days]
  );
  const row = result.rows[0] ?? {};
  return {
    created: row.created ?? 0,
    with_checkin: row.with_checkin ?? 0,
    connected: row.connected ?? 0,
    with_user_turn: row.with_user_turn ?? 0,
    with_tool_use: row.with_tool_use ?? 0,
    ended_gracefully: row.ended_gracefully ?? 0,
  };
}
