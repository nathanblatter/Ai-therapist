# Linguistic working-alliance markers: method and first evidence (2026-11-26)

Ticket: ai-therapist-173. Code: `src/server/services/allianceMarkers.ts`
(rubric and model call), `src/server/services/allianceRating.service.ts`
(which sessions, when, what is stored), migration 134
(`session_alliance_ratings`).

## What this is, and what it is not yet

Participants report the working alliance every week on the WAI-SR (Task, Bond
and Goal subscales; `surveys_scored.csv`, `weekly_alliance_*`). This adds a
second, behavioural measure of the same three constructs: an automated judge
reads each finished session's redacted transcript and rates Task, Bond and
Goal. The research question is convergent validity: do the two measures of
human-AI alliance agree?

This PR builds the measure and tests it on invented transcripts and on stage's
fake sessions. **It has not been compared with any WAI-SR response**: no
Phase 2 participant data exists yet. Until that comparison is done the
ratings are an unvalidated research variable and must not be read as a
clinical signal. The job ships **off** (`system_config.alliance_markers`,
default and seed `{"enabled": false}`) and nothing in this PR turns it on.

## Constructs and sources

The three constructs are Bordin's working alliance:

- **Task**: agreement on what the two do in the session, and that it is useful.
- **Bond**: liking, trust and respect in both directions; feeling understood.
- **Goal**: agreement on what the work is for.

Sources: Bordin (1979), *Psychotherapy: Theory, Research & Practice* 16(3),
252-260; Hatcher & Gillaspy (2006), *Psychotherapy Research* 16(1), 12-25 (the
WAI-SR); Tichenor & Hill (1989), *Psychotherapy* 26(2), 195-199 (observer-rated
alliance from session material).

The WAI-SR is a copyrighted instrument and the study uses it by permission
for the self-report only. The rubric below does **not** reproduce or
paraphrase its items. The level descriptions were written for this study from
the construct definitions, as things an outside reader can see in a
transcript (what the participant takes up or turns down, what they say about
the assistant, whether an aim is stated and confirmed). Keep it that way when
editing the rubric.

## The judge

One request per session to the OpenAI Decisions API (`POST /v1/decisions`,
model `gpt-6-luna`), with six questions:

| Subscale | `predicate` question | `score` question |
|---|---|---|
| Task | Is there at least one moment where an activity is proposed, chosen, carried out or commented on? | 5 levels: 1 rejected, 2 doubtful, 3 mixed or unsignalled, 4 working together, 5 agreed and endorsed |
| Bond | Is there evidence about the personal relationship (a meaningful disclosure and the response to it, or a comment on feeling understood, trusting, judged...)? | 1 hostile or broken, 2 distant or guarded, 3 neutral, 4 warm, 5 strong |
| Goal | Is there talk about what the participant wants from the work or what it is for? | 1 at cross purposes, 2 unclear or mismatched, 3 partly shared, 4 shared, 5 explicit and mutual |

The full wording of every question and level is `ALLIANCE_RUBRIC` in
`allianceMarkers.ts`; that file is the source of truth and
`ALLIANCE_JUDGE_VERSION` (`alliance-v1`) must be bumped on any change to it.

Per subscale the stored result is:

- `rateable`: true when the predicate's probability is at least 0.5
  (`RATEABLE_MIN_P`). When false, every score column is NULL. **Not rateable
  is its own outcome, never a low score**, and the table enforces it with a
  CHECK constraint.
- `score`: the probability-weighted mean level, 1 to 5. This is the value to
  correlate with the WAI-SR subscale mean (also 1 to 5).
- `level`, `confidence`: the most probable level and its probability.
- `distribution`: the probability of each of the five levels.

Two guards sit in front of the model:

- **Length floor.** Fewer than 3 participant turns or fewer than 40
  participant words: stored as `too_short`, nothing rateable, no model call.
- **Transcript budget.** 120,000 characters. A longer session keeps its
  opening and its close and the row is marked `transcript_truncated`. The
  longest of 23 stage sessions rated below was 16,269 characters, so whole
  sessions fit with a wide margin.

A judge call that fails (API error, refusal, malformed answer) is stored as
`errored` with no scores: unknown, not low. The backfill lists it again.

### Why the Decisions API and not a Responses judge with a JSON schema

