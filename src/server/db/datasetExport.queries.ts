// Data-access for the de-identified research dataset export (ai-therapist-96).
// Part of the db/ layer: the only place the research_pseudonyms mapping is
// written, and the source of every SELECT that feeds the exported CSVs.
//
// Determinism contract (see spec §3.7): pseudonyms are assigned once and never
// change (INSERT-only, guarded by an advisory lock); every export query has a
// total ORDER BY; timestamps are rendered as ISO-8601 UTC; floats are rounded
// with fixed precision; no volatile columns (now(), random()) appear in row
// data. Given the same `asOf` and unchanged source rows, output is byte-stable.
//
// The research_pseudonyms table itself is NEVER selected into any artifact.
import { pool } from '../config/db.js';

// Every export row is a flat string/number/bool/null map keyed by column name.
export type DatasetRow = Record<string, unknown>;

// ISO-8601 UTC render used by every timestamp column.
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;
const tsUtc = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', ${ISO_UTC})`;

/**
 * Assign a stable pseudonym to every not-yet-mapped participant and session
 * that is in scope for `asOf`. INSERT-only and idempotent: a second call with
 * the same (or later) asOf adds nothing for already-mapped entities, so
 * pseudonyms are permanent. Runs in one transaction under a stable advisory
 * lock so concurrent exports can't race the sequence.
 */
