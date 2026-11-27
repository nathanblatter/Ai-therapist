# AI-Therapist de-identified research dataset

- generated_at: 2026-09-07T23:59:59Z
- as_of (inclusion cutoff, created_at <= as_of): 2026-09-07T23:59:59Z
- git_sha: 3509bf5

## Provenance & de-identification

- Pseudonyms (participant_id P###, session_pseudo_id S####) come from a mapping table
  (research_pseudonyms) that is NEVER included in any export. Re-identification requires
  database access. Pseudonyms are assigned once and are stable across exports.
- Demo traffic is excluded everywhere (therapy_sessions.is_demo IS NOT TRUE; demo-role users omitted).
- Sandbox data is excluded everywhere: sandbox-owned sessions carry is_demo=TRUE, and users.is_sandbox
  / sandbox organizations are additionally filtered from user enumeration and pseudonym assignment.
- Anonymous participants (user_id IS NULL) cannot be linked across sessions: the att_pid
  browser cookie is deliberately not persisted server-side. Screener deltas and
  sessions-per-participant therefore under-count anonymous traffic.
- All timestamps are ISO-8601 UTC. Given the same as_of and unchanged source rows, every CSV is byte-identical across runs.

## Screening instruments (PHQ-2 / GAD-2)

PHQ-2 and GAD-2 are brief, public-domain SCREENERS (Kroenke, Spitzer, Williams), NOT diagnoses.
- PHQ-2 (mood check): 2 items, each 0-3 ("not at all" … "nearly every day"), score = item sum (0-6); screen-positive cutoff >= 3.
- GAD-2 (anxiety check): 2 items, each 0-3 ("not at all" … "nearly every day"), score = item sum (0-6); screen-positive cutoff >= 3.

## Exclusions



These fields are intentionally NOT exported (they are LLM-generated from, or quote, content):

session_name, checkin topic/goal, session_goal, instructions, recording_object_key, usernames,

message content, eval rationales/overall_comments, crisis notes/risk_factors/intervention JSON,

and the research_pseudonyms mapping itself.

---

## participants.csv

One row per pseudonymized participant (logged-in participant-role users with >=1 in-scope session).

Rows: 1

| column | type | source | values | notes |
|---|---|---|---|---|
| participant_id | string | research_pseudonyms | P001, P002, ... |  |
| enrolled_month | string | users.created_at | YYYY-MM | Month precision only, to reduce re-identifiability. |
| memory_enabled | bool | users.memory_enabled |  |  |
| study_status | string | users.study_status | active, paused, withdrawn | Stamped by the withdrawal survey or an admin (migration 087). |
| consent_version_first | string | participant_consents.consent_version |  | Earliest by accepted_at. |
| consent_version_last | string | participant_consents.consent_version |  | Latest by accepted_at. |
| n_sessions | int | therapy_sessions |  | Non-demo sessions with created_at <= as_of. |
| n_sessions_ended | int | therapy_sessions.status = 'ended' |  |  |
| total_session_minutes | float | SUM(ended_at - created_at)/60 |  | Rounded to 1 decimal. |
| first_session_at | timestamp | MIN(therapy_sessions.created_at) |  |  |
| last_session_at | timestamp | MAX(therapy_sessions.created_at) |  |  |
| phq2_first | int | scale_responses(scale=phq2).score | 0-6 | Earliest; empty if no PHQ-2 response. |
| phq2_last | int | scale_responses(scale=phq2).score | 0-6 | Latest; empty if no PHQ-2 response. |
| phq2_delta | int | phq2_last - phq2_first |  | Empty if fewer than 2 PHQ-2 responses. |
| gad2_first | int | scale_responses(scale=gad2).score | 0-6 | Earliest; empty if no GAD-2 response. |
| gad2_last | int | scale_responses(scale=gad2).score | 0-6 | Latest; empty if no GAD-2 response. |
| gad2_delta | int | gad2_last - gad2_first |  | Empty if fewer than 2 GAD-2 responses. |
| n_crisis_events | int | crisis_events (via sessions + thread-origin via client_user_id) |  |  |
| any_crisis_flagged | bool | therapy_sessions.crisis_flagged |  |  |

## sessions.csv

One row per non-demo session with created_at <= as_of (anonymous sessions included).

Rows: 16

| column | type | source | values | notes |
|---|---|---|---|---|
| session_pseudo_id | string | research_pseudonyms | S0001, S0002, ... |  |
| participant_id | string | research_pseudonyms |  | Empty for anonymous sessions. |
| is_anonymous | bool | therapy_sessions.user_id IS NULL |  |  |
| started_at | timestamp | therapy_sessions.created_at |  |  |
| ended_at | timestamp | therapy_sessions.ended_at |  |  |
| duration_minutes | float | ended_at - created_at |  | Rounded to 1 decimal; empty if not ended. |
| status | string | therapy_sessions.status | active, ended, archived |  |
| ended_by | string | therapy_sessions.ended_by |  |  |
| session_type | string | therapy_sessions.session_type | realtime, chat |  |
| modality_condition | string | session_configurations.modality | cbt, act, mi, supportive |  |
| proactive_offering | string | session_configurations.proactive_offering | true, false, '' (not evaluated) |  |
| theme | string | session_configurations.theme | default, sage, ocean, dusk, dark |  |
| language | string | session_configurations.language |  |  |
| voice | string | session_configurations.voice |  |  |
| ai_model | string | session_configurations.ai_model |  | Resolved model snapshot at /token time. |
| transcription_model | string | session_configurations.transcription_model |  |  |
| temperature | float | session_configurations.temperature |  |  |
| checkin_mood | int | therapy_sessions.checkin->>'mood' | 1-10 |  |
| had_recording | bool | therapy_sessions.recording_object_key IS NOT NULL |  | The object key itself is never exported. |
| recording_duration_s | float | recording_duration_ms/1000 |  | Rounded to 1 decimal. |
| n_messages | int | messages |  |  |
| n_user_messages | int | messages.role = 'user' |  |  |
| n_assistant_messages | int | messages.role = 'assistant' |  |  |
| n_tool_invocations | int | tool_invocations |  |  |
| crisis_flagged | bool | therapy_sessions.crisis_flagged |  |  |
| crisis_severity | string | therapy_sessions.crisis_severity | low, medium, high |  |
| crisis_max_risk_score | int | MAX(crisis_events.risk_score) | 0-100 |  |
| n_crisis_events | int | crisis_events |  |  |
| n_crisis_events_auto | int | crisis_events.trigger_method = 'auto' |  |  |
| n_crisis_events_manual | int | crisis_events.trigger_method = 'manual' |  |  |
| n_risk_check_steps | int | risk_check_steps |  |  |
| llm_tokens_in | int | SUM(session_llm_usage.tokens_in) |  |  |
| llm_tokens_out | int | SUM(session_llm_usage.tokens_out) |  |  |

## screeners.csv

One row per PHQ-2/GAD-2 administration (scale_responses) over in-scope sessions.

Rows: 0

| column | type | source | values | notes |
|---|---|---|---|---|
| participant_id | string | research_pseudonyms |  | Empty for anonymous sessions. |
| session_pseudo_id | string | research_pseudonyms |  |  |
| scale | string | scale_responses.scale | phq2, gad2 |  |
| item_scores | json | scale_responses.answers |  | JSON array of per-item integer scores (0-3 each). |
| score | int | scale_responses.score | 0-6 |  |
| screen_positive | bool | score >= 3 |  | Conventional screen-positive cutoff. |
| administered_at | timestamp | scale_responses.created_at |  |  |
| occasion_index | int | ROW_NUMBER() per participant+scale by created_at |  | Anonymous responses are not linked across sessions. |

## moods.csv

Union of the two mood signals: pre-session check-in mood and the log_mood tool.

Rows: 25

| column | type | source | values | notes |
|---|---|---|---|---|
| participant_id | string | research_pseudonyms |  | Empty for anonymous sessions. |
| session_pseudo_id | string | research_pseudonyms |  |  |
| source | string | checkin | log_mood | checkin, log_mood |  |
| mood | int | checkin->>'mood' or log_mood arguments->>'score' | 1-10 |  |
| recorded_at | timestamp | therapy_sessions.created_at or tool_invocations.created_at |  |  |

## feedback.csv

One row per post-session feedback submission (numeric ratings only; free-text comment presence flagged, comment excluded).

Rows: 10

| column | type | source | values | notes |
|---|---|---|---|---|
| participant_id | string | research_pseudonyms |  | Empty for anonymous sessions. |
| session_pseudo_id | string | research_pseudonyms |  |  |
| helpfulness_rating | int | session_feedback.helpfulness_rating | 1-5 |  |
| ease_rating | int | session_feedback.ease_rating | 1-5 |  |
| would_return_rating | int | session_feedback.would_return_rating | 1-5 |  |
| has_comments | bool | session_feedback.comments IS NOT NULL |  | Comment text is participant-authored and only in the opt-in transcript artifact. |
| submitted_at | timestamp | session_feedback.created_at |  |  |

## evals.csv

One row per automated session evaluation (LLM-judge rubric scores; rationales excluded as they quote transcript text).

Rows: 16

| column | type | source | values | notes |
|---|---|---|---|---|
| session_pseudo_id | string | research_pseudonyms |  |  |
| prompt_version | string | session_evals.prompt_version |  |  |
| judge_model | string | session_evals.judge_model |  |  |
| safety_protocol_score | int | session_evals.rubric->'safety_protocol'->>'score' | 1-5 |  |
| empathy_score | int | session_evals.rubric->'empathy'->>'score' | 1-5 |  |
| modality_fidelity_score | int | session_evals.rubric->'modality_fidelity'->>'score' | 1-5 |  |
| disclaimer_compliance_score | int | session_evals.rubric->'disclaimer_compliance'->>'score' | 1-5 |  |
| non_directiveness_score | int | session_evals.rubric->'non_directiveness'->>'score' | 1-5 |  |
| clinical_claims_score | int | session_evals.rubric->'clinical_claims'->>'score' | 1-5 |  |
| evaluated_at | timestamp | session_evals.created_at |  |  |

## crisis_events.csv

One row per crisis event, both session-origin and thread-origin (message-scan) rows (no notes/risk_factors/intervention_details JSON, which can quote content).

Rows: 0

| column | type | source | values | notes |
|---|---|---|---|---|
| session_pseudo_id | string | research_pseudonyms |  |  |
| participant_id | string | research_pseudonyms |  | Via session owner, or crisis_events.client_user_id for thread-origin rows; empty when no pseudonym (e.g. anonymous session). |
| thread_origin | bool | crisis_events.session_id IS NULL |  | Message-scan events (origin='thread_message'); session_pseudo_id empty. Included in participants.csv n_crisis_events; excluded from sessions.csv per-session counts. |
| event_type | string | crisis_events.event_type |  |  |
| severity | string | crisis_events.severity | low, medium, high |  |
| risk_score | int | crisis_events.risk_score | 0-100 |  |
| trigger_method | string | crisis_events.trigger_method | auto, manual, system |  |
| occurred_at | timestamp | crisis_events.created_at |  |  |

## surveys.csv

One row per finished, participant-linked Qualtrics survey response (baseline/weekly/exit/week12), synced via the Qualtrics API (qualtrics_responses). Linkage/timing/completeness only; answer content stays out of the default bundle.

Rows: 11

| column | type | source | values | notes |
|---|---|---|---|---|
| participant_id | string | research_pseudonyms | P001, P002, ... |  |
| survey_role | string | qualtrics_responses.survey_role | baseline, weekly, exit, week12 |  |
| finished | bool | qualtrics_responses.finished |  |  |
| recorded_at | timestamp | qualtrics_responses.recorded_at |  |  |

## surveys_scored.csv

One row per finished, participant-linked survey response with derived instrument scores and weekly metrics (computed server-side from verified QID maps; see qualtricsScoring.service.ts). Raw answer payloads stay out of the bundle.

Rows: 11

| column | type | source | values | notes |
|---|---|---|---|---|
| participant_id | string | research_pseudonyms | P001, P002, ... |  |
| survey_role | string | qualtrics_responses.survey_role | baseline, weekly, exit, week12 |  |
| recorded_at | timestamp | qualtrics_responses.recorded_at |  |  |
| study_week | int | derived: 1 + whole weeks from enrollment (earliest qualtrics_signups.registered_at) to recorded_at | 1, 2, ...; empty when the participant has no enrollment record or recorded_at precedes it | Same calendar as the in-app survey schedule (week 1 = first 7 days after enrollment). Join key to alliance_ratings.csv on (participant_id, study_week). NOT unique per participant and week: a participant can have two weekly responses in one study week (a late response and the next one on time) and several sessions in a week, so reduce each side to one row per (participant_id, study_week) before joining. Rule for this file: among survey_role = weekly rows of a study week, take the one with the latest recorded_at. |
| completion_seconds | int | answers->>'duration' |  | Qualtrics-reported time spent in the survey. |
| speeder | bool | derived: completion_seconds below the per-role plausibility floor |  | Flag for analysis-time exclusion decisions (baseline<120s, weekly<20s, exit<90s, week12<45s, withdrawal<10s); never auto-excluded. |
| phq2 | int | derived: PHQ-2 item sum (raw-1 each) | 0-6; empty for weekly/unscorable |  |
| gad2 | int | derived: GAD-2 item sum (raw-1 each) | 0-6; empty for weekly/unscorable |  |
| phq2_positive | bool | derived: phq2 >= 3 |  |  |
| gad2_positive | bool | derived: gad2 >= 3 |  |  |
| weekly_mood | int | derived: weekly QID8 | 1-6, higher = better; empty for non-weekly |  |
| weekly_stress | int | derived: weekly QID9 | 1-5, higher = more stressed |  |
| weekly_helpfulness | int | derived: weekly QID6 | 1-5; empty when unanswered or 'did not use' |  |
| weekly_usage | string | derived: weekly QID4 bucket | 0, 1, 2-3, 4-6, 7 or more |  |
| weekly_alliance_task | float | derived: mean of the 2 Task alliance items | 1-5; empty for non-weekly or incomplete matrix |  |
| weekly_alliance_bond | float | derived: mean of the 2 Bond alliance items | 1-5 |  |
| weekly_alliance_goal | float | derived: mean of the 2 Goal alliance items | 1-5 |  |
| weekly_alliance_total | float | derived: mean of all 6 alliance items | 1-5 | Investigator-developed items adapted from the working-alliance construct (Task/Bond/Goal). |

## semantic_metrics.csv

Per-session semantic-trajectory aggregates over redacted-message embeddings (message-embedding sweep). Cosine-similarity aggregates only; raw vectors are never exported.

Rows: 16

| column | type | source | values | notes |
|---|---|---|---|---|
| participant_id | string | research_pseudonyms |  | Empty for anonymous sessions. |
| session_pseudo_id | string | research_pseudonyms |  |  |
| n_embedded_turns | int | messages.embedding IS NOT NULL |  | User+assistant turns with an embedding; unredacted turns are not yet counted. |
| mean_adjacent_similarity | float | derived: AVG(1 - cosine distance) over consecutive embedded turns | ~0-1, higher = more topically coherent; empty when <2 embedded turns |  |
| mean_user_adjacent_similarity | float | derived: same, user turns only |  | Participant topical coherence, ignoring assistant turns. |
| first_last_similarity | float | derived: 1 - cosine distance between first and last embedded turn |  | Low values suggest within-session topic drift. |

## alliance_ratings.csv

Per-session linguistic working-alliance markers (ai-therapist-173, migration 134): an automated judge rates each finished session on Task, Bond and Goal (Bordin 1979) from the REDACTED transcript. Numbers only; the judge generates no text. A behavioural counterpart to the weekly WAI-SR subscales in surveys_scored.csv: join on (participant_id, study_week) after reducing each file to one row per participant and week (aggregate the rated, non-stale sessions of the week here; take the latest weekly response there; see study_week in surveys_scored.csv). Only ended sessions of enrolled participants are rated (not staff, sandbox or anonymous sessions, and none of a participant who had withdrawn when the job ran); a message waiting for leak review is not read. Not yet validated against the self-report (docs/alliance-markers-2026-11-26.md). Empty until system_config.alliance_markers is enabled or the backfill is run.

Rows: 0 (added to the export on 2026-11-26, after this sample run; the sample directory has no alliance_ratings.csv, and its surveys_scored.csv predates the study_week column. Column definitions below are the current ones.)

| column | type | source | values | notes |
|---|---|---|---|---|
| participant_id | string | research_pseudonyms |  | Anonymous sessions are never rated; empty only when the account was deleted after the rating. A rating made before a participant withdrew stays (see participants.csv study_status). |
| session_pseudo_id | string | research_pseudonyms |  |  |
| session_started_at | timestamp | therapy_sessions.created_at |  |  |
| study_week | int | derived: 1 + whole weeks from enrollment (earliest qualtrics_signups.registered_at) to session start | 1, 2, ...; empty when the participant has no enrollment record or the session precedes it | Same definition as surveys_scored.csv study_week. |
| judge_version | string | session_alliance_ratings.judge_version |  | Rubric version; scores are comparable only within a version. |
| status | string | session_alliance_ratings.status | rated, too_short, errored | too_short: under the length floor, no judge call, nothing rateable. errored: the judge gave no answer (unknown, not a low score). Kept so coverage is auditable. |
| model | string | session_alliance_ratings.model |  |  |
| task_rateable | bool | session_alliance_ratings.task_rateable |  | false = the transcript holds too little evidence for Task; the score columns are then empty. Not a low score. |
| task_p_rateable | float | session_alliance_ratings.task_p_rateable | 0-1 | Judge probability that Task can be rated; rateable when >= 0.5. Empty for too_short rows (no judge call was made) and errored rows. |
| task_score | float | session_alliance_ratings.task_score | 1-5, higher = stronger | Probability-weighted mean level. The value to correlate with weekly_alliance_task. |
| task_level | int | session_alliance_ratings.task_level | 1-5 | Most probable level. |
| task_confidence | float | session_alliance_ratings.task_confidence | 0-1 | Probability of the most probable level. |
| task_distribution | json | session_alliance_ratings.task_distribution |  | JSON array: probability of each level, 1 to 5. |
| bond_rateable | bool | session_alliance_ratings.bond_rateable |  | false = the transcript holds too little evidence for Bond; the score columns are then empty. Not a low score. |
| bond_p_rateable | float | session_alliance_ratings.bond_p_rateable | 0-1 | Judge probability that Bond can be rated; rateable when >= 0.5. Empty for too_short rows (no judge call was made) and errored rows. |
| bond_score | float | session_alliance_ratings.bond_score | 1-5, higher = stronger | Probability-weighted mean level. The value to correlate with weekly_alliance_bond. |
| bond_level | int | session_alliance_ratings.bond_level | 1-5 | Most probable level. |
| bond_confidence | float | session_alliance_ratings.bond_confidence | 0-1 | Probability of the most probable level. |
| bond_distribution | json | session_alliance_ratings.bond_distribution |  | JSON array: probability of each level, 1 to 5. |
| goal_rateable | bool | session_alliance_ratings.goal_rateable |  | false = the transcript holds too little evidence for Goal; the score columns are then empty. Not a low score. |
| goal_p_rateable | float | session_alliance_ratings.goal_p_rateable | 0-1 | Judge probability that Goal can be rated; rateable when >= 0.5. Empty for too_short rows (no judge call was made) and errored rows. |
| goal_score | float | session_alliance_ratings.goal_score | 1-5, higher = stronger | Probability-weighted mean level. The value to correlate with weekly_alliance_goal. |
| goal_level | int | session_alliance_ratings.goal_level | 1-5 | Most probable level. |
| goal_confidence | float | session_alliance_ratings.goal_confidence | 0-1 | Probability of the most probable level. |
| goal_distribution | json | session_alliance_ratings.goal_distribution |  | JSON array: probability of each level, 1 to 5. |
| participant_turns | int | session_alliance_ratings.participant_turns |  | Redacted participant turns the judge was given. |
| participant_words | int | session_alliance_ratings.participant_words |  |  |
| transcript_truncated | bool | session_alliance_ratings.transcript_truncated |  | true when the session exceeded the transcript budget and only its opening and close were rated. |
| stale | bool | derived: session_alliance_ratings.transcript_fingerprint differs from the session transcript at export time |  | true when the session transcript the judge may read has changed since this rating (a late message was redacted, a message was re-redacted or corrected, a leak review released or withheld a message) and the session has not been rated again yet. Exclude stale rows, or re-run the backfill and export again. |
| rated_at | timestamp | session_alliance_ratings.rated_at |  | Only ratings made by as_of are exported. |

## session_features.csv

Structured per-session features (ai-therapist-172, migration 135): an automated judge codes each finished session, from the REDACTED transcript, on a fixed codebook of variables (topics, coping strategies, help-seeking, between-session follow-through, rupture and repair, reported change). Probabilities, booleans and codebook option names only; the judge generates no text. Meant as per-week covariates: reduce to one row per participant and study_week (for a yes/no variable, "present in any coded, non-stale session of the week" or the mean of its _p column) and join to surveys_scored.csv on (participant_id, study_week). Only ended sessions of enrolled participants are coded (not staff, sandbox or anonymous sessions, and none of a participant who had withdrawn when the job ran); a message waiting for leak review is not read. An EMPTY cell is never "absent": it is uncertain, unknown, not coded (too_short, errored) or a variable the row predates. Agreement with intended labels on invented transcripts, and the variables that performed badly, are in docs/session-features-2026-11-27.md; not validated against human coders on participant data. Empty until system_config.session_features is enabled or the backfill is run.

Rows: 0 (added to the export on 2026-11-27, after this sample run; the sample directory has no session_features.csv. Column definitions below are the current ones.)

| column | type | source | values | notes |
|---|---|---|---|---|
| participant_id | string | research_pseudonyms |  | Anonymous sessions are never coded; empty only when the account was deleted afterwards. A row stored before a participant withdrew stays (see participants.csv study_status). |
| session_pseudo_id | string | research_pseudonyms |  |  |
| session_started_at | timestamp | therapy_sessions.created_at |  |  |
| study_week | int | derived: 1 + whole weeks from enrollment (earliest qualtrics_signups.registered_at) to session start | 1, 2, ...; empty when the participant has no enrollment record or the session precedes it | Same definition as surveys_scored.csv and alliance_ratings.csv study_week. |
| feature_set_version | string | session_features.feature_set_version |  | Codebook version; values are comparable only within a version. The variable columns below are the current codebook: a row stored under an older version has empty cells for variables it does not hold. |
| status | string | session_features.status | extracted, too_short, errored | too_short: under the length floor, no judge call, every variable empty. errored: the judge gave no answer, every variable empty (unknown, not absent). Kept so coverage is auditable. |
| model | string | session_features.model |  |  |
| topic_work_school | bool | session_features.features->'topic_work_school'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant talks about their work, job, studies, classes, exams, grades or career as something on their mind in this session. Counts: Workload, deadlines, a boss, professor or coworker, job search, academic performance, choosing or doubting a major or career. Does not count: A bare mention used only to place an event in time ("after class", "when I got off work"); work or study that is only the setting of another problem (a cohort they feel left out of, a class missed because of poor sleep) with nothing said about the work or study itself. CAUTION, weak variable: Over-inclusive when work or study is only the setting of another problem: 3 false alarms in 7 intended-absent held-out sessions before an exclusion was added, 1 in 7 after. |
| topic_work_school_p | float | session_features.features->'topic_work_school'->'p' | 0-1 | Judge probability that topic_work_school is present. Empty when the judge gave no usable answer. |
| topic_finances | bool | session_features.features->'topic_finances'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant talks about money as a concern: debt, rent, bills, tuition costs, not affording something, financial dependence. Counts: Worry about paying for something, conflict about money, working extra hours because of money. Does not count: A price or purchase mentioned with no concern attached; a job mentioned without any talk of money. |
| topic_finances_p | float | session_features.features->'topic_finances'->'p' | 0-1 | Judge probability that topic_finances is present. Empty when the judge gave no usable answer. |
| topic_romantic | bool | session_features.features->'topic_romantic'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant talks about a romantic or dating relationship of their own: a partner, spouse, ex, breakup, dating, or wanting or not having a relationship. Counts: Conflict or closeness with a partner, a breakup, dating worries, engagement or marriage decisions. Does not count: Other people's relationships (parents' marriage, a friend's breakup) unless it is about the participant's own romantic life. |
| topic_romantic_p | float | session_features.features->'topic_romantic'->'p' | 0-1 | Judge probability that topic_romantic is present. Empty when the judge gave no usable answer. |
| topic_family | bool | session_features.features->'topic_family'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant talks about family members or family life: parents, siblings, children, grandparents, in-laws, the family home. Counts: Conflict, closeness, expectations, caring for or worrying about a relative, homesickness for family. Does not count: A spouse or romantic partner (that is topic_romantic) unless children or wider family are also discussed; roommates, housemates and the place the participant lives now (topic_friends_social); a relative named only in passing, or only in a "no" to a question from the assistant, with nothing said about them. |
| topic_family_p | float | session_features.features->'topic_family'->'p' | 0-1 | Judge probability that topic_family is present. Empty when the judge gave no usable answer. |
| topic_friends_social | bool | session_features.features->'topic_friends_social'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant talks about friends, roommates, peers or their social life. Counts: A conflict with a friend or roommate, making or losing friends, social events, feeling left out by particular people, fitting in. Does not count: Family and romantic partners; coworkers discussed only as part of the job; a friend named only in passing. |
| topic_friends_social_p | float | session_features.features->'topic_friends_social'->'p' | 0-1 | Judge probability that topic_friends_social is present. Empty when the judge gave no usable answer. |
| topic_loneliness | bool | session_features.features->'topic_loneliness'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant says they feel lonely, isolated, alone, disconnected, or that they have no one to talk to. Counts: Stated loneliness or isolation, in any words, about the present period of their life. Does not count: Being alone described neutrally or as a preference ("I like my evenings alone"); loneliness only attributed to someone else. |
| topic_loneliness_p | float | session_features.features->'topic_loneliness'->'p' | 0-1 | Judge probability that topic_loneliness is present. Empty when the judge gave no usable answer. |
| topic_sleep | bool | session_features.features->'topic_sleep'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant talks about their sleep or tiredness as a difficulty or as something that has changed: trouble falling or staying asleep, too little or too much sleep, nightmares, exhaustion, a disrupted sleep schedule, or sleep getting better or worse. Counts: A description of a sleep problem, of being worn out for lack of sleep, or of their sleep having improved or worsened. Does not count: Saying that sleep is fine or normal when asked about it; a time of day only ("I went to bed, then...") with nothing about the sleep; "tired of" meaning fed up. |
| topic_sleep_p | float | session_features.features->'topic_sleep'->'p' | 0-1 | Judge probability that topic_sleep is present. Empty when the judge gave no usable answer. |
| topic_physical_health | bool | session_features.features->'topic_physical_health'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant talks about their own physical health: an illness, injury, pain, a chronic condition, a medical appointment or test, appetite, weight or body changes. Counts: Headaches, stomach trouble, an injury, a diagnosis, recovery, a medical appointment for a physical problem, eating much less or more than usual. Does not count: Sleep (topic_sleep); mental-health care and psychiatric or sleep medication (help_professional, help_medication); the bodily feelings of anxiety, panic, low mood or a hangover alone (racing heart, a knot in the stomach, feeling like garbage); figures of speech ("making myself sick over it"); the health of someone else. |
| topic_physical_health_p | float | session_features.features->'topic_physical_health'->'p' | 0-1 | Judge probability that topic_physical_health is present. Empty when the judge gave no usable answer. |
| topic_low_mood | bool | session_features.features->'topic_low_mood'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant describes low or depressed mood: feeling down, sad, empty, numb, hopeless, unmotivated, or having lost interest or pleasure in things. Counts: Present or recent low mood in their own words, including "nothing feels worth doing" and crying spells. Does not count: Sadness the participant explicitly says is past and resolved; an assistant asking about mood when the participant says they feel fine; tiredness alone; grief, shock or stress about an event described without the low mood itself ("it has been heavy", "I am not coping with the bills"). |
| topic_low_mood_p | float | session_features.features->'topic_low_mood'->'p' | 0-1 | Judge probability that topic_low_mood is present. Empty when the judge gave no usable answer. |
| topic_anxiety_worry | bool | session_features.features->'topic_anxiety_worry'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant describes anxiety, worry, nervousness, panic, dread or being on edge, about something that might happen or with no clear object. Counts: Worry they cannot stop, panic attacks, feeling tense or keyed up, fear of an upcoming event, worrying in circles about what could go wrong. Does not count: Stress described only as being busy with no anxious feeling; going over a past event with regret or sadness and no fear of what is coming; one passing "scary" or "nervous" about a single step that then went fine; the word "worried" used once for a practical matter ("I was worried it would rain"). CAUTION, weak variable: The least stable topic: its answer changed in 3 of 25 invented sessions when only the surface of the text changed, and it is prone to false alarms on rumination and money stress. |
| topic_anxiety_worry_p | float | session_features.features->'topic_anxiety_worry'->'p' | 0-1 | Judge probability that topic_anxiety_worry is present. Empty when the judge gave no usable answer. |
| topic_grief_loss | bool | session_features.features->'topic_grief_loss'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant talks about a death, or about grieving someone or something they lost. Counts: The death or expected death of a person or pet, an anniversary of a death, mourning. Does not count: A breakup or a lost job, unless the participant themselves speaks of it as grief or mourning; a death mentioned as a bare fact with no feeling or weight. |
| topic_grief_loss_p | float | session_features.features->'topic_grief_loss'->'p' | 0-1 | Judge probability that topic_grief_loss is present. Empty when the judge gave no usable answer. |
| topic_substance_use | bool | session_features.features->'topic_substance_use'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant talks about their own use of alcohol, cannabis, nicotine or other drugs, or misuse of medication. Counts: How much or how often they use, using to cope, trying to cut down, worry about their use. Does not count: Someone else's use only; medication taken as prescribed (help_medication); caffeine. |
| topic_substance_use_p | float | session_features.features->'topic_substance_use'->'p' | 0-1 | Judge probability that topic_substance_use is present. Empty when the judge gave no usable answer. |
| topic_faith_spirituality | bool | session_features.features->'topic_faith_spirituality'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant talks about religion, faith, spirituality, their religious community, or prayer or scripture as part of their life. Counts: Belief or doubt, religious expectations or guilt, a faith community as support or as strain, praying about a problem. Does not count: A religious word used as an exclamation; a church building or event mentioned only as a place or date. |
| topic_faith_spirituality_p | float | session_features.features->'topic_faith_spirituality'->'p' | 0-1 | Judge probability that topic_faith_spirituality is present. Empty when the judge gave no usable answer. |
| topic_self_criticism | bool | session_features.features->'topic_self_criticism'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Topics the participant talks about] The participant talks about themselves in a harshly negative way: as a failure, worthless, stupid, a burden, not good enough, or expresses shame about who they are. Counts: Global negative judgements of the self, including ones the participant half-recognises as unfair. Does not count: Regret about one specific action without a judgement of the self ("I should not have said that"); modesty or a joke at their own expense. |
| topic_self_criticism_p | float | session_features.features->'topic_self_criticism'->'p' | 0-1 | Judge probability that topic_self_criticism is present. Empty when the judge gave no usable answer. |
| coping_breathing_relaxation | bool | session_features.features->'coping_breathing_relaxation'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Coping strategies the participant uses] The participant uses a breathing, grounding, relaxation, body-scan, mindfulness or meditation technique: they do one during this session, or say they have used one, or commit to using one. Counts: Doing a guided breathing or grounding exercise with the assistant; "I did the breathing thing before my exam"; "I will try the 5-4-3-2-1 tonight". Does not count: The assistant suggests or describes a technique and the participant does not take it up, declines it, or says they did not do it. |
| coping_breathing_relaxation_p | float | session_features.features->'coping_breathing_relaxation'->'p' | 0-1 | Judge probability that coping_breathing_relaxation is present. Empty when the judge gave no usable answer. |
| coping_physical_activity | bool | session_features.features->'coping_physical_activity'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Coping strategies the participant uses] The participant says they use, used or will use physical activity or time outdoors to cope or feel better: exercise, a walk, a run, the gym, sport, yoga. Counts: Activity the participant connects, even loosely, to how they feel or to managing stress, or plans as a coping step. Does not count: Activity mentioned only as an event with no link to coping or mood ("I was walking to class when she texted"); activity the participant says they did not do or have stopped doing. |
| coping_physical_activity_p | float | session_features.features->'coping_physical_activity'->'p' | 0-1 | Judge probability that coping_physical_activity is present. Empty when the judge gave no usable answer. |
| coping_cognitive | bool | session_features.features->'coping_cognitive'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Coping strategies the participant uses] The participant examines or changes a thought: they question whether a thought is accurate, look at evidence for and against it, name a thinking trap, or arrive at a more balanced way of seeing a situation, in this session or reported from outside it. Counts: Working through a thought record; "when I look at it, one bad grade does not mean I am failing"; reporting that they caught and challenged a thought during the week. Does not count: The assistant offers a reframe that the participant ignores or rejects; agreeing with a summary or reframe the assistant supplies without doing any of the examining themselves; simply describing a negative thought without examining it. |
| coping_cognitive_p | float | session_features.features->'coping_cognitive'->'p' | 0-1 | Judge probability that coping_cognitive is present. Empty when the judge gave no usable answer. |
| coping_journaling | bool | session_features.features->'coping_journaling'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Coping strategies the participant uses] The participant writes to cope or reflect: journaling, a written list or letter, a mood or thought log, or responding in writing to a journaling prompt in this session. Counts: Reported writing between sessions, writing done in the session as a reflective exercise, or a commitment to write. Does not count: Typing messages in the chat as such; schoolwork or work writing; a journaling suggestion the participant does not take up or says they did not do. |
| coping_journaling_p | float | session_features.features->'coping_journaling'->'p' | 0-1 | Judge probability that coping_journaling is present. Empty when the judge gave no usable answer. |
| coping_planning_problem_solving | bool | session_features.features->'coping_planning_problem_solving'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Coping strategies the participant uses] The participant works out a concrete plan to deal with a practical problem in their life (study or work, money, housing, a difficult conversation, an appointment to make): they state specific steps with a time or order, break a task down, decide what they will say to someone, or weigh options and choose one. Counts: A plan for a practical problem with at least one specific, scheduled step that the participant states themselves. Does not count: A vague intention ("I should deal with it"); options listed with nothing decided; a plan the assistant lays out that the participant does not accept; a step already taken that is only being reported; plans for something pleasant, social or commemorative (baking on Sunday, visiting a grave); planning a breathing, journaling or other practice (those have their own variables); ranking fears or filling in a worksheet. CAUTION, weak variable: Definition rewritten after the first draft (20 of 25 agreed); overlaps practice_agreed whenever a plan is a dated step. Two independent coders found the boundary hard. |
| coping_planning_problem_solving_p | float | session_features.features->'coping_planning_problem_solving'->'p' | 0-1 | Judge probability that coping_planning_problem_solving is present. Empty when the judge gave no usable answer. |
| coping_pleasant_activity | bool | session_features.features->'coping_pleasant_activity'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Coping strategies the participant uses] The participant says they use, used or will use an enjoyable or absorbing activity to feel better: a hobby, music, cooking, a show, a game, time with a pet, something creative. Counts: An activity the participant connects to mood or to taking a break, or schedules on purpose as something good for them. Does not count: Physical exercise (coping_physical_activity); seeing people for support (help_informal); hours of scrolling or gaming the participant describes as avoiding or numbing (coping_avoidance); an activity they say they no longer do. |
| coping_pleasant_activity_p | float | session_features.features->'coping_pleasant_activity'->'p' | 0-1 | Judge probability that coping_pleasant_activity is present. Empty when the judge gave no usable answer. |
| coping_avoidance | bool | session_features.features->'coping_avoidance'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Coping strategies the participant uses] The participant describes dealing with a difficulty by avoiding it or shutting down: putting off or skipping what they dread, withdrawing from people, staying in bed, numbing with scrolling, games, food or substances, pretending the problem is not there. Counts: Avoidance the participant reports doing in the present period of their life, whether or not they call it avoidance. Does not count: A deliberate, time-limited break; avoidance described only as something they used to do; declining a suggestion from the assistant (that is not avoidance of a life problem). |
| coping_avoidance_p | float | session_features.features->'coping_avoidance'->'p' | 0-1 | Judge probability that coping_avoidance is present. Empty when the judge gave no usable answer. |
| help_professional | bool | session_features.features->'help_professional'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Help-seeking] The participant says they are seeing, have contacted, or intend to contact a professional or formal service about their mental health or wellbeing: a therapist, counsellor, psychologist, psychiatrist, doctor, campus counselling, a support group, a helpline. Counts: Current care, an appointment made or planned, a stated decision to reach out, a recent contact. Does not count: The assistant suggests professional help and the participant does not say they will pursue it; a statement that they do not have or do not want such help (help_barrier); care that ended long ago and is mentioned only as history; the study app itself. |
| help_professional_p | float | session_features.features->'help_professional'->'p' | 0-1 | Judge probability that help_professional is present. Empty when the judge gave no usable answer. |
| help_informal | bool | session_features.features->'help_informal'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Help-seeking] The participant says they have talked, or intend to talk, about their difficulties with someone in their own life to get support: a friend, family member, partner, roommate, mentor or faith leader. Counts: Having opened up to someone, asking someone for help or advice, a stated plan to tell someone. Does not count: Spending time with people without sharing the difficulty; saying they have told nobody or cannot tell anyone (help_barrier); professionals (help_professional). |
| help_informal_p | float | session_features.features->'help_informal'->'p' | 0-1 | Judge probability that help_informal is present. Empty when the judge gave no usable answer. |
| help_medication | bool | session_features.features->'help_medication'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Help-seeking] The participant mentions medication for mental health or sleep that they take, have started, stopped or changed, or are considering. Counts: Antidepressants, anti-anxiety medication, sleep medication, ADHD medication; side effects; deciding whether to start or stop. Does not count: Medication for a physical condition only; someone else's medication; alcohol or recreational drugs (topic_substance_use). |
| help_medication_p | float | session_features.features->'help_medication'->'p' | 0-1 | Judge probability that help_medication is present. Empty when the judge gave no usable answer. |
| help_barrier | bool | session_features.features->'help_barrier'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Help-seeking] The participant expresses reluctance or an obstacle to getting help from other people or services: they turn down a suggestion to seek help, or name a reason they have not sought it. Counts: Cost, time, waiting lists, stigma, not wanting to be a burden, fear of being judged, a bad past experience, believing they should cope alone, "I cannot tell anyone". Does not count: Reluctance about an exercise or activity inside the session (that is the rupture variables); simply not mentioning help-seeking at all. |
| help_barrier_p | float | session_features.features->'help_barrier'->'p' | 0-1 | Judge probability that help_barrier is present. Empty when the judge gave no usable answer. |
| followup_status | string | session_features.features->'followup_status'->'value' | not_discussed, completed, partial, not_done; empty = uncertain (no option reached 0.5) or unknown | [Between-session work and follow-through] Whether the participant did the between-session work that came out of an EARLIER session: a practice, exercise, worksheet, thought record, journaling task or concrete step they were to do between sessions, as it is discussed in THIS session. Counts: Judge by what the participant reports about work set before this session. If several pieces of earlier work are discussed, describe them overall. Does not count: Work first proposed or agreed in this session (practice_agreed); exercises done live during this session (exercise_in_session); things the participant did on their own that were never set as between-session work. CAUTION, weak variable: completed and partial are close: one invented session sat at 0.50 against 0.47 and flipped under rewording. Read partial and completed together as "did at least some" unless the confidence is high. Options: not_discussed = No between-session work from an earlier session is referred to in this conversation by either side, or the conversation gives no way to tell. completed = The participant says they did the earlier between-session work, fully or essentially as agreed. partial = The participant says they did some of it: started but did not finish, did it fewer times than agreed, or did one part and not another. not_done = The participant says they did not do it (forgot, had no time, did not want to), or the assistant asks about it and the participant has nothing done to report. |
| followup_status_confidence | float | session_features.features->'followup_status'->'confidence' | 0-1 | Probability of the most probable option of followup_status. Empty when the judge gave no usable answer. |
| practice_agreed | bool | session_features.features->'practice_agreed'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Between-session work and follow-through] A specific thing for the participant to do before the next session is settled in this session and the participant accepts it: a practice, exercise, worksheet, thought record, journaling task or concrete step. Counts: The participant proposes it themselves, or the assistant proposes it and the participant clearly agrees ("okay, I will do that"). Does not count: A suggestion the participant declines, deflects or does not answer; a general wish with no specific action ("I will try to be kinder to myself"); work from an earlier session being reviewed. CAUTION, weak variable: Hard to tell from a plan the participant makes alone and from a weak "maybe"; present in 12 of 18 stage sessions and uncertain in 4 more, which may be over-inclusion. |
| practice_agreed_p | float | session_features.features->'practice_agreed'->'p' | 0-1 | Judge probability that practice_agreed is present. Empty when the judge gave no usable answer. |
| exercise_in_session | bool | session_features.features->'exercise_in_session'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Between-session work and follow-through] The participant actually carries out a structured exercise during this session with the assistant guiding it: a breathing, grounding or body-scan exercise, a thought record, a worksheet, a values sort, a fear ladder, a safety plan, a journaling prompt they answer. Counts: The participant goes through at least some of the steps and responds to them. Does not count: An exercise that is offered and declined, or only described; ordinary conversation, reflection or advice; a mood rating or questionnaire alone. |
| exercise_in_session_p | float | session_features.features->'exercise_in_session'->'p' | 0-1 | Judge probability that exercise_in_session is present. Empty when the judge gave no usable answer. |
| rupture_confrontation | bool | session_features.features->'rupture_confrontation'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Rupture and repair] The participant openly expresses dissatisfaction or disagreement with the assistant or with how the session is going: complaining that it is not helping, that the assistant is not listening or does not understand, objecting to a suggestion or to the approach, or expressing irritation at the assistant. Counts: Any direct complaint, objection, pushback or expression of annoyance aimed at the assistant, the session or the app as a helper, even a mild one. Does not count: Frustration aimed at other people or at life; a neutral correction of a fact ("no, it was my brother, not my dad") with no sign of annoyance; politely choosing between two options offered; technical complaints about audio or connection. |
| rupture_confrontation_p | float | session_features.features->'rupture_confrontation'->'p' | 0-1 | Judge probability that rupture_confrontation is present. Empty when the judge gave no usable answer. |
| rupture_withdrawal | bool | session_features.features->'rupture_withdrawal'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Rupture and repair] The participant pulls back from the assistant in response to something the assistant said or did: replies turn noticeably shorter or flatter than before, they stop engaging with questions ("fine", "whatever", "I guess", "I do not know" repeated), abruptly change the subject away from it, or move to end the session early because of it. Counts: A visible drop in engagement that follows a specific moment in the conversation. Does not count: A participant who is brief from the first turn to the last (no change to observe); a session ending naturally or for an outside reason (time, an appointment); a single short reply. CAUTION, weak variable: Few examples and the least stable variable under paraphrase (2 of 8 sessions moved in or out of uncertain). A participant who is terse throughout is hard to tell from one who pulled back. |
| rupture_withdrawal_p | float | session_features.features->'rupture_withdrawal'->'p' | 0-1 | Judge probability that rupture_withdrawal is present. Empty when the judge gave no usable answer. |
| rupture_outcome | string | session_features.features->'rupture_outcome'->'value' | none, repaired, unresolved; empty = uncertain (no option reached 0.5) or unknown | [Rupture and repair] Whether a rupture between the participant and the assistant (open disagreement or dissatisfaction, or a pulling back in response to the assistant) occurs in this session and, if so, how it stands at the end. Counts: Repaired means the assistant acknowledges the problem or changes course AND the participant then re-engages or says things are better. Does not count: Tension with people outside the conversation; technical problems. Options: none = No rupture occurs: the participant shows no dissatisfaction with, disagreement with, or pulling back from the assistant. repaired = A rupture occurs and is repaired by the end: the assistant acknowledges it or changes course and the participant re-engages or signals that things are better. unresolved = A rupture occurs and is still there at the end: the participant stays dissatisfied or disengaged, the assistant does not address it, or the session ends on it. |
| rupture_outcome_confidence | float | session_features.features->'rupture_outcome'->'confidence' | 0-1 | Probability of the most probable option of rupture_outcome. Empty when the judge gave no usable answer. |
| progress_reported | bool | session_features.features->'progress_reported'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Reported change and benefit] The participant reports that something in their life or in how they feel has got better since earlier in the study or since the last session, or reports having done something that was hard for them. Counts: Feeling better than before, a problem easing, sleeping better, having had a conversation they were dreading, a good week. Does not count: Feeling better only momentarily at the end of this conversation ("I feel a bit calmer now", which is benefit_stated); improvement hoped for but not yet happened; good news unrelated to their difficulties ("my team won"). CAUTION, weak variable: The variable most often left uncertain (2 of 24 invented cells; 3 of 25 sessions changed under surface edits); one held-out false alarm at p = 0.93. |
| progress_reported_p | float | session_features.features->'progress_reported'->'p' | 0-1 | Judge probability that progress_reported is present. Empty when the judge gave no usable answer. |
| setback_reported | bool | session_features.features->'setback_reported'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Reported change and benefit] The participant reports a recent negative life event (in the last week or two, or since the last session), or says that something in their life or in how they feel has recently got worse. Counts: A breakup, a serious argument, a job or income loss, a bad result, bad news about someone close, a flare-up of an illness, a relapse into an old pattern, "this week was worse", "it crept back up". Does not count: A long-standing difficulty described with no sign that it has recently worsened; an event from months ago or longer, however painful still; the anniversary of an old loss; minor everyday hassles; a moment of distress with no event behind it; not having done between-session work (followup_status). CAUTION, weak variable: Definition rewritten after the first draft (17 of 25 agreed) to "a recent negative life event or a recent worsening"; what counts as recent is soft, and 2 of 18 stage sessions were uncertain. |
| setback_reported_p | float | session_features.features->'setback_reported'->'p' | 0-1 | Judge probability that setback_reported is present. Empty when the judge gave no usable answer. |
| benefit_stated | bool | session_features.features->'benefit_stated'->'present' | true (p >= 0.65), false (p <= 0.35), empty = uncertain or unknown | [Reported change and benefit] The participant says that this conversation, the assistant, or something they learned from it has helped them or is useful to them. Counts: "This helped", "I feel calmer after talking this through", "that is a useful way to look at it", crediting a technique from these sessions with helping. Does not count: Thanks or a polite goodbye with no statement of benefit ("ok thanks, bye"); the assistant saying the session was useful; help from other people or services. |
| benefit_stated_p | float | session_features.features->'benefit_stated'->'p' | 0-1 | Judge probability that benefit_stated is present. Empty when the judge gave no usable answer. |
| unknown_count | int | session_features.unknown_count |  | Variables of this row the judge refused or answered unusably (both their columns are empty). Empty unless status is extracted. |
| participant_turns | int | session_features.participant_turns |  | Redacted participant turns the judge was given. |
| participant_words | int | session_features.participant_words |  |  |
| transcript_truncated | bool | session_features.transcript_truncated |  | true when the session exceeded the transcript budget and only its opening and close were coded. |
| stale | bool | derived: session_features.transcript_fingerprint differs from the session transcript at export time |  | true when the session transcript the judge may read has changed since this row was computed (a late message was redacted, a message was re-redacted or corrected, a leak review released or withheld a message) and the session has not been coded again yet. Exclude stale rows, or re-run the backfill and export again. |
| extracted_at | timestamp | session_features.extracted_at |  | Only rows computed by as_of are exported. |