The existing quality judge (`sessionEval.service.ts`) is a chat-completions
judge that returns a score and a written rationale per dimension. For this
measure the Decisions API was chosen instead:

1. A `score` question returns a probability for every level, so each rating
   carries a distribution and a confidence that the model did not have to
   state about itself. The Responses route would give one integer, or a
   self-reported probability.
2. It generates no text. The judge cannot quote a transcript into the
   database, and there is no rationale column to keep out of exports.
3. "Can this be rated at all?" is a separate question from "how high?", which
   is what keeps an empty session from being scored low.
4. One request per session, input tokens only. Median 2,848 input tokens per
   call on the stage sample (about 2,000 of them are the rubric).

What it costs: there is no rationale to read when a rating looks wrong, and
the endpoint runs on a single model, so there is no judge ensemble and no
second opinion. If the endpoint were withdrawn the fallback is a Responses
judge with a strict schema on the same rubric; it is not built.

It was checked before building on it: a whole session fits, the answers
separate the invented cases (below), and the wire shape matches the published
reference (read 2026-11-26).

## Which sessions are rated

`ALLIANCE_ELIGIBLE_SESSION_SQL` in `src/server/db/allianceRatings.queries.ts`,
shared by the post-session hook, the backfill and nothing else:

- status `ended`;
- not `is_demo` (demo accounts, the red-team and evaluation harness, sandbox
  seeds: the same exclusion the dataset export uses);
- not owned by a sandbox account (the rule `sessionEval.service.ts` applies);
- **redaction complete**: at least one redactable message, and none with
  original text still waiting for its redaction. A message whose redaction was
  rejected keeps the whole session out until it is fixed.

The judge reads `messages.content_redacted` only. The query that builds the
transcript never selects `messages.content`. Participant turns marked
`unverified_speech` (a voice vendor transcription while the microphone was
muted, ai-therapist-412) are left out.

## When it runs

- **Automatically**, at the end of the redaction job
  (`sessionRedaction.service.ts`), which every session-end path and the
  15-minute redaction sweep go through. Only when
  `system_config.alliance_markers` is `{"enabled": true}`. A red-team harness
  session that did not opt in to post-session work is skipped.
- **Backfill**: `npx tsx src/database/scripts/rateAllianceMarkers.ts` lists the
  eligible sessions with no rating under the current judge version (no call,
  no write); `--rate` rates them. It is its own opt-in and does not consult
  the switch.

To turn the automatic job on later (not done here): `PUT
/admin/api/config/alliance_markers` with `{"enabled": true}` as a researcher.

## Storage, retention, deletion, scoping

`session_alliance_ratings`, one row per (session, judge version), numbers
only. It follows the other per-session derived tables (`session_evals`,
`session_eval_judges`, `session_acoustic_features`):

- `session_id` references `therapy_sessions` with `ON DELETE CASCADE`. Session
  deletion and demo cleanup remove the rating with the session, as they do for
  those tables. No separate retention rule: the row holds no content, and
  lives as long as its session.
- Withdrawal and account deletion: no rule of its own, like those tables. A
  withdrawal stamps `users.study_status` and deletes nothing. Deleting an
  account sets `therapy_sessions.user_id` to NULL: the session, its evaluation
  rows and its alliance rating stay, no longer linked to a person, and the
  export then shows the rating with an empty `participant_id`.
- No organisation column: organisation and caseload scope come from the
  session the row joins to. The admin read
  (`GET /admin/api/sessions/:sessionId/alliance-rating`) is researcher-only
  and goes through `requireSessionClientAccess`. It returns nothing while the
  caller still owes a blind human rating for that session, like the quality
  judge's scores. The session detail screen shows a small read-only panel
  when a rating exists.
- The content wipe does not affect it: the redacted text it was computed from
  survives the wipe.

Not done: token usage is stored on the row (`tokens_in`, `tokens_out`) but not
in `session_llm_usage`, whose `purpose` CHECK has no value for this job. The
in-app cost dashboard therefore does not show this spend. Adding a purpose
value is a follow-up.

## Export and the join to the WAI-SR

`alliance_ratings.csv` joins the default de-identified bundle
(`datasetExport.service.ts`): `participant_id`, `session_pseudo_id`,
`session_started_at`, `study_week`, `judge_version`, `status`, `model`, and per
subscale `rateable`, `p_rateable`, `score`, `level`, `confidence`,
`distribution`; plus `participant_turns`, `participant_words`,
`transcript_truncated`, `rated_at`.

