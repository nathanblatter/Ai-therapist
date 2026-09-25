-- Participant simulation — phase 3c: populate two real app features the harness
-- doesn't exercise, so moods.csv and feedback.csv aren't empty:
--   * pre-session check-in mood (therapy_sessions.checkin JSONB, 1-10 scale)
--   * post-session feedback (session_feedback: helpfulness/ease/would_return 1-5)
-- Both track Jordan's arc (dip at the wk4-5 midterm slots 7-8). Run AFTER
-- backdate.sql (feedback.created_at is pinned to each session's ended_at).

WITH ordered AS (
  SELECT session_id, created_at, ended_at,
         row_number() OVER (ORDER BY created_at) AS slot
    FROM therapy_sessions
   WHERE user_id = (SELECT userid FROM users WHERE username='sim_participant')
),
-- pre-session check-in mood (1-10) + a short topic, per slot
ci(slot, mood, topic) AS (VALUES
  (1,3,'breakup / cant focus'),(2,3,'cant sleep'),(3,4,'behind in classes'),(4,3,'roommate fight'),
  (5,5,'went for a run'),(6,5,'the failing thoughts'),(7,4,'midterms coming'),(8,3,'panic in the library'),
  (9,4,'post-exam empty'),(10,5,'made up with roommate'),(11,6,'building a routine'),(12,6,'said yes to a date'),
  (13,7,'looking back'),(14,6,'bombed a quiz but ok'),(15,8,'study almost over'),(16,8,'closure')
)
UPDATE therapy_sessions t
   SET checkin = jsonb_build_object('mood', ci.mood, 'topic', ci.topic,
                                    'submitted_at', to_char(o.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'))
  FROM ordered o JOIN ci USING (slot)
 WHERE t.session_id = o.session_id;

-- post-session feedback for an engaged subset (not every session), trending up.
DELETE FROM session_feedback WHERE session_id IN (
  SELECT session_id FROM therapy_sessions
   WHERE user_id = (SELECT userid FROM users WHERE username='sim_participant'));

WITH ordered AS (
  SELECT session_id, ended_at,
         row_number() OVER (ORDER BY created_at) AS slot
    FROM therapy_sessions
   WHERE user_id = (SELECT userid FROM users WHERE username='sim_participant')
)
INSERT INTO session_feedback (session_id, helpfulness_rating, ease_rating, would_return_rating, comments, created_at)
SELECT o.session_id, f.help, f.ease, f.ret, f.comment, o.ended_at + interval '2 minutes'
  FROM ordered o
  JOIN (VALUES
    (1, 3,4,4,'wasnt sure about this at first but it actually helped to just get it out'),
    (3, 3,4,4,NULL),
    (5, 4,5,4,NULL),
    (7, 4,4,4,NULL),
    (8, 4,5,5,'really needed this today, felt a lot calmer after'),
    (9, 4,5,4,NULL),
    (11,5,5,5,NULL),
    (13,5,5,5,NULL),
    (15,5,5,5,NULL),
    (16,5,5,5,'genuinely grateful for this, helped more than i expected')
  ) AS f(slot, help, ease, ret, comment) ON f.slot = o.slot;

WITH ordered AS (
  SELECT session_id, created_at, checkin,
         row_number() OVER (ORDER BY created_at) AS slot
    FROM therapy_sessions
   WHERE user_id = (SELECT userid FROM users WHERE username='sim_participant')
)
SELECT o.slot, o.created_at::date, (o.checkin->>'mood') AS checkin_mood,
       sf.helpfulness_rating AS help, sf.would_return_rating AS ret,
       (sf.comments IS NOT NULL) AS has_comment
  FROM ordered o
  LEFT JOIN session_feedback sf USING (session_id)
 ORDER BY o.slot;
