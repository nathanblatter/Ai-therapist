-- Participant simulation — phase 3: spread the 16 chat sessions (created live,
-- all "now") across the 8-week study window. Sessions are mapped in creation
-- order to slot 1..16; each slot has a day-offset from enrollment (2026-06-08),
-- ~2 sessions/week. Shifts therapy_sessions.created_at/ended_at and cascades the
-- same base shift to messages, session_evals, risk_score_history, crisis_events,
-- and scale_responses so every derived timestamp in the export lines up.
-- Run AFTER all sessions finish and BEFORE the export (pseudonyms order on created_at).

\set enroll '2026-06-08'

WITH ordered AS (
  SELECT session_id,
         row_number() OVER (ORDER BY created_at) AS slot,
         created_at AS old_created
    FROM therapy_sessions
   WHERE user_id = (SELECT userid FROM users WHERE username='sim_participant')
),
-- day-offset + hour for each slot (2 per week; evening-ish, varied)
sched(slot, day_off, hour) AS (VALUES
  (1,3,19),(2,5,21),(3,10,20),(4,12,18),(5,17,17),(6,19,22),(7,24,20),(8,26,21),
  (9,31,19),(10,33,20),(11,38,18),(12,40,21),(13,45,20),(14,47,19),(15,52,17),(16,54,20)
),
mapped AS (
  SELECT o.session_id, o.old_created,
         (TIMESTAMPTZ :'enroll' + (s.day_off || ' days')::interval
            + (s.hour || ' hours')::interval + interval '7 minutes') AS new_created
    FROM ordered o JOIN sched s USING (slot)
)
UPDATE therapy_sessions t
   SET created_at = m.new_created,
       ended_at   = m.new_created + interval '19 minutes'
  FROM mapped m
 WHERE t.session_id = m.session_id;

-- Messages: re-space within each session's new window (90s apart, in id order).
WITH base AS (
  SELECT session_id, created_at AS s_created FROM therapy_sessions
   WHERE user_id = (SELECT userid FROM users WHERE username='sim_participant')
),
mseq AS (
  SELECT m.message_id AS mid, b.s_created,
         row_number() OVER (PARTITION BY m.session_id ORDER BY m.message_id) - 1 AS rn
    FROM messages m JOIN base b USING (session_id)
)
UPDATE messages x
   SET created_at = mseq.s_created + (mseq.rn * interval '90 seconds')
  FROM mseq WHERE x.message_id = mseq.mid;

-- session_evals: just after each session ends.
UPDATE session_evals e
   SET created_at = t.ended_at + interval '3 minutes'
  FROM therapy_sessions t
 WHERE e.session_id = t.session_id
   AND t.user_id = (SELECT userid FROM users WHERE username='sim_participant');

-- risk_score_history: within the session window (spaced 60s in id order).
WITH base AS (
  SELECT session_id, created_at AS s_created FROM therapy_sessions
   WHERE user_id = (SELECT userid FROM users WHERE username='sim_participant')
),
rseq AS (
  SELECT r.history_id AS rid, b.s_created,
         row_number() OVER (PARTITION BY r.session_id ORDER BY r.history_id) AS rn
    FROM risk_score_history r JOIN base b USING (session_id)
)
UPDATE risk_score_history x
   SET calculated_at = rseq.s_created + (rseq.rn * interval '60 seconds')
  FROM rseq WHERE x.history_id = rseq.rid;

-- crisis_events (if any were flagged): align to session start.
UPDATE crisis_events c
   SET created_at = t.created_at + interval '4 minutes'
  FROM therapy_sessions t
 WHERE c.session_id = t.session_id
   AND t.user_id = (SELECT userid FROM users WHERE username='sim_participant');

-- scale_responses (in-app screeners, if any were triggered): align to session.
UPDATE scale_responses sr
   SET created_at = t.created_at + interval '6 minutes'
  FROM therapy_sessions t
 WHERE sr.session_id = t.session_id
   AND t.user_id = (SELECT userid FROM users WHERE username='sim_participant');

SELECT row_number() OVER (ORDER BY created_at) AS slot,
       created_at::date AS date, status,
       (SELECT count(*) FROM messages m WHERE m.session_id=s.session_id) AS msgs
  FROM therapy_sessions s
 WHERE user_id = (SELECT userid FROM users WHERE username='sim_participant')
 ORDER BY created_at;
