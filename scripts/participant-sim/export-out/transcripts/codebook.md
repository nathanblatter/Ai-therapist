# AI-Therapist OPT-IN transcript artifact

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

## Sensitivity warning



transcripts.csv contains REDACTED text only (content_redacted). feedback_comments.csv contains

VERBATIM participant free text with no redaction applied — treat it as identifiable data and

store/share accordingly.

---

## transcripts.csv

REDACTED turn text only (content_redacted). Original content is NEVER exported. Rows pending redaction export empty text with redaction_pending=true.

Rows: 170

| column | type | source | values | notes |
|---|---|---|---|---|
| session_pseudo_id | string | research_pseudonyms |  |  |
| turn_index | int | ROW_NUMBER() per session by created_at |  |  |
| role | string | messages.role | user, assistant |  |
| message_type | string | messages.message_type |  |  |
| content_redacted | string | messages.content_redacted |  | Redacted text only; empty when redaction has not run. |
| redaction_pending | bool | messages.content_redacted IS NULL |  |  |
| created_at | timestamp | messages.created_at |  |  |

## feedback_comments.csv

WARNING: participant-authored free text, exported verbatim (no content_redacted equivalent exists for feedback comments). Handle as identifiable data.

Rows: 3

| column | type | source | values | notes |
|---|---|---|---|---|
| participant_id | string | research_pseudonyms |  | Empty for anonymous sessions. |
| session_pseudo_id | string | research_pseudonyms |  |  |
| comments | string | session_feedback.comments |  | Verbatim participant text. |
| submitted_at | timestamp | session_feedback.created_at |  |  |
