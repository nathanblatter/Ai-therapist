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
