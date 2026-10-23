-- Rollback for 114_eval_rating_queue_and_crisis_adjudications.sql
--
-- Drops the two WP2 tables (human ratings in session_human_ratings are kept:
-- they predate this migration) and removes only the config key 114 added,
-- leaving every other evals setting in place.
BEGIN;

DROP TABLE IF EXISTS crisis_event_adjudications;
DROP TABLE IF EXISTS eval_rating_queue;

UPDATE system_config
   SET config_value = config_value - 'rating_second_rater_fraction'
 WHERE config_key = 'evals'
   AND config_value ? 'rating_second_rater_fraction';

COMMIT;
