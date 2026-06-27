// Data-access for the admin analytics dashboard. The dashboard is driven by a
// single large CTE query so every metric shares one consistent date/attribute
// filter; this module is the only place that query lives.
import { pool } from '../config/db.js';

// Parsed, validated filters for the analytics query (route does the parsing).
export interface AnalyticsFilters {
  startDate: string | null;
  endDate: string | null;
  voices: string[] | null;
  languages: string[] | null;
  sessionTypes: string[] | null;
  statuses: string[] | null;
  endedBy: string[] | null;
  crisisFlagged: boolean | null;
}

// One row of aggregated dashboard data; each field is a JSON blob the query
// builds. The route applies {}/[] defaults before responding.
export interface DashboardAnalyticsRow {
  metrics: unknown;
  breakdown: unknown;
  daily_trend: unknown;
  user_sessions: unknown;
  time_distribution: unknown;
  duration_distribution: unknown;
  duration_trend: unknown;
  language_distribution: unknown;
  voice_distribution: unknown;
  completion_patterns: unknown;
  abandonment_stats: unknown;
  session_depth: unknown;
  engagement_pace: unknown;
  response_times: unknown;
  turn_taking: unknown;
}

/** Compute every dashboard metric for the given filter set in one round-trip. */
export async function getDashboardAnalytics(f: AnalyticsFilters): Promise<DashboardAnalyticsRow> {
  const result = await pool.query<DashboardAnalyticsRow>(`
      WITH date_filtered_sessions AS (
        SELECT ts.*
        FROM therapy_sessions ts
        LEFT JOIN session_configurations sc ON ts.session_id = sc.session_id
        WHERE
          ($1::TIMESTAMP IS NULL OR ts.created_at >= $1)
          AND ($2::TIMESTAMP IS NULL OR ts.created_at <= $2)
          AND ($3::TEXT[] IS NULL OR sc.voice = ANY($3))
          AND ($4::TEXT[] IS NULL OR sc.language = ANY($4))
          AND ($5::TEXT[] IS NULL OR ts.session_type = ANY($5))
          AND ($6::TEXT[] IS NULL OR ts.status = ANY($6))
          AND ($7::TEXT[] IS NULL OR ts.ended_by = ANY($7))
          AND ($8::BOOLEAN IS NULL OR ts.crisis_flagged = $8)
      ),
      date_filtered_messages AS (
        SELECT m.* FROM messages m
        INNER JOIN date_filtered_sessions ts ON m.session_id = ts.session_id
      ),
      session_metrics AS (
        SELECT
          COUNT(DISTINCT ts.session_id) AS total_sessions,
          COUNT(DISTINCT ts.user_id) FILTER (WHERE ts.user_id IS NOT NULL) AS authenticated_sessions,
          COUNT(*) FILTER (WHERE ts.status = 'active') AS active_sessions,
          COUNT(*) FILTER (WHERE ts.status = 'ended') AS ended_sessions,
          AVG(EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at))) FILTER (WHERE ts.ended_at IS NOT NULL) AS avg_duration_seconds
        FROM date_filtered_sessions ts
      ),
      message_metrics AS (
        SELECT
          COUNT(*) AS total_messages,
          AVG(msg_count) AS avg_messages_per_session
        FROM (
          SELECT
            session_id,
            COUNT(*) AS msg_count
          FROM date_filtered_messages
          GROUP BY session_id
        ) AS session_msg_counts
      ),
      message_breakdown AS (
        SELECT
          COUNT(*) FILTER (WHERE message_type = 'voice') AS voice_messages,
          COUNT(*) FILTER (WHERE message_type = 'chat') AS chat_messages,
          COUNT(*) FILTER (WHERE role = 'user') AS user_messages,
          COUNT(*) FILTER (WHERE role = 'assistant') AS assistant_messages
        FROM date_filtered_messages
      ),
      daily_sessions AS (
        SELECT
          DATE(created_at) AS date,
          COUNT(*) AS session_count
        FROM date_filtered_sessions
        GROUP BY DATE(created_at)
        ORDER BY date DESC
        LIMIT 30
      ),
      user_session_counts AS (
        SELECT
          u.username,
          u.userid,
          COUNT(DISTINCT ts.session_id) AS session_count
        FROM users u
        LEFT JOIN date_filtered_sessions ts ON u.userid = ts.user_id
        WHERE ts.user_id IS NOT NULL
        GROUP BY u.userid, u.username
        ORDER BY session_count DESC
        LIMIT 50
      ),
      time_period_distribution AS (
        SELECT
          CASE
            WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Denver') >= 7
                 AND EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Denver') < 12
            THEN 'Morning'
            WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Denver') >= 12
                 AND EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Denver') < 17
            THEN 'Afternoon'
            ELSE 'Evening'
          END AS time_period,
          COUNT(*) AS session_count
        FROM date_filtered_sessions
        GROUP BY time_period
      ),
      duration_distribution AS (
        SELECT
          CASE
            WHEN EXTRACT(EPOCH FROM (ended_at - created_at)) < 300 THEN 'Short (0-5 min)'
            WHEN EXTRACT(EPOCH FROM (ended_at - created_at)) < 1800 THEN 'Medium (5-30 min)'
            ELSE 'Long (30+ min)'
          END AS duration_category,
          COUNT(*) AS session_count
        FROM date_filtered_sessions
        WHERE ended_at IS NOT NULL
        GROUP BY duration_category
      ),
      daily_duration AS (
        SELECT
          DATE(created_at) AS date,
          AVG(EXTRACT(EPOCH FROM (ended_at - created_at))) AS avg_duration_seconds
        FROM date_filtered_sessions
        WHERE ended_at IS NOT NULL
        GROUP BY DATE(created_at)
        ORDER BY date DESC
        LIMIT 30
      ),
      language_stats AS (
        SELECT
          sc.language,
          COUNT(*) AS session_count,
          ROUND(COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER (), 0), 2) AS percentage
        FROM session_configurations sc
        JOIN date_filtered_sessions ts ON sc.session_id = ts.session_id
        WHERE sc.language IS NOT NULL
        GROUP BY sc.language
        ORDER BY session_count DESC
      ),
      voice_stats AS (
        SELECT
          sc.voice,
          COUNT(*) AS session_count,
          ROUND(COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER (), 0), 2) AS percentage
        FROM session_configurations sc
        JOIN date_filtered_sessions ts ON sc.session_id = ts.session_id
        WHERE sc.voice IS NOT NULL
        GROUP BY sc.voice
        ORDER BY session_count DESC
      ),
      -- Session Completion Patterns
      completion_by_ended_by AS (
        SELECT
          COALESCE(ended_by, 'unknown') AS ended_by,
          COUNT(*) AS session_count,
          ROUND(COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER (), 0), 2) AS percentage
        FROM date_filtered_sessions
        WHERE status = 'ended'
        GROUP BY ended_by
      ),
      abandonment_rate AS (
        SELECT
          COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (ended_at - created_at)) < 60) AS abandoned_sessions,
          COUNT(*) FILTER (WHERE ended_at IS NOT NULL) AS completed_sessions,
          ROUND(
            COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (ended_at - created_at)) < 60) * 100.0 /
            NULLIF(COUNT(*) FILTER (WHERE ended_at IS NOT NULL), 0),
            2
          ) AS abandonment_rate_percentage
        FROM date_filtered_sessions
      ),
      session_depth_by_user_type AS (
        SELECT
          CASE
            WHEN ts.user_id IS NOT NULL THEN 'authenticated'
            ELSE 'anonymous'
          END AS user_type,
          AVG(msg_count) AS avg_messages,
          COUNT(*) AS session_count
        FROM (
          SELECT
            ts.session_id,
            ts.user_id,
            COUNT(m.message_id) AS msg_count
          FROM date_filtered_sessions ts
          LEFT JOIN messages m ON ts.session_id = m.session_id
          GROUP BY ts.session_id, ts.user_id
        ) ts
        GROUP BY user_type
      ),
      -- Engagement Metrics
      messages_per_minute AS (
        SELECT
          AVG(
            CASE
              WHEN EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) > 0
              THEN msg_count / (EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) / 60.0)
              ELSE 0
            END
          ) AS avg_messages_per_minute
        FROM (
          SELECT
            ts.session_id,
            ts.created_at,
            ts.ended_at,
            COUNT(m.message_id) AS msg_count
          FROM date_filtered_sessions ts
          LEFT JOIN messages m ON ts.session_id = m.session_id
          WHERE ts.ended_at IS NOT NULL
          GROUP BY ts.session_id, ts.created_at, ts.ended_at
        ) ts
      ),
      response_times AS (
        SELECT
          AVG(response_time_seconds) AS avg_response_time_seconds,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_time_seconds) AS median_response_time_seconds,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_seconds) AS p95_response_time_seconds
        FROM (
          SELECT
            EXTRACT(EPOCH FROM (assistant_msg.created_at - user_msg.created_at)) AS response_time_seconds
          FROM (
            SELECT
              session_id,
              created_at,
              ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at) AS msg_order
            FROM messages
            WHERE role = 'user'
          ) user_msg
          INNER JOIN (
            SELECT
              session_id,
              created_at,
              ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at) AS msg_order
            FROM messages
            WHERE role = 'assistant'
          ) assistant_msg
          ON user_msg.session_id = assistant_msg.session_id
          AND assistant_msg.msg_order = user_msg.msg_order + 1
          WHERE assistant_msg.created_at > user_msg.created_at
        ) response_times
      ),
      turn_taking_ratio AS (
        SELECT
          COUNT(*) FILTER (WHERE role = 'user')::DECIMAL /
          NULLIF(COUNT(*) FILTER (WHERE role = 'assistant'), 0) AS user_to_assistant_ratio,
          COUNT(*) FILTER (WHERE role = 'user') AS total_user_messages,
          COUNT(*) FILTER (WHERE role = 'assistant') AS total_assistant_messages
        FROM date_filtered_messages
      )
      SELECT
        (SELECT row_to_json(sm.*) FROM (SELECT sm.*, mm.total_messages, mm.avg_messages_per_session FROM session_metrics sm, message_metrics mm) sm) AS metrics,
        (SELECT row_to_json(message_breakdown.*) FROM message_breakdown) AS breakdown,
        (SELECT json_agg(daily_sessions.*) FROM daily_sessions) AS daily_trend,
        (SELECT json_agg(user_session_counts.*) FROM user_session_counts) AS user_sessions,
        (SELECT json_agg(time_period_distribution.*) FROM time_period_distribution) AS time_distribution,
        (SELECT json_agg(duration_distribution.*) FROM duration_distribution) AS duration_distribution,
        (SELECT json_agg(daily_duration.*) FROM daily_duration) AS duration_trend,
        (SELECT json_agg(language_stats.*) FROM language_stats) AS language_distribution,
        (SELECT json_agg(voice_stats.*) FROM voice_stats) AS voice_distribution,
        (SELECT json_agg(completion_by_ended_by.*) FROM completion_by_ended_by) AS completion_patterns,
        (SELECT row_to_json(abandonment_rate.*) FROM abandonment_rate) AS abandonment_stats,
        (SELECT json_agg(session_depth_by_user_type.*) FROM session_depth_by_user_type) AS session_depth,
        (SELECT row_to_json(messages_per_minute.*) FROM messages_per_minute) AS engagement_pace,
        (SELECT row_to_json(response_times.*) FROM response_times) AS response_times,
        (SELECT row_to_json(turn_taking_ratio.*) FROM turn_taking_ratio) AS turn_taking
    `, [
    f.startDate,        // $1
    f.endDate,          // $2
    f.voices,           // $3
    f.languages,        // $4
    f.sessionTypes,     // $5
    f.statuses,         // $6
    f.endedBy,          // $7
    f.crisisFlagged,    // $8
  ]);

  return result.rows[0];
}