`surveys_scored.csv` gains one column, `study_week`, computed the same way:
1 + whole weeks from enrollment (the earliest `qualtrics_signups.registered_at`)
to the timestamp, the calendar the in-app survey schedule uses.

So a rating joins to the participant's weekly WAI-SR response on
**(`participant_id`, `study_week`)**, or by date (`session_started_at` against
`recorded_at`) when a different window is wanted. Anonymous sessions have no
`participant_id` and cannot be joined.

## How the validation would be done (not built)

1. Export after Phase 2 data exists. Keep `status = 'rated'` rows of one
   `judge_version`; within them use each subscale only where `rateable`.
2. Aggregate to the participant-week: the mean `score` of the sessions in that
   `study_week` (report how many sessions each mean rests on; consider only
   sessions that ended before the survey's `recorded_at`).
3. Convergent validity per subscale: behavioural score against
   `weekly_alliance_task` / `_bond` / `_goal`. Observations are nested in
   participants, so use a repeated-measures correlation or a mixed model with
   a participant random intercept, and report the between-person and
   within-person parts separately.
4. Discriminant validity: a multitrait-multimethod table (3 subscales x 2
   methods). Same-subscale cross-method correlations should exceed
   different-subscale cross-method ones. Expect this to be the hard part: the
   WAI-SR subscales correlate highly with each other, and so do the
   behavioural ones here (see the stage sample).
5. Missingness: how often is a subscale not rateable, and does that depend on
   modality, session length or the self-reported alliance itself?
6. Decide thresholds and exclusions before looking at the correlations, and
   add the analysis to `scripts/phase2-analysis-plan.py` (S2 already covers
   weekly alliance growth).

## Evidence

All numbers below are from 2026-11-26. Judge `alliance-v1`, model
`gpt-6-luna`.

### Invented transcripts

`evals/goldens/alliance-markers.jsonl`: 15 invented sessions with an intended
band per subscale (low = level 1-2, mid = 3, high = 4-5, or not rateable).
Eight combine high and low across the three subscales, one is lukewarm
throughout, three are not rateable (two turns; app logistics only; off-topic
small talk), one has no talk of aims (Goal not rateable, Task and Bond high),
one has a rupture that is repaired, one is in a spoken register. Runner:
`scripts/alliance-markers-eval.mjs` (billed, never in CI).

**Agreement with the intended band, 15 transcripts x 3 subscales = 45 ratings
per run:**

| | Task | Bond | Goal | All |
|---|---|---|---|---|
| Final rubric, each of 5 runs | 14/15 | 15/15 | 14/15 | 43/45 |
| Final rubric, 5 runs pooled | 70/75 | 75/75 | 70/75 | 215/225 |
| First draft of the rubric, 1 run | 13/15 | 13/15 | 14/15 | 40/45 |

- Intended not rateable but given a score: **0/50** (5 runs; 0/10 per run).
- Intended high rated low, or low rated high: **0/160** (5 runs; 0/32 per
  run). The first draft had 2/32.
- The two misses of the final rubric, the same in every run: the transcript
  where the participant wants only a breathing timer and refuses everything
  else is rated Task 3 (intended high), and the lukewarm transcript is rated
  Goal 2 (intended mid). Both are adjacent bands and both intended labels are
  arguable.

**How to read these numbers.** The transcripts and the rubric have the same
author, the cases are deliberately clear-cut, and the rubric was revised once
after the first run: the draft let a dispute about the aim pull Task and Bond
down with it (a halo across subscales), so each score question gained a line
saying what belongs to the other two subscales. The 43/45 is measured on the
same transcripts that prompted that revision, so it is not a held-out result.
It shows the judge can separate the constructs on easy cases and refuses to
score empty ones. It says nothing about agreement with human raters or with
participants.

**Run-to-run stability.** Five repeat runs returned the same numbers to four
decimals in 45/45 cells (range of the mean score 0.000). The endpoint appears
to be deterministic for identical input, so repeat runs are a weak test. The
runner's `--perturb` mode is the stronger one: each transcript in four forms
that mean the same (as written; a greeting added in front; a goodbye added at
the end; participant turns lower-cased with final punctuation removed).

- Same level in all four forms: **42/45** cells. Same band: **43/45**.
- Range of the mean score across the four forms, over the 34 cells scored at
  least twice: mean **0.13**, max **0.46** on the 1-5 scale.
- The cell that moved most is the lukewarm transcript's Bond: rateable as
  written (p = 0.66, level 3) and not rateable in the other three forms
  (p = 0.26, 0.08, 0.36). No cell crossed from high to low.

So a surface change of no meaning can move a score by a few tenths, and can
flip the rateable flag when the evidence is thin. Treat differences of that
size as noise, and expect borderline neutral sessions to drop in and out of
"rateable".

### Stage sample (fake data, read-only)

40 of stage's 72 eligible sessions (of 322 ended sessions on stage; 77 are not
demo), chosen by a fixed hash order, read through a connection the server
forced read-only (`default_transaction_read_only=on`; a write probe was
rejected) by a script that only SELECTs. Nothing was written to stage and no
rating was stored. Stage sessions are test conversations by staff and
simulated participants, so the distribution below is not an estimate of
anything about participants.