export async function ensurePseudonyms(asOf: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize pseudonym allocation across concurrent export runs.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('research_pseudonyms'))`);

    // Participants: role='participant', non-demo, with >=1 in-scope session and
    // no existing mapping. Numbered P001.. in (created_at, userid) order,
    // continuing from the current max sequence.
    await client.query(
      `INSERT INTO research_pseudonyms (entity_type, entity_key, pseudonym)
       SELECT 'participant', u.userid::text,
              'P' || LPAD((base.next_seq
                    + ROW_NUMBER() OVER (ORDER BY u.created_at, u.userid))::text, 3, '0')
       FROM users u
       CROSS JOIN (
         SELECT COALESCE(MAX(SUBSTRING(pseudonym FROM 2)::int), 0) AS next_seq
         FROM research_pseudonyms WHERE entity_type = 'participant'
       ) base
       WHERE u.role = 'participant'
         AND u.is_sandbox IS NOT TRUE
         AND EXISTS (
           SELECT 1 FROM therapy_sessions ts
           WHERE ts.user_id = u.userid AND ts.is_demo IS NOT TRUE AND ts.created_at <= $1
         )
         AND NOT EXISTS (
           SELECT 1 FROM research_pseudonyms rp
           WHERE rp.entity_type = 'participant' AND rp.entity_key = u.userid::text
         )`,
      [asOf]
    );

    // Sessions: non-demo, in-scope, unmapped. Numbered S0001.. in
    // (created_at, session_id) order.
    await client.query(
      `INSERT INTO research_pseudonyms (entity_type, entity_key, pseudonym)
       SELECT 'session', ts.session_id,
              'S' || LPAD((base.next_seq
                    + ROW_NUMBER() OVER (ORDER BY ts.created_at, ts.session_id))::text, 4, '0')
       FROM therapy_sessions ts
       CROSS JOIN (
         SELECT COALESCE(MAX(SUBSTRING(pseudonym FROM 2)::int), 0) AS next_seq
         FROM research_pseudonyms WHERE entity_type = 'session'
       ) base
       WHERE ts.is_demo IS NOT TRUE AND ts.created_at <= $1
         AND NOT EXISTS (
           SELECT 1 FROM research_pseudonyms rp
           WHERE rp.entity_type = 'session' AND rp.entity_key = ts.session_id
         )`,
      [asOf]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** participants.csv — one row per pseudonymized participant. */
export async function getParticipantsExport(asOf: string): Promise<DatasetRow[]> {
  const { rows } = await pool.query(
    `WITH parts AS (
       SELECT u.userid, u.created_at, u.memory_enabled, u.study_status, rp.pseudonym
       FROM research_pseudonyms rp
       JOIN users u ON u.userid::text = rp.entity_key
       WHERE rp.entity_type = 'participant' AND u.is_sandbox IS NOT TRUE
     ),
     sess AS (
       SELECT ts.user_id, ts.session_id, ts.created_at, ts.ended_at, ts.status, ts.crisis_flagged
       FROM therapy_sessions ts
       WHERE ts.is_demo IS NOT TRUE AND ts.created_at <= $1 AND ts.user_id IS NOT NULL
     ),
     sess_agg AS (
       SELECT user_id,
         COUNT(*) AS n_sessions,
         COUNT(*) FILTER (WHERE status = 'ended') AS n_sessions_ended,
         ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - created_at)) / 60.0), 0)::numeric, 1) AS total_session_minutes,
         MIN(created_at) AS first_session_at,
         MAX(created_at) AS last_session_at,
         BOOL_OR(crisis_flagged) AS any_crisis_flagged
       FROM sess GROUP BY user_id
     ),
     scales AS (
       SELECT ts.user_id, sr.scale, sr.score,
         ROW_NUMBER() OVER (PARTITION BY ts.user_id, sr.scale ORDER BY sr.created_at, sr.response_id) AS rn_asc,
         ROW_NUMBER() OVER (PARTITION BY ts.user_id, sr.scale ORDER BY sr.created_at DESC, sr.response_id DESC) AS rn_desc,
         COUNT(*) OVER (PARTITION BY ts.user_id, sr.scale) AS cnt
       FROM scale_responses sr
       JOIN sess ts ON ts.session_id = sr.session_id
     ),
     scale_fl AS (
       SELECT user_id, scale,
         MAX(score) FILTER (WHERE rn_asc = 1) AS first_score,
         MAX(score) FILTER (WHERE rn_desc = 1) AS last_score,
         MAX(cnt) AS cnt
       FROM scales GROUP BY user_id, scale
     ),
     crisis AS (
       -- Session-origin events attribute via the owning session; thread-origin
       -- events (076: session_id NULL) attribute via ce.client_user_id so
       -- message-scan crises are not silently dropped from the rollup. The
       -- outer join to parts (pseudonymized, non-sandbox participants) keeps
       -- sandbox/off-study clients excluded.
       SELECT user_id, COUNT(*) AS n_crisis_events
       FROM (
         SELECT ts.user_id
         FROM sess ts JOIN crisis_events ce ON ce.session_id = ts.session_id
         UNION ALL
         SELECT ce.client_user_id AS user_id
         FROM crisis_events ce
         WHERE ce.session_id IS NULL AND ce.client_user_id IS NOT NULL
           AND ce.created_at <= $1
       ) all_events
       GROUP BY user_id
     ),
     consents AS (
       SELECT user_id,
         (array_agg(consent_version ORDER BY accepted_at, consent_id))[1] AS first_v,
         (array_agg(consent_version ORDER BY accepted_at DESC, consent_id DESC))[1] AS last_v
       FROM participant_consents WHERE user_id IS NOT NULL GROUP BY user_id
     )
     SELECT
       parts.pseudonym AS participant_id,
       to_char(parts.created_at, 'YYYY-MM') AS enrolled_month,
       parts.memory_enabled AS memory_enabled,
       parts.study_status AS study_status,
       consents.first_v AS consent_version_first,
       consents.last_v AS consent_version_last,
       COALESCE(sess_agg.n_sessions, 0) AS n_sessions,
       COALESCE(sess_agg.n_sessions_ended, 0) AS n_sessions_ended,
       COALESCE(sess_agg.total_session_minutes, 0.0) AS total_session_minutes,
       ${tsUtc('sess_agg.first_session_at')} AS first_session_at,
       ${tsUtc('sess_agg.last_session_at')} AS last_session_at,
       phq.first_score AS phq2_first,
       phq.last_score AS phq2_last,
       CASE WHEN phq.cnt >= 2 THEN phq.last_score - phq.first_score END AS phq2_delta,
       gad.first_score AS gad2_first,
       gad.last_score AS gad2_last,
       CASE WHEN gad.cnt >= 2 THEN gad.last_score - gad.first_score END AS gad2_delta,
       COALESCE(crisis.n_crisis_events, 0) AS n_crisis_events,
       COALESCE(sess_agg.any_crisis_flagged, false) AS any_crisis_flagged
     FROM parts
     LEFT JOIN sess_agg ON sess_agg.user_id = parts.userid
     LEFT JOIN scale_fl phq ON phq.user_id = parts.userid AND phq.scale = 'phq2'
     LEFT JOIN scale_fl gad ON gad.user_id = parts.userid AND gad.scale = 'gad2'
     LEFT JOIN crisis ON crisis.user_id = parts.userid
     LEFT JOIN consents ON consents.user_id = parts.userid
     ORDER BY parts.pseudonym`,
    [asOf]
  );
  return rows;
}

/** sessions.csv — one row per non-demo session <= asOf (anonymous included). */
export async function getSessionsExport(asOf: string): Promise<DatasetRow[]> {
  const { rows } = await pool.query(
    `WITH sess AS (
       SELECT ts.*, rp.pseudonym AS session_pseudo_id
       FROM therapy_sessions ts
       JOIN research_pseudonyms rp ON rp.entity_type = 'session' AND rp.entity_key = ts.session_id
       WHERE ts.is_demo IS NOT TRUE AND ts.created_at <= $1
     ),
     msg AS (
       SELECT session_id,
         COUNT(*) AS n_messages,
         COUNT(*) FILTER (WHERE role = 'user') AS n_user_messages,
         COUNT(*) FILTER (WHERE role = 'assistant') AS n_assistant_messages
       FROM messages GROUP BY session_id
     ),
     tools AS (SELECT session_id, COUNT(*) AS n_tool_invocations FROM tool_invocations GROUP BY session_id),
     crisis AS (
       SELECT session_id,
         COUNT(*) AS n_crisis_events,
         COUNT(*) FILTER (WHERE trigger_method = 'auto') AS n_crisis_events_auto,
         COUNT(*) FILTER (WHERE trigger_method = 'manual') AS n_crisis_events_manual,
         MAX(risk_score) AS crisis_max_risk_score
       FROM crisis_events GROUP BY session_id
     ),
     risk AS (SELECT session_id, COUNT(*) AS n_risk_check_steps FROM risk_check_steps GROUP BY session_id),
     llm AS (
       SELECT session_id, SUM(tokens_in) AS llm_tokens_in, SUM(tokens_out) AS llm_tokens_out
       FROM session_llm_usage GROUP BY session_id
     )
     SELECT
       sess.session_pseudo_id AS session_pseudo_id,
       COALESCE(pp.pseudonym, '') AS participant_id,
       (sess.user_id IS NULL) AS is_anonymous,
       ${tsUtc('sess.created_at')} AS started_at,
       ${tsUtc('sess.ended_at')} AS ended_at,
       CASE WHEN sess.ended_at IS NOT NULL
            THEN ROUND((EXTRACT(EPOCH FROM (sess.ended_at - sess.created_at)) / 60.0)::numeric, 1) END AS duration_minutes,
       sess.status AS status,
       sess.ended_by AS ended_by,
       sess.session_type AS session_type,
       sc.modality AS modality_condition,
       CASE WHEN sc.proactive_offering IS NULL THEN '' ELSE sc.proactive_offering::text END AS proactive_offering,
       sc.theme AS theme,
       sc.language AS language,
       sc.voice AS voice,
       sc.ai_model AS ai_model,
       sc.transcription_model AS transcription_model,
       sc.temperature AS temperature,
       (sess.checkin->>'mood')::int AS checkin_mood,
       (sess.recording_object_key IS NOT NULL) AS had_recording,
       CASE WHEN sess.recording_duration_ms IS NOT NULL
            THEN ROUND((sess.recording_duration_ms / 1000.0)::numeric, 1) END AS recording_duration_s,
       COALESCE(msg.n_messages, 0) AS n_messages,
       COALESCE(msg.n_user_messages, 0) AS n_user_messages,
       COALESCE(msg.n_assistant_messages, 0) AS n_assistant_messages,
       COALESCE(tools.n_tool_invocations, 0) AS n_tool_invocations,
       sess.crisis_flagged AS crisis_flagged,
       sess.crisis_severity AS crisis_severity,
       crisis.crisis_max_risk_score AS crisis_max_risk_score,
       COALESCE(crisis.n_crisis_events, 0) AS n_crisis_events,
       COALESCE(crisis.n_crisis_events_auto, 0) AS n_crisis_events_auto,
       COALESCE(crisis.n_crisis_events_manual, 0) AS n_crisis_events_manual,
       COALESCE(risk.n_risk_check_steps, 0) AS n_risk_check_steps,
       COALESCE(llm.llm_tokens_in, 0) AS llm_tokens_in,
       COALESCE(llm.llm_tokens_out, 0) AS llm_tokens_out
     FROM sess
     LEFT JOIN research_pseudonyms pp
       ON pp.entity_type = 'participant' AND pp.entity_key = sess.user_id::text
     LEFT JOIN session_configurations sc ON sc.session_id = sess.session_id
     LEFT JOIN msg ON msg.session_id = sess.session_id
     LEFT JOIN tools ON tools.session_id = sess.session_id
     LEFT JOIN crisis ON crisis.session_id = sess.session_id
     LEFT JOIN risk ON risk.session_id = sess.session_id
     LEFT JOIN llm ON llm.session_id = sess.session_id
     ORDER BY sess.session_pseudo_id`,
    [asOf]
  );
  return rows;
}

/** screeners.csv — one row per scale_responses row over in-scope sessions. */
export async function getScreenersExport(asOf: string): Promise<DatasetRow[]> {
  const { rows } = await pool.query(
    `WITH sess AS (
       SELECT ts.session_id, ts.user_id, rp.pseudonym AS session_pseudo_id
       FROM therapy_sessions ts
       JOIN research_pseudonyms rp ON rp.entity_type = 'session' AND rp.entity_key = ts.session_id
       WHERE ts.is_demo IS NOT TRUE AND ts.created_at <= $1
     )
     SELECT
       COALESCE(pp.pseudonym, '') AS participant_id,
       sess.session_pseudo_id AS session_pseudo_id,
       sr.scale AS scale,
       sr.answers AS item_scores,
       sr.score AS score,
       (sr.score >= 3) AS screen_positive,
       ${tsUtc('sr.created_at')} AS administered_at,
       ROW_NUMBER() OVER (PARTITION BY sess.user_id, sr.scale ORDER BY sr.created_at, sr.response_id) AS occasion_index
     FROM scale_responses sr
     JOIN sess ON sess.session_id = sr.session_id
     LEFT JOIN research_pseudonyms pp
       ON pp.entity_type = 'participant' AND pp.entity_key = sess.user_id::text
     ORDER BY sess.session_pseudo_id, sr.scale, sr.created_at, sr.response_id`,
    [asOf]
  );
  return rows;
}

/** moods.csv — union of pre-session check-in mood and log_mood tool calls. */
export async function getMoodsExport(asOf: string): Promise<DatasetRow[]> {
  const { rows } = await pool.query(
    `WITH sess AS (
       SELECT ts.session_id, ts.user_id, ts.created_at, ts.checkin, rp.pseudonym AS session_pseudo_id
       FROM therapy_sessions ts
       JOIN research_pseudonyms rp ON rp.entity_type = 'session' AND rp.entity_key = ts.session_id
       WHERE ts.is_demo IS NOT TRUE AND ts.created_at <= $1
     ),
     signals AS (
       SELECT sess.user_id, sess.session_pseudo_id, 'checkin' AS source,
              (sess.checkin->>'mood')::int AS mood, sess.created_at AS recorded_at
       FROM sess WHERE sess.checkin ? 'mood'
       UNION ALL
       SELECT sess.user_id, sess.session_pseudo_id, 'log_mood' AS source,
              (ti.arguments->>'score')::int AS mood, ti.created_at AS recorded_at
       FROM sess
       JOIN tool_invocations ti ON ti.session_id = sess.session_id
       WHERE ti.tool_name = 'log_mood' AND ti.success
     )
     SELECT
       COALESCE(pp.pseudonym, '') AS participant_id,
       signals.session_pseudo_id AS session_pseudo_id,
       signals.source AS source,
       signals.mood AS mood,
       ${tsUtc('signals.recorded_at')} AS recorded_at
     FROM signals
     LEFT JOIN research_pseudonyms pp
       ON pp.entity_type = 'participant' AND pp.entity_key = signals.user_id::text
     ORDER BY signals.session_pseudo_id, signals.recorded_at, signals.source`,
    [asOf]
  );
  return rows;
}

/** feedback.csv — one row per session_feedback row (has_comments only). */
export async function getFeedbackExport(asOf: string): Promise<DatasetRow[]> {
  const { rows } = await pool.query(
    `WITH sess AS (
       SELECT ts.session_id, ts.user_id, rp.pseudonym AS session_pseudo_id
       FROM therapy_sessions ts
       JOIN research_pseudonyms rp ON rp.entity_type = 'session' AND rp.entity_key = ts.session_id
       WHERE ts.is_demo IS NOT TRUE AND ts.created_at <= $1
     )
     SELECT
       COALESCE(pp.pseudonym, '') AS participant_id,
       sess.session_pseudo_id AS session_pseudo_id,
       sf.helpfulness_rating AS helpfulness_rating,
       sf.ease_rating AS ease_rating,
       sf.would_return_rating AS would_return_rating,
       (sf.comments IS NOT NULL AND length(trim(sf.comments)) > 0) AS has_comments,
       ${tsUtc('sf.created_at')} AS submitted_at
     FROM session_feedback sf
     JOIN sess ON sess.session_id = sf.session_id
     LEFT JOIN research_pseudonyms pp
       ON pp.entity_type = 'participant' AND pp.entity_key = sess.user_id::text
     ORDER BY sess.session_pseudo_id`,
    [asOf]
  );
  return rows;
}

/** evals.csv — one row per session_evals row (rubric scores only). */
export async function getEvalsExport(asOf: string): Promise<DatasetRow[]> {
  const { rows } = await pool.query(
    `WITH sess AS (
       SELECT ts.session_id, rp.pseudonym AS session_pseudo_id
       FROM therapy_sessions ts
       JOIN research_pseudonyms rp ON rp.entity_type = 'session' AND rp.entity_key = ts.session_id
       WHERE ts.is_demo IS NOT TRUE AND ts.created_at <= $1
     )
     SELECT
       sess.session_pseudo_id AS session_pseudo_id,
       se.prompt_version AS prompt_version,
       se.judge_model AS judge_model,
       (se.rubric->'safety_protocol'->>'score')::int AS safety_protocol_score,
       (se.rubric->'empathy'->>'score')::int AS empathy_score,
       (se.rubric->'modality_fidelity'->>'score')::int AS modality_fidelity_score,
       (se.rubric->'disclaimer_compliance'->>'score')::int AS disclaimer_compliance_score,
       (se.rubric->'non_directiveness'->>'score')::int AS non_directiveness_score,
       (se.rubric->'clinical_claims'->>'score')::int AS clinical_claims_score,
       ${tsUtc('se.created_at')} AS evaluated_at
     FROM session_evals se
     JOIN sess ON sess.session_id = se.session_id
     ORDER BY sess.session_pseudo_id, se.prompt_version`,
    [asOf]
  );
  return rows;
}

/**
 * crisis_events.csv — one row per crisis_events row (no free-text/JSON).
 * Session-origin rows join through the in-scope session (as before);
 * thread-origin rows (076: origin='thread_message', session_id NULL) are
 * included via ce.client_user_id — non-sandbox clients only, event-time
 * bounded by asOf — with thread_origin=true and an empty session_pseudo_id.
 * participant_id resolves through the participant pseudonym for both shapes
 * (empty when the client has no research pseudonym, e.g. anonymous sessions).
 * Rollup semantics: sessions.csv per-session crisis counts remain
 * session-origin only (thread events have no session); participants.csv
 * n_crisis_events includes both origins — documented in the codebook
 * (datasetExport.service.ts).
 */
export async function getCrisisEventsExport(asOf: string): Promise<DatasetRow[]> {
  const { rows } = await pool.query(
    `WITH sess AS (
       SELECT ts.session_id, ts.user_id, rp.pseudonym AS session_pseudo_id
       FROM therapy_sessions ts
       JOIN research_pseudonyms rp ON rp.entity_type = 'session' AND rp.entity_key = ts.session_id
       WHERE ts.is_demo IS NOT TRUE AND ts.created_at <= $1
     )
     SELECT
       COALESCE(sess.session_pseudo_id, '') AS session_pseudo_id,
       COALESCE(pp.pseudonym, '') AS participant_id,
       (ce.session_id IS NULL) AS thread_origin,
       ce.event_type AS event_type,
       ce.severity AS severity,
       ce.risk_score AS risk_score,
       ce.trigger_method AS trigger_method,
       ${tsUtc('ce.created_at')} AS occurred_at
     FROM crisis_events ce
     LEFT JOIN sess ON sess.session_id = ce.session_id
     LEFT JOIN users cu ON cu.userid = ce.client_user_id
     LEFT JOIN research_pseudonyms pp
       ON pp.entity_type = 'participant'
      AND pp.entity_key = COALESCE(sess.user_id, ce.client_user_id)::text
     WHERE (ce.session_id IS NOT NULL AND sess.session_id IS NOT NULL)
        OR (ce.session_id IS NULL AND ce.client_user_id IS NOT NULL
            AND cu.is_sandbox IS NOT TRUE AND ce.created_at <= $1)
     ORDER BY COALESCE(sess.session_pseudo_id, ''), ce.created_at, ce.event_id`,
    [asOf]
  );
  return rows;
}

/**
 * transcripts.csv (OPT-IN) — redacted turn text only. Never references the
 * `content` column: only `content_redacted`. Rows whose redaction has not run
 * yet export empty text with redaction_pending=true.
 */
export async function getTranscriptsExport(asOf: string): Promise<DatasetRow[]> {
  const { rows } = await pool.query(
    `WITH sess AS (
       SELECT ts.session_id, rp.pseudonym AS session_pseudo_id
       FROM therapy_sessions ts
       JOIN research_pseudonyms rp ON rp.entity_type = 'session' AND rp.entity_key = ts.session_id
       WHERE ts.is_demo IS NOT TRUE AND ts.created_at <= $1
     )
     SELECT
       sess.session_pseudo_id AS session_pseudo_id,
       ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.created_at, m.message_id) AS turn_index,
       m.role AS role,
       m.message_type AS message_type,
       COALESCE(m.content_redacted, '') AS content_redacted,
       (m.content_redacted IS NULL) AS redaction_pending,
       ${tsUtc('m.created_at')} AS created_at
     FROM messages m
     JOIN sess ON sess.session_id = m.session_id
     WHERE m.role IN ('user', 'assistant')
     ORDER BY sess.session_pseudo_id, m.created_at, m.message_id`,
    [asOf]
  );
  return rows;
}

/**
 * feedback_comments.csv (OPT-IN) — participant-authored free text, verbatim.
 * Bundled only with the transcript artifact, with a codebook warning.
 */
export async function getFeedbackCommentsExport(asOf: string): Promise<DatasetRow[]> {
  const { rows } = await pool.query(
    `WITH sess AS (
       SELECT ts.session_id, ts.user_id, rp.pseudonym AS session_pseudo_id
       FROM therapy_sessions ts
       JOIN research_pseudonyms rp ON rp.entity_type = 'session' AND rp.entity_key = ts.session_id
       WHERE ts.is_demo IS NOT TRUE AND ts.created_at <= $1
     )
     SELECT
       COALESCE(pp.pseudonym, '') AS participant_id,
       sess.session_pseudo_id AS session_pseudo_id,
       sf.comments AS comments,
       ${tsUtc('sf.created_at')} AS submitted_at
     FROM session_feedback sf
     JOIN sess ON sess.session_id = sf.session_id
     LEFT JOIN research_pseudonyms pp
       ON pp.entity_type = 'participant' AND pp.entity_key = sess.user_id::text
     WHERE sf.comments IS NOT NULL AND length(trim(sf.comments)) > 0
     ORDER BY sess.session_pseudo_id`,
    [asOf]
  );
  return rows;
}

/**
 * semantic_metrics.csv — per-session aggregates over redacted-message
 * embeddings (messages.embedding, populated by the message-embedding sweep).
 * Raw vectors never leave the DB: only cosine-similarity aggregates export.
 * Sessions with fewer than 2 embedded turns emit counts with empty metrics.
 */
export async function getSemanticMetricsExport(asOf: string): Promise<DatasetRow[]> {
  const { rows } = await pool.query(
    `WITH sess AS (
       SELECT ts.session_id, ts.user_id, rp.pseudonym AS session_pseudo_id
       FROM therapy_sessions ts
       JOIN research_pseudonyms rp ON rp.entity_type = 'session' AND rp.entity_key = ts.session_id
       WHERE ts.is_demo IS NOT TRUE AND ts.created_at <= $1
     ),
     turns AS (
       SELECT m.session_id, m.role, m.embedding, m.created_at, m.message_id,
              LAG(m.embedding) OVER w AS prev_embedding,
              ROW_NUMBER() OVER w AS rn,
              COUNT(*) OVER (PARTITION BY m.session_id) AS n_turns
       FROM messages m
       JOIN sess ON sess.session_id = m.session_id
       WHERE m.embedding IS NOT NULL AND m.role IN ('user', 'assistant')
       WINDOW w AS (PARTITION BY m.session_id ORDER BY m.created_at, m.message_id)
     ),
     user_turns AS (
       SELECT m.session_id, m.embedding,
              LAG(m.embedding) OVER w AS prev_embedding
       FROM messages m
       JOIN sess ON sess.session_id = m.session_id
       WHERE m.embedding IS NOT NULL AND m.role = 'user'
       WINDOW w AS (PARTITION BY m.session_id ORDER BY m.created_at, m.message_id)
     ),
     adjacency AS (
       SELECT session_id,
              MAX(n_turns) AS n_embedded_turns,
              AVG(CASE WHEN prev_embedding IS NOT NULL THEN 1 - (embedding <=> prev_embedding) END) AS mean_adjacent_similarity
       FROM turns
       GROUP BY session_id
     ),
     user_adjacency AS (
       SELECT session_id,
              AVG(CASE WHEN prev_embedding IS NOT NULL THEN 1 - (embedding <=> prev_embedding) END) AS mean_user_adjacent_similarity
       FROM user_turns
       GROUP BY session_id
     ),
     endpoints AS (
       SELECT f.session_id, 1 - (f.embedding <=> l.embedding) AS first_last_similarity
       FROM (SELECT DISTINCT ON (session_id) session_id, embedding FROM turns ORDER BY session_id, rn ASC) f
       JOIN (SELECT DISTINCT ON (session_id) session_id, embedding FROM turns ORDER BY session_id, rn DESC) l
         ON l.session_id = f.session_id
     )
     SELECT
       COALESCE(pp.pseudonym, '') AS participant_id,
       sess.session_pseudo_id AS session_pseudo_id,
       adjacency.n_embedded_turns AS n_embedded_turns,
       CASE WHEN adjacency.n_embedded_turns >= 2 THEN ROUND(adjacency.mean_adjacent_similarity::numeric, 4) END AS mean_adjacent_similarity,
       CASE WHEN adjacency.n_embedded_turns >= 2 THEN ROUND(user_adjacency.mean_user_adjacent_similarity::numeric, 4) END AS mean_user_adjacent_similarity,
       CASE WHEN adjacency.n_embedded_turns >= 2 THEN ROUND(endpoints.first_last_similarity::numeric, 4) END AS first_last_similarity
     FROM adjacency
     JOIN sess ON sess.session_id = adjacency.session_id
     LEFT JOIN user_adjacency ON user_adjacency.session_id = adjacency.session_id
     LEFT JOIN endpoints ON endpoints.session_id = adjacency.session_id
     LEFT JOIN research_pseudonyms pp
       ON pp.entity_type = 'participant' AND pp.entity_key = sess.user_id::text
     ORDER BY sess.session_pseudo_id`,
    [asOf]
  );
  return rows;
}
