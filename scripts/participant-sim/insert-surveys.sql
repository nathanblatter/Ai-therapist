-- Participant simulation — phase 2: insert the full Qualtrics survey series for
-- "Jordan" directly into qualtrics_responses (bypassing Qualtrics; the scoring +
-- export code reads answers JSONB with numeric QID values). Encodes the recovery
-- arc: moderate baseline distress -> midterm dip (wk4-5) -> improvement by exit,
-- sustained at week 12. Answer encoding verified against qualtricsScoring.service.ts:
--   PHQ-2/GAD-2 items: raw 1-4 (score = raw-1, 0-3; sum 0-6; positive >=3)
--   weekly mood QID8 1-6, stress QID9 1-5, helpfulness QID6 1-5, usage QID4 1-5
--   alliance QID7 matrix _1.._12 on 1-5 (WAI-SR); adverse weekly QID10==2 + QID11_TEXT
SELECT userid AS uid FROM users WHERE username='sim_participant' \gset

-- Clean any prior sim survey rows so this is idempotent.
DELETE FROM qualtrics_responses WHERE response_id LIKE 'R_SIM_JORDAN_%';

-- BASELINE (day 0). PHQ-2 = (3-1)+(3-1)=4 positive; GAD-2 = (4-1)+(3-1)=5 positive.
INSERT INTO qualtrics_responses (response_id, survey_id, survey_role, user_id, study_sid, finished, recorded_at, answers) VALUES
('R_SIM_JORDAN_BASE','SV_aW32vA2r2yHrpI2','baseline',:uid,(:uid)::text,TRUE,TIMESTAMPTZ '2026-06-08 09:40:00-06',
 '{"QID21_1":3,"QID21_2":3,"QID22_1":4,"QID22_2":3,"duration":312}');

-- WEEKLY check-ins wk1..wk8 (QID8 mood up, QID9 stress down over time; helpfulness QID6; usage QID4).
INSERT INTO qualtrics_responses (response_id, survey_id, survey_role, user_id, study_sid, finished, recorded_at, answers) VALUES
('R_SIM_JORDAN_W1','SV_emV8ohMB6FujVLU','weekly',:uid,(:uid)::text,TRUE,TIMESTAMPTZ '2026-06-15 20:10:00-06','{"QID8":2,"QID9":5,"QID6":3,"QID4":3,"QID10":1,"duration":74}'),
('R_SIM_JORDAN_W2','SV_emV8ohMB6FujVLU','weekly',:uid,(:uid)::text,TRUE,TIMESTAMPTZ '2026-06-22 21:05:00-06','{"QID8":2,"QID9":4,"QID6":3,"QID4":3,"QID10":1,"duration":68}'),
('R_SIM_JORDAN_W3','SV_emV8ohMB6FujVLU','weekly',:uid,(:uid)::text,TRUE,TIMESTAMPTZ '2026-06-29 19:45:00-06','{"QID8":3,"QID9":4,"QID6":4,"QID4":3,"QID10":1,"duration":81}'),
-- Week 4 includes the alliance matrix (QID7) AND an adverse-experience report (the library panic).
('R_SIM_JORDAN_W4','SV_emV8ohMB6FujVLU','weekly',:uid,(:uid)::text,TRUE,TIMESTAMPTZ '2026-07-06 20:30:00-06',
 '{"QID8":3,"QID9":5,"QID6":4,"QID4":4,"QID7_1":4,"QID7_2":4,"QID7_3":3,"QID7_4":4,"QID7_5":4,"QID7_6":4,"QID7_7":3,"QID7_8":4,"QID7_9":3,"QID7_10":4,"QID7_11":4,"QID7_12":3,"QID10":2,"QID11_TEXT":"had a panic-type moment in the library during midterm studying - heart racing, couldnt catch my breath. talked it through with the app after and calmed down. not an emergency but it scared me.","duration":168}'),
('R_SIM_JORDAN_W5','SV_emV8ohMB6FujVLU','weekly',:uid,(:uid)::text,TRUE,TIMESTAMPTZ '2026-07-13 20:15:00-06','{"QID8":3,"QID9":4,"QID6":4,"QID4":3,"QID10":1,"duration":72}'),
('R_SIM_JORDAN_W6','SV_emV8ohMB6FujVLU','weekly',:uid,(:uid)::text,TRUE,TIMESTAMPTZ '2026-07-20 18:50:00-06','{"QID8":4,"QID9":3,"QID6":4,"QID4":3,"QID10":1,"duration":66}'),
('R_SIM_JORDAN_W7','SV_emV8ohMB6FujVLU','weekly',:uid,(:uid)::text,TRUE,TIMESTAMPTZ '2026-07-27 21:20:00-06','{"QID8":4,"QID9":3,"QID6":5,"QID4":2,"QID10":1,"duration":70}'),
('R_SIM_JORDAN_W8','SV_emV8ohMB6FujVLU','weekly',:uid,(:uid)::text,TRUE,TIMESTAMPTZ '2026-08-03 19:30:00-06','{"QID8":5,"QID9":2,"QID6":5,"QID4":3,"QID10":1,"duration":79}');

-- EXIT (wk8). PHQ-2 = (2-1)+(2-1)=2 (below cutoff); GAD-2 = (2-1)+(2-1)=2.
INSERT INTO qualtrics_responses (response_id, survey_id, survey_role, user_id, study_sid, finished, recorded_at, answers) VALUES
('R_SIM_JORDAN_EXIT','SV_cZPBcn5vOkfXOCi','exit',:uid,(:uid)::text,TRUE,TIMESTAMPTZ '2026-08-04 16:00:00-06',
 '{"QID4_1":2,"QID4_2":2,"QID5_1":2,"QID5_2":2,"duration":244}');

-- WEEK-12 follow-up. PHQ-2 = (2-1)+(1-1)=1; GAD-2 = (2-1)+(2-1)=2. Sustained gains.
INSERT INTO qualtrics_responses (response_id, survey_id, survey_role, user_id, study_sid, finished, recorded_at, answers) VALUES
('R_SIM_JORDAN_W12','SV_6QIBQHIbJeGgR70','week12',:uid,(:uid)::text,TRUE,TIMESTAMPTZ '2026-08-31 15:20:00-06',
 '{"QID6_1":2,"QID6_2":1,"QID6_3":2,"QID6_4":2,"QID10":1,"duration":128}');

SELECT survey_role, count(*), min(recorded_at)::date AS first, max(recorded_at)::date AS last
  FROM qualtrics_responses WHERE response_id LIKE 'R_SIM_JORDAN_%' GROUP BY survey_role ORDER BY first;