- 17/40 under the length floor (16 of the 30 voice sessions, 1 of the 10 chat
  sessions): no model call.
- 23/40 rated, 0 errored. Transcripts: median 3,538 characters, max 16,269;
  none truncated. Input tokens per call: median 2,848, max 6,484.
- Rateable: Task 17/23, Bond 19/23, Goal 12/23. All three rateable in 11/23,
  none in 1/23. Goal is the subscale most often missing, as expected: many
  sessions never say what the work is for.
- Levels 1 to 5 among rateable: Task 1/0/5/4/7, Bond 0/3/4/9/3, Goal 0/2/5/4/1.
  Median confidence 0.82, 0.78, 0.71. The middle levels are used; the scale is
  not just its two ends.
- 9 of 69 rateable probabilities fell between 0.2 and 0.8, the zone where the
  flag is fragile.
- Correlations between subscale scores, where both are rateable: Task-Bond
  0.77 (n = 14), Task-Goal 0.81 (n = 11), Bond-Goal 0.68 (n = 12). Small n,
  fake data, but high enough that discriminant validity should be tested
  rather than assumed.

## Limits

- **Not validated.** No comparison with the WAI-SR, and none with human
  raters. A human-rated subset (two raters, the same rubric) would be the
  natural next check and can be done before Phase 2 data.
- **The goldens are easy and self-authored**, and the reported agreement is
  on the transcripts the rubric was tuned against (one revision).
- **One model, no rationale.** A rating cannot be audited by reading why. The
  model id is stored on each row; if the provider changes what `gpt-6-luna`
  points to, ratings before and after are not strictly comparable even under
  one `judge_version`.
- **Session-level judge, week-level self-report.** The WAI-SR asks about the
  week; a session rating describes one conversation. The aggregation rule is
  an analysis decision that has not been made.
- **What a transcript cannot show.** Bond in particular is partly unspoken. A
  quiet, trusting participant and a quiet, guarded one can produce similar
  text. The rubric scores what is said and done, and "mutual" regard from an
  AI is only ever its wording.
- **Redaction.** Placeholders replace names and places. The judge is told to
  ignore them, and the first golden includes some, but heavy redaction of an
  emotionally important passage could lower the evidence available.
- **Voice.** Voice transcripts are rated from the vendor's transcription. The
  spoken-register golden was rated high on all three subscales as intended,
  and lower-casing moved scores by tenths, but there is no test with real
  recognition errors.
- **Rateable threshold.** 0.5 is a default, not a tuned value; see the
  perturbation result.
- **IRB attachment.** The judge's wording is not in the "AI Model System
  Prompts (Verbatim)" attachment. That document lists post-session analysis
  and research evaluation prompts as outside its scope (Part E) and contains
  none of the comparable judges (the quality evaluator, the redaction leak
  check). Part E describes those as prompts that "score transcripts for
  quality"; whether that sentence should also name alliance rating before the
  job is enabled is a study decision, and is left as it is here.

## Spend

About 177 judge calls were made for this work (98 on the invented transcripts
across the first probe, the revision check and the five runs; 56 for the
perturbation run; 23 on the stage sample), input tokens only. Spend is
reported from the OpenAI costs API in the pull request, not estimated here.
