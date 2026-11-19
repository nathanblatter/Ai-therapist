# Crisis Management System

## Overview

The crisis detection system combines a cheap, always-on keyword screen with an LLM context
assessment so that flags reflect actual context (intent vs. reference, negation, talking about
someone else) rather than bare keyword matches. Severity is graduated (none/low/medium/high),
responses are tiered accordingly, and researchers exercise clinical judgment on live sessions —
the automated system surfaces and prioritizes, the human on duty decides how to intervene.

---

## What feeds the detector (changed by the GPT-Live migration)

The detection tiers below are **unchanged**. What changed is the INPUT to them,
and the delivery mechanism for steering. See `docs/gpt-live.md`.

**Input.** Under the Realtime API, a participant turn arrived as a single
completed transcription event (`conversation.item.input_audio_transcription.completed`)
and that whole turn was scored. GPT-Live emits no such event: it streams
`session.input_transcript.delta` fragments with `start_ms` / `end_ms` and no turn
boundary, because the model is full duplex and both speakers can talk at once.
Turns are therefore **reassembled server-side** by `TranscriptAssembler` in
`sidebandManager.service.ts` — a turn closes after 900 ms of silence from that
speaker — and the assembled turn is what calls `runCrisisPipeline`.

Consequences the study team should know:

- **Scoring is gated on the silence gap.** Nothing is assessed until the
  participant pauses for 900 ms. The gap is deliberately tuned to err LATE:
  flushing early would hand the assessor half a sentence, and "I've been
  thinking about" scores very differently from "I've been thinking about killing
  myself." If the value is ever retuned, retune it upward.
- **Crisis detection runs even when the DB write fails.** The pipeline tolerates
  a null `messageId`; a database outage must never silently disable detection.
- **A late fragment starts a new turn** rather than being merged backwards, so
  no words are lost but a single spoken sentence can occasionally be scored as
  two turns.
- Detection requires the sideband. With `SIDEBAND_ENABLED=false`, or while the
  sideband is disconnected, no voice turns reach the detector at all.

**Steering delivery.** Realtime injected a hidden `conversation.item.create` with
`role: 'system'`. GPT-Live has no conversation item list; steering is delivered
as `session.instructions.append` (capped at 500 tokens, enforced client-side by
character count so a steer is never rejected for running slightly long).

Two behaviour changes follow:

- **Steering can no longer be paired with a forced response.** The `respond`
  argument on `injectMessage` / `tryInject` is accepted for signature
  compatibility and ignored — there is no `response.create` that makes the voice
  model speak. The crisis wind-down steer, which previously passed
  `respond: true`, now only steers; the model decides when to speak. An appended
  instruction can interrupt speech already in progress, but it cannot compel a
  reply.
- **An append acknowledgement is not proof of effect.** `session.instructions.appended`
  confirms only that the API accepted the event. It does not establish that the
  model consumed the instruction, acted on it, or that the participant heard
  anything. `intervention_actions` rows therefore record an *attempted and
  delivered* intervention, not a confirmed behavioural change. `tryInject`
  returning `false` (sideband not connected) is recorded as an **undelivered**
  intervention.

---

## Severity bands (high starts at 65 since 2026-11-18)

One definition, `src/shared/riskBands.ts`, imported by the scorer, the red-team harness, the
goldens and the admin displays:

| Band | Risk score | What the pipeline does |
|---|---|---|
| none | 0-24 | nothing |
| low | 25-49 | steering only, no flag |
| medium | 50-64 | crisis flag, dashboard alert, steering, no page |
| high | 65-100 | crisis flag and on-call page |

High started at 75 until the study owner's decision of 2026-11-18. The assessor rubric put
active suicidal ideation without a plan at "60-75, high" while the pipeline treated 60-74 as
medium, so "I've been thinking about ending my life a lot lately" scored 65, was flagged and
was never paged. The rubric now reads passive ideation 50-60 and active ideation without a
plan 65-75 ("always at least 65"), and a unit test fails if any band the rubric calls high
starts below the cutoff. The bands are code, not `system_config` and not a column: no
migration, and rows already stored keep the severity they were given.

What follows from the number:

- **The trajectory bonus cannot cross the page line by itself (2026-11-19,
  ai-therapist-357).** With high at 65, a second passive-ideation statement (assessor 55,
  +10 "sudden spike") became a page on the run-up arithmetic alone. The bonus is still
  applied, and still lifts a turn inside its band or from low to medium, but a turn whose own
  score is below the cutoff is held at 64 (`trajectory_capped_below_high` on the risk row).
  A turn already at 65 or more keeps the whole bonus. Whether repeated passive ideation
  should page at all is still the owner's question.
- **A step toward help cannot cross the page line by itself (2026-11-19).** "I'm going to do
  it, I'll text my sister tonight" after a passive-ideation turn is agreeing to reach out.
  The rubric says so in three places, and the assessor still returned it as intent whenever
  the rubric was edited somewhere else (three times during this work, last at exactly 65).
  A message that announces contacting a named support (`announcesHelpStep`), with no crisis
  keyword and no goodbye in it, is held at 64 in a session that was below high
  (`help_step_cap`).
- **Assessor down.** The moderation fallback is capped at 85 and uncapped below: a
  keyword-free turn with a moderation self-harm score of 65-74 now pages while the assessor
  is unreachable (it flagged without paging before).
- **Stored rows keep their band.** A turn scored 70 before the change was stored as medium
  and paged nobody. The admin risk timeline colours each row by the severity stored with it,
  not by today's bands.

The offline calibration report keeps its literal `ge_50` / `ge_75` counters (an archived
format); its `current_bands` follow the shared definition.

The rubric's bands are contiguous and match the table: distress 15-30, passive ideation
50-64, active ideation without a plan 65-79, a plan, the means or a time 80-100; a third
party 0-24 / 50-64 / 80-100; risk to others 0-10 / 25-64 / 65-100. A unit test fails if a
band called high starts below the cutoff or a band called medium ends at or above it.

## Escalation inside the high band (2026-11-19, ai-therapist-353)

Measured live: "yes" to the ideation question scores 65 or 75 depending on the run,
"tonight" 85, "I already took the pills" 95. The pipeline re-flagged only when a score was
MORE than 10 above the stored one, and the paging policy re-paged inside 15 minutes only at
90 and up, so a participant could go ideation, then tonight, then an overdose in progress,
and staff got one text.

- **The assessor says what the turn states.** A new literal observation, `acute`:
  `attempt` (an act already taken or under way), `plan_or_time` (intent stated with a time,
  a plan or the means at hand, or a goodbye in that sense), or `none`. It is decided after
  the score and only at 65 and up; ambivalence, being alone and the same words about an
  ordinary subject are `none`. Stored as `llm_acute`.
- **A flag event the first time a session reaches each stage**, whatever the stored score
  (`isFirstFlagAtStage`), and when a score crosses into 90 or more from below. The crisis
  event's notes, the dashboard alert and the `auto_flag` row say what changed
  (`escalation: 'plan_or_time' | 'attempt'`). A repeat of the same stage does not flag
  again.
- **The page says it in words and is not folded into a page that did not.** A risk page
  carries a `stage` (0 ideation, 1 a stated time or plan, 2 an attempt); `pageCovers`
  requires the earlier page to have been at least as far along, about the same person. The
  text carries `WHAT CHANGED: STATED INTENT WITH A TIME OR PLAN` or `WHAT CHANGED: ATTEMPT IN
  PROGRESS, or an act already taken`. An attempt is the top page level whatever its score.
- **Any turn at 90 or more always asks for a page**, flag or no flag
  (`handleHighTurnWithoutReflag`); only a delivered page at that level and stage, about the
  same person, in the last 15 minutes absorbs it.
- **The owner's open call: `REPAGE_ON_STATED_TIME_OR_PLAN`** in `crisisPaging.service.ts`.
  `true` (the default, failing toward paging): "tonight" at 85 pages again after the
  ideation page. `false`: it is still flagged and recorded as an escalation, and folded;
  only an attempt or a score of 90 or more pages again.

`crisisEscalationLadder.test.ts` runs the ladder at first scores 65, 75 and 85 through the
real pipeline, the real high-risk response and the real paging policy together: three flag
events and three texts each time.

## Detection: Two-Stage (Keyword Screen + LLM Assessment)
## Detection: Two-Stage (Keyword Screen + LLM Assessment)

**File:** `src/server/services/crisisDetection.service.ts`

### Stage 1 — Tiered keyword screen (every message, no API call)

Every analyzed participant message passes a tiered keyword screen:

| Tier | Provisional score | Examples |
|--------|-------------------|----------|
| High | 75 | explicit suicidal/self-harm intent ("kill myself", "end my life", "overdose") |
| Medium | 50 | passive ideation, literal ("better off without me") **and** indirect/euphemistic regex forms ("it would be easier if I didn't have to do this anymore", "I wouldn't mind not waking up", "tired of being here") |
| Low | 15 | milder risk-adjacent language |

The screen's job is SCREENING, not judging: **any** tier match wakes the Stage 2 LLM
assessment. The tier score is only used as a provisional fallback when the LLM is unavailable.

**Word forms (2026-11-18).** Each keyword is written once, in its base form, and until this
date was matched as that exact string: "overdose" but not "I think I overdosed", "kill myself"
but not "thinking about killing myself", "don't want to be alive" but not "I don't really want
to be alive". Those turns matched nothing and the assessor never ran. Keywords are now
compiled (`keywordPattern`) so that every verb or auxiliary listed in `WORD_FORMS` matches all
its forms (kill / kills / killed / killing; don't / didn't / doesn't / do not), and the
adverbs people put inside a phrase (`KEYWORD_FILLERS`: really, just, even, kind of, ...) may
sit between its words. The reported keyword is still the base phrase. Pronouns are not
inflected: "kill himself" is a different statement and is a third-party signal (Stage 1b).
Two algospeak terms with no everyday meaning joined the high tier as stand-ins for keywords
already there ("sewerslide", "unalive myself"), and "life isn't worth it" joined the passive
tier. Cost of the wider match: with the assessor DOWN, three more harmless golden rows page
on the keyword tier alone (denials and a past-tense recovery statement in a verb form that
now matches: "I've never thought about killing myself"); with the assessor up it clears them.

The medium tier sits at 50, the bottom of the medium severity band, because C-SSRS treats a
passive wish to be dead as ideation rather than distress and flagging requires medium
(ai-therapist-254). Matching the medium tier or higher also sets a **passive-ideation floor**
on the Stage 2 verdict: unless the assessor judged the language `negated`, `bystander`, or
`reference`, the final score cannot land below 50/medium. Logged as
`passive_ideation_floor` in `risk_score_history.score_factors`.

### Stage 1b — Context-dependent signals and session risk context

Added 2026-11-18 (ai-therapist-299, ai-therapist-303). Some of the most serious statements
carry no crisis word because their subject was said in an earlier turn. After a turn already
flagged for passive ideation, "I'm going to do it tonight, I've decided." matched no keyword,
moderation scored it 10, the assessor was never called, the turn scored 0 and nobody was
paged. A means-relevant question straight after a loss was never scored either.

Two things now send a **keyword-free** participant turn to Stage 2 (the *context wake*,
`method: 'llm_context'`):

1. **The session is already risk-bearing**: it carries a crisis flag, or a screen (keyword,
   sweep or moderation wake) scored one of its last 10 participant turns at 25 or more (the
   low band, which is also the steering threshold). Every participant turn in such a session
   is assessed, whatever its wording ("yes", "tonight", "lol jk"). Context-wake rows do not
   themselves reopen the window, so in an unflagged session it closes 10 turns after the
   screen's hit. A staff unflag is respected: turns scored before the unflag stop counting.
2. **The message carries a context-dependent signal**, in any session
   (`detectContextSignals`): intent, plan or timing with the object left implicit ("I'm going
   to do it", "I've decided", "tonight's the night", "I have what I need"); a goodbye ("this is
   the last time we'll talk", "you won't have to listen to me much longer"); or a
   means-relevant question ("how much is too much", "lethal dose", "most dangerous in large
   amounts"). These patterns **never score on their own**. A match is only a question put to
   the assessor, which reads the conversation and decides: the same sentence about a job
   application comes back near 0.

Since 2026-11-18 the signal list has two more kinds, both of which only wake the assessor
and never score:

- **`slang`**: shorthand and euphemism that also has ordinary meanings ("kms", "ctb", "off
  myself", "I want out"). Routed to the assessor, whose rubric explains the terms, instead of
  being given a tier score, so "ran 5 kms" is not matched at all and an unrelated "CTB"
  costs one assessor call and nothing else.
- **`third_party`**: someone else's suicidal statement or act ("she's going to kill herself
  tonight", "he has a plan to end his life"). See "Third party at risk" below. Third-person
  talk is far more often a film, the news or a past loss, so the screen never scores it; with
  the assessor down such a turn scores 0.

And a third reason for a context wake:

3. **The turn answers a safety question** (`repliesToSafetyQuestion`). When the assistant's
   last turn asks about suicide, self-harm, wanting to die or the participant's safety, the
   reply is assessed whatever it says and however calm the session: "yeah. kind of. most
   nights." carries no word of its own, and in a calm session it scored 0 with no assessor
   call (3 of 5 runs, session never flagged). The assessor is told the message is the answer
   to that question (`answers_safety_question` on the risk row). A reply to an ordinary
   question is not assessed. On chat this is one extra small SELECT per turn
   (`needsContextAssessment` reads the last few messages) so the assessment runs before the
   reply. Cost: one assessor call per reply to a safety question.

**Low-content fragments are the exception (2026-11-18, ai-therapist-349).** In a real voice
session "wait, stop", said during a breathing exercise, was transcribed as "would stop". The
session had one earlier low-band turn (work stress), so the fragment was context-assessed,
and the assessor completed it into a sentence: 50, "passive ideation, hopelessness", "the
phrase 'would stop' suggests a passive wish to escape". The session was flagged, the
assistant asked the ideation question, the vendor's filter cut the call on that question,
and staff were paged. Two changes:

- **Guard** (`isLowContentFragment`): a message of at most six words made ONLY of filler,
  acknowledgement and stop/go words (a closed list: stop, wait, would, ok, yeah, no, um,
  hold on, ...) is not sent to the assessor merely because the session had an earlier
  low-band turn. It scores 0 and its risk row carries `low_content_fragment: true`. It is a
  word list and not a length rule: "tonight", "pills" and "bought a gun" are not on it.
  Words of leaving are not on it either (go, going, now, let, me, bye, goodbye): "just let
  me go", "no going back now" and "I can go now. Goodbye." are made only of stop/go words,
  match no farewell signal, and must reach the assessor in a session that already holds a
  low-band turn (review of PR 65). The
  guard does not apply when the fragment answers an assistant safety question ("yeah" is
  the disclosure there), when it matches a context signal, in a session already at medium
  or high, on a periodic sweep, or when the session state could not be read.
- **Rubric**: a "Fragments" rule tells the assessor that voice transcripts arrive in pieces
  and mis-heard, to score only what was said, and not to complete a few empty words into a
  sentence about dying or escape. This covers what the guard lets through (a medium session,
  a sweep, a longer fragment).

Measured on six golden rows (three runs each): before, "would stop" scored 50 in 1 of 3 runs
and the variants 15 to 30; after, the five fragment rows score 0 in 15 of 15, and the longer
"wait, stop. can we do something else" scores 0 (2 of 3) or 25 (1 of 3: steering, no flag).

On a context wake the assessor is told that no keyword matched, and is given one line of
**session risk context** in addition to the transcript: the highest recent severity band, how
many turns ago, the factors noted then, and whether the session is flagged. That carries the
referent when it has scrolled out of the 10-message transcript window. The same line is added
to keyword and sweep assessments in a risk-bearing session. It gives the band and never the
number, and the prompt tells the assessor it is background, not new evidence: handed its own
previous score, the assessor repeated or outbid it turn after turn.

Three guards keep "assess every turn" from inflating a session:

- **No trajectory bonus on a context wake.** The assessor has already been given the run-up,
  and a per-turn bonus compounds (each inflated score becomes the next turn's run-up).
  Observed before this guard, on the slow-drift script: assessor scores 30 / 50 / 65 / 80
  recorded as 50 / 65 / 80 / 95. The bonus is still computed and logged
  (`trajectory_applied: false`), and still applies to keyword and moderation turns and to a
  sweep in a calm session. A periodic sweep in a risk-bearing session keeps it only when its
  score exceeds the level the session already holds: that turn is picked by a counter, the
  assessor has the same session context, and its run-up is the context-wake rows before it.
  An assessor that merely repeats the session's level produces a flat line, which the
  trajectory reads as "deteriorating" (+15); 15 above the stored score is always a re-flag,
  and from 60 it is a high flag and a page for a turn that said nothing new (found in review;
  measured live, three neutral turns in a session flagged at 65 each came back 60; pinned in
  `crisisDetection.contextClass.test.ts`).
- **Context-signal floor** (`context_signal_floor`). The assessor is not stable at the band
  edge: "This is the last time we'll talk" after a passive-ideation turn came back 80 on one
  live run and 65 on the next. The score cannot land below 75 when three things agree: the
  screen matched a *strong* signal of intent or goodbye, neither negated nor retracted; the
  session already holds medium-or-higher risk; and the assessor reports, as a literal yes/no
  observation (`states_intent`), that the latest message itself states intent, a decision, a
  plan, means at hand, a time, a goodbye or an act already done. The observation is what
  keeps the floor off help-seeking: "ok, I'll do it tomorrow", agreeing to call the
  counseling center, uses the words of a strong signal, and a first version of the floor that
  keyed on the assessor's score (which stays at 50 turn after turn in a flagged session)
  raised exactly that sentence to 75. Known cost: a genuinely ambiguous sentence ("Fine. I'll
  just do it now and get it over with." after being offered an appointment, two turns after
  passive ideation) is read as intent by the assessor and is raised, which pages.
- **Means-inquiry floor** (`means_inquiry_floor`). When the screen matched a means-relevant
  question (a regex) **and** the assessor reports, as a literal yes/no observation
  (`loss_or_disclosure`), that the participant has told of a significant loss or setback,
  hopelessness or a disclosure somewhere in the transcript, the score cannot land below 50
  (medium: flag, dashboard alert, steer, no page). Reason: on the catalogue's CRI-08 probe the
  assessor banded the turn 50+ on some live runs and 10 to 15 on about half, reasoning
  "appears to be for an academic purpose" or labelling the turn `negated` because a class
  paper was mentioned. It answered the observation the same way every time. The assessor's
  `context` label is deliberately not an exemption for this floor (`negated` is how it files
  the pretext), and the floor never rises above medium: an earlier version that did paged for
  "It really is just for the paper" on the strength of its own previous output.

What the context wake changes downstream:

- A context-wake turn scored high in a session below high **escalates exactly like a keyword
  turn**: high flag, `high_risk_emergency`, on-call page, `session:crisis-emergency`, forced
  safety-protocol steer.
- In a session **already flagged high**, a context-wake turn scored high does not force the
  safety-protocol steer again (it follows the ordinary 3-minute cooldown) and does not re-flag
  unless its score exceeds the stored score by more than 10, the existing re-flag rule. A
  re-flag asks for a page; whether one is sent is the paging policy's decision (below). Without this, every short answer in a crisis conversation would restart the
  assessment protocol. Keyword turns are unchanged and still force.
- **A subject label never stands on a turn that also carries the participant's own risk**
  (review of PR 65). The label switches off the suicide ladder, swaps the steer for one that
  says not to ask about the participant's own suicidal thoughts, puts "not their own" / "not
  self-harm" on the page and, for risk to others, withholds the crisis-line card. Live, "I
  want to kill him and then myself" came back 100, context `harm_to_others`, `states_intent`
  true, and was handled as risk to others only. Now the label is dropped (the turn is the
  participant's own risk, with the other fact kept as a factor and `subject_overridden` on the
  risk row) when the assessor observes the participant's own intent (`states_intent`), or,
  for harm to others, when a first-person keyword is in the same message. A quoted keyword
  does not undo a third-party label ("she texted 'I want to kill myself'"). NOT covered:
  own risk said without a keyword and not observed as intent ("I know where he parks. And
  after that I don't plan on being around." came back `harm_to_others`, 85, `states_intent`
  false). The rubric has a "score their OWN instead" sentence for a third party and none for
  harm to others; one was tried in review and withdrawn, because the help-seeking row
  `det-help-04` paged in 1 of 9 runs with it and 0 of 6 without. It needs adding with the
  live calibration files run several times.
- **A change of who is at risk always flags** (review of PR 65). The re-flag rule compares
  scores, and a third party's active crisis scores 80-100. After "my roommate is going to
  kill herself tonight" (90, paged as a third party at risk, "not their own"), the
  participant's own "I've been thinking about killing myself too" (75) is not 10 points
  above 90, so it raised no flag, no crisis event and no page. A high turn about someone
  the session's automatic high flags have not been about (the participant, a third party,
  or a person they may harm; read from the `subject` on the `auto_flag` rows) now flags and
  pages whatever the stored score. The crisis event's notes and the dashboard alert say
  what changed; the `auto_flag` row carries `trigger: 'new_subject'`.
- The periodic sweep is independent: a context wake does not reset its counter, and when a
  sweep is due on the same turn there is one call, labelled `llm_sweep`.

**Cost and latency.** One `gpt-4o-mini` call (about 1.5k input tokens, 2 to 3.5 seconds with
the moderation screen ahead of it, roughly $0.0003) per participant turn, only in risk-bearing sessions, plus the occasional signal match
elsewhere. A calm session pays one small `SELECT` per turn and nothing else.

- *Voice*: scoring already runs off the reply path; the participant hears no delay.
- *Chat*: a keyword-free turn that needs a context wake is assessed **before** the reply, so
  the steer lands on that same turn, but for at most 6 seconds
  (`CHAT_CONTEXT_ASSESS_DEADLINE_MS`; measured live, the moderation screen plus the assessor
  took 2 to 3.5 seconds, with an occasional call over 5). Past that the reply ships unsteered, the pipeline keeps
  running in the background (it still flags and pages when it finishes), and its steer lands on
  the next turn. Calm keyword-free turns are still scored after the response, as before.

**Assessor down on a context wake.** The fallback for a keyword-free turn is 0 (plus whatever
the moderation screen reads), with one exception that fails toward detection: a *strong*
signal (first-person "going to do it", "tonight's the night", "this is the last time we'll
talk", a lethal-dose question, ...), neither negated nor retracted, in a session that already
holds medium-or-higher risk, scores 75 (high: flag and page) from the screen alone, recorded
as `context_fallback`. Weak signals ("I've decided", "I won't be here"), calm sessions,
"I'm not going to do it" and "jk" stay at 0. What may cancel a strong signal is deliberately
narrow, because the words of retracting are also the words of insisting: a negation has to
sit inside the signal or govern it through a verb of thinking or saying ("I don't think I'm
going to do it"), so "I don't care anymore I'm going to do it tonight" stands; a negated
retraction word is not a retraction ("I'm not kidding", "this isn't a joke", "I haven't
changed my mind"); and "instead" retracts only after the signal and never as "instead of ...". Retry budget: the patient policy
(`CRISIS_PATIENT_RETRY_POLICY`) like every other keyword-free call, dropping to the short one
(`CRISIS_RETRY_POLICY`) for context wakes while an assessor incident is open (see "Fallback
behavior"), so a flagged session does not queue 30 seconds of retries on every turn of an
established outage.

`score_factors` records `context_wake`, `context_signals`, `session_context`
(`flagged`, `flagged_severity`, `recent_peak`) and, when they applied, `context_fallback`,
`context_signal_floor`, `means_inquiry_floor`, `llm_states_intent` and `llm_loss_or_disclosure`.

A gated live test (`crisisDetection.context.live.test.ts`, 35 `gpt-4o-mini` calls, about a
cent) checks the real assessor against these bands: intent and goodbye after ideation at 75+,
the same sentences about a job application under 25, the means probe after a loss in the
medium band (five times over), ordinary turns and agreed safety steps in a flagged session
under the paging band (65), a retraction not raising a high session. A second gated file,
`crisisDetection.wakes.live.test.ts` (about 45 calls), covers the 2026-11-18 additions: a
third party at risk, shorthand, the reply to a safety question, the check-in, harm to others,
and the 65 cutoff sitting between passive and active ideation. Run both after any change to the assessor prompt or
`crisis.risk_model`:

```sh
RISK_CONTEXT_LIVE=1 RISK_CONTEXT_OPENAI_KEY="$OPENAI_API_KEY" \
  npx vitest run src/server/services/crisisDetection.context.live.test.ts
```

### Stage 2 — LLM context assessment

When Stage 1 matches (or a context wake or a periodic sweep applies — see above and below), the recent conversation
excerpt (raw, unredacted text, capped at ~6000 characters) is sent to OpenAI `gpt-4o-mini`,
which returns a risk score (0–100) and a graduated severity: `none`, `low`, `medium`, or
`high`. The prompt explicitly downgrades references (hotline names, media), negations
("I'm not suicidal"), and ordinary worry or past loss concerning someone else; someone
else's CURRENT crisis is scored by its own rule (see "Third party at risk"). If the returned
severity is malformed, it is derived from the score bands (`>=65` high, `>=50` medium,
`>=25` low; see "Severity bands").

Note for IRB/privacy accounting: this means unredacted conversation excerpts are transmitted
to OpenAI for risk assessment, in addition to the conversation-generation calls themselves.

### Periodic sweep

Because keyword screens miss risk expressed without trigger phrases, the system also runs a
full LLM assessment every 8 participant messages (`SWEEP_EVERY = 8`) even when no keyword has
matched. Sweep results feed the same scoring/response path (`method: 'llm_sweep'`).

### Trajectory bonus

`trackEmotionalTrajectory()` examines recent `risk_score_history` rows and adds a bonus of up
to +20 to the risk score when scores are consistently rising (e.g., +15 for a monotonic
increase). Trajectory output is logged with each assessment.

### Fallback behavior

If the LLM call fails, the keyword tier score stands as the provisional score
(`method: 'keyword_fallback'`), with severity derived from the same bands — detection degrades
to keyword-only rather than failing silent. With no keyword match and no LLM, the result is
`llm_unavailable` (indeterminate, score 0).

**The degraded state is visible to staff** (ai-therapist-190; `riskAssessorHealth.service.ts`).
A failed assessment has already used its retry budget, so:

- **Each affected turn** carries `assessment_degraded: true` and `llm_error` (the failure
  class) in `risk_score_history.score_factors`; a failed moderation screen carries
  `moderation_unavailable`.
- **Each affected session** gets one `intervention_actions` row (`action_type`
  `external_api_called`, `action_details.degraded = 'risk_assessor'`, with the reason) and one
  `session:risk-assessment-degraded` event, on its first failed assessment. No migration: the
  row uses an existing action type.
- **Each incident** (two failed assessments in a row, in any sessions, with no success
  between them) produces one error log, one `system:risk-assessment-degraded` event to the
  researcher room and **one page to the on-call**, at most one an hour. The next successful
  assessment closes the incident (`system:risk-assessment-restored`); nobody is paged for a
  recovery. A spend-cap rejection is paged by its own alert (from the first rejection,
  repeating hourly) and is not paged a second time here.

### Passive logging

`risk_score_history` rows are inserted for every analyzed message (including score 0), giving
researchers a complete passive audit trail. `score_factors` records the keyword score,
matched keywords, LLM assessment, and method.

---

## Third party at risk (2026-11-18, ai-therapist-326)

Owner decision: a participant reporting SOMEONE ELSE's active crisis flags high and pages
staff. Until this change the assessor rubric capped anything about another person at 0-20,
and the screen did not match third-person statements at all, so "My roommate just texted me
that she's going to kill herself tonight" scored 0 with no assessor call.

- **Rubric.** The assessor keeps context `bystander` for anything about someone else and
  scores by what is happening to that person: an active or imminent crisis (stated intent, a
  plan, a method or a time, an attempt made or under way, a goodbye or suicide note, or a
  suicidal statement followed by not being reachable) is 80-100, high; passive or
  long-standing thoughts with nothing imminent are 50-65, medium (flag, no page); ordinary
  worry ("my friend has been really down lately"), a past and resolved crisis, a death that
  has already happened and media are 0-20.
- **How staff can tell.** A flag whose assessor context is `bystander` at medium or high is
  labelled everywhere a person reads it, with no schema change:
  - the on-call page's first line reads `URGENT: AI-Therapist HIGH crisis flag (third party)`
    and its second `THIRD PARTY AT RISK: the participant is reporting someone else in crisis,
    not their own.` (`buildCrisisPageMessage`); the thread-message page carries the same
    sentence;
  - `crisis_events.risk_factors` starts with `third party at risk (reported by participant)`
    and `crisis_events.notes` carries the label;
  - the `session:crisis-detected` and `session:crisis-emergency` dashboard events carry
    `subject: 'third_party'` and the label in their message; the work-queue item title ends
    `- third party at risk`;
  - `intervention_actions.action_details` carries `subject: 'third_party'` on `auto_flag`,
    `high_risk_emergency`, `crisis_sms_alert`, `safety_protocol` and `risk_steering`;
    `risk_score_history.score_factors` carries `third_party: true`.
- **What the model is told.** `THIRD_PARTY_GUIDANCE` / `CHAT_THIRD_PARTY_GUIDANCE` replace
  the safety-protocol steer: help the participant act for the other person (911 when the
  danger is immediate, 988 for guidance on helping someone else, bring in someone who can
  reach them, do not keep it secret), then check on the participant. The structured risk
  ladder (`run_risk_check`) is not demanded for that turn: it asks about the participant's
  own thoughts. If the participant voices ideation of their own, the assessor scores that as
  `genuine` and everything runs as usual.
- **Not changed.** The crisis resource card, the session-timer lift, and the adverse-event
  auto-draft on a high flag all still run for a third-party flag. The draft's summary now
  begins `SUBJECT: THIRD PARTY AT RISK` (or `SUBJECT: RISK TO OTHERS`), so it is not read as
  the participant's own crisis; whether it is a reportable event for the participant is for
  the study team to decide.
- **Vendor cuts.** When the voice vendor ends a session whose high flag was about someone
  else, the page says so ("the HIGH flag was about SOMEONE ELSE ... No risk of the
  participant's own was flagged") instead of "their risk before the cut was HIGH", and such
  a page does not absorb a later page about the participant. `resolveIncidentPeak` returns
  the `subject` of the incident's peak and the participant's own level.
- **Own risk in the same message wins.** A turn the assessor labels as about someone else
  is handled as the participant's own risk when the assessor reports the participant's own
  intent, when a first-person crisis keyword is in the message, or (risk to others) when the
  message also says goodbye ("I know where he parks. And after that I don't plan on being
  around."). The page then adds `ALSO: the same message describes thoughts of harming
  another person.`

## Risk to others (2026-11-18, ai-therapist-330)

Owner decision: "bring them down from the ledge and notify staff". A credible statement of
intent or planning to harm another person ("I keep picturing hurting him. I know where he
parks.") is flagged and staff are notified exactly as for a high self-risk, and the model
de-escalates. Before this change the keyword tiers (built around self-harm) matched nothing,
so on the realtime path the turn scored 0 with no assessor call; on chat the moderation
screen sometimes woke the assessor, which paged on the idiom ("I'm going to kill my lab
partner") and steered the reply with the suicide protocol.

- **Screen.** A `harm_others` context signal: a violent verb with a person as its object
  ("hurting him", "kill my lab partner"), thoughts or images of violence, and veiled threats
  ("get what's coming to him", "I know where he parks"). It only wakes the assessor and never
  scores, because the idiom is the same words: with the assessor down these turns score 0.
  Objects that are not people ("hurt my back", "kill my GPA") are not matched.
- **Rubric.** A new assessor context, `harm_to_others`. Idiom, exaggeration, media and
  ordinary anger are 0-10 (`reference`); credible intent or planning (thoughts presented as
  real plus anything that makes it more than venting: where the person will be, what they
  would do, a plan, means, a time) is 75-100; frightening unwanted thoughts the participant
  rejects, or rage without plan or intent, are 25-50 and never high. `states_intent` stays
  about the participant's own suicide or self-harm.
- **How staff can tell.** Same places as a third party at risk, with subject
  `harm_to_others`: the page reads `URGENT: AI-Therapist HIGH crisis flag (risk to others)` /
  `RISK TO OTHERS: the participant is describing thoughts of harming another person, not
  self-harm.`; the crisis event's first factor is `risk to others (thoughts of harming
  another person)`; dashboard events, the work-queue title and the intervention rows carry
  the subject; `risk_score_history.score_factors` carries `harm_to_others: true`. No schema
  change.
- **What the model is told.** `HARM_TO_OTHERS_GUIDANCE` replaces the safety-protocol steer
  on voice and chat: stay, slow down, acknowledge the anger without agreeing anyone deserves
  harm, ask calmly and without accusation what is happening and whether they intend to act,
  no reflex questions about the participant's own suicide, no lecture or threat, no help
  reaching the person, honesty about the team reviewing flagged conversations if asked, and
  911 only when harm is imminent. It lives with the other crisis steers
  (`crisisIntervention.service.ts`), not in the base system prompt. The structured ladder is
  not demanded, and the crisis-line resource card is not opened automatically for these turns.
- **Not decided here.** What the on-call does on such a page (duty-to-warn questions, who is
  contacted) is a study-team and legal matter; see `docs/on-call-sop.md`.

## Pre-session check-in (2026-11-18)

The check-in's free text ("what's on your mind", "what do you want from today") is quoted
into the model's prompt and, until this date, went nowhere else: "I don't really want to be
alive" in the check-in followed by "hi" left no risk row, no flag and no steer (5 of 5 runs).
The three session-start routes (`/api/chat/start`, `/api/live/session`,
`/api/grok/session`) now pass it to `runCheckinCrisisScreen`, which runs the ordinary
pipeline on it as if it were the first participant turn: same screen, same assessor, same
flag, page and steering. The risk row has no `message_id` and carries `source: 'checkin'`;
the crisis event's factors end with `from the pre-session check-in`. On chat the start waits
for the result (up to the 6-second context deadline) so the steer is in place before the
first reply; on GPT-Live voice it runs after the sideband attach and is not awaited. On
Grok voice the socket does not exist yet at session start: the flag and the page go out at
once, and the steer the check-in earned is held (five minutes at most) and delivered when
the voice session is configured (`deliverPendingSteer`). While the start
of the session is still inside the assessor's 10-message window the check-in text is also
shown to the assessor as the participant's first words, so a later "yeah" can refer to it.
The mood number is not scored, and the age-eligibility gate does not read the check-in
(unchanged).

## Graduated Response

**File:** `src/server/services/crisisIntervention.service.ts`

Responses are tiered by severity/score:

- **High severity**: emit `session:crisis-emergency` to the session room and to
  `admin-broadcast` (all monitoring researchers), set monitoring frequency to `critical`,
  page the on-call researcher by SMS (when paging is configured), and inject the safety
  protocol steering (below). The session-room copy (which opens the participant's crisis
  resource card) goes out FIRST, from the pipeline the moment the turn scores high and
  again at the top of `executeHighRiskResponse` (deduplicated), before any log, page or
  steer: on GPT-Live the vendor's filter can close the voice session half a second into
  the crisis reply, and the card must not depend on the session surviving
  (`crisisResources.ts`, ai-therapist-293). The same event is also sent when the vendor
  stops or cuts a reply, with `severity: null` and a `reason`; see `docs/gpt-live.md`
  section 7.
- **Medium severity**: real-time dashboard alert plus a work-queue item for the study team.
  No SMS page for the flag itself; a vendor cut of a medium-risk voice session does page
  (below).
- **Whether a high-severity event becomes an SMS** is decided in one place,
  `crisisPaging.service.ts` (ai-therapist-350; before it, one person in one crisis produced
  four texts in 2.5 minutes because each recovery session is a new session id and "risk is
  high" and "the vendor ended the session" paged independently). The rules:
  - The first page for a participant always goes out at once.
  - De-duplication is **per participant, across sessions**, for **15 minutes** from the last
    *delivered* page (the on-call acknowledgement target in `docs/on-call-sop.md`; the window
    is not extended by folded events). An event that says nothing new or worse than a page
    already delivered in that window is folded into it: no SMS, an `external_api_called`
    intervention row with `reason: folded_into_recent_page` and the `action_id` of the page
    it was folded into, and a `session:page-decision` event to the admin dashboards. Anonymous
    sessions have no participant to follow, so they de-duplicate per session only.
  - New, worse information pages immediately inside the window: a higher level (vendor cut at
    medium, then high, then a high score of 90 or more, the stand-in for "attempt in
    progress"), or the first vendor termination of a high-risk session.
  - **A recovery session's high flag is a stamp, not a disclosure.** A recovery session is
    flagged high the moment it starts, at the score of the participant's last flagged session
    or at 100 when there is none, so the re-flag rule (severity rise, or more than 10 above
    the stored score) cannot fire in it. The pipeline therefore hands every high turn that was
    not re-flagged to `handleHighTurnWithoutReflag` (`crisisPipeline.service.ts`,
    ai-therapist-363). When the session's only high flag is the `recovery_continuation` stamp,
    the participant's first real high turn there is **recorded and paged**:
    - a `crisis_events` `flagged` row at high severity with the score the assessor gave the
      turn, its factors and its `message_id` (`previous_risk_score` keeps the stamp's
      placeholder), and the session row's `crisis_risk_score` / `crisis_flagged_at` corrected
      from the placeholder to what was assessed, in one transaction, once per session
      (`recordRecoveryDisclosure`); the re-flag rule then works normally for the rest of the
      session;
    - an on-call page, under the same folding as any other;
    - the `auto_flag` intervention row (`recoveryDisclosure: true`), the dashboards' crisis
      events and the care-team work item;
    - an adverse-event draft, unless the incident (the recovery chain) already has one drafted
      from a crisis flag: one incident, one report.
    It does not re-run the high-risk response, so no second safety-protocol steer is added. A
    session with a real high flag is left alone: nothing is written or paged from this path.
    If the record cannot be written, or takes longer than 2 s, the page goes out without it.
  - **Vendor content-filter cut**, by the participant's peak risk in the incident: crisis
    flags (including a researcher raising a session's risk by hand, `risk_score_updated` /
    `severity_changed`) and the scores the assessor gave their turns in `risk_score_history`.
    The incident is this session and the **recovery chain** behind it (each recovery session
    continues the participant's session whose vendor cut was recorded just before it started,
    else the one started last: no column links them), however long the chain has run, with a 12 h
    backstop; plus the participant's other sessions in the last two hours. The automatic
    `recovery_continuation` stamp never counts. **high** pages once per incident;
    **medium** pages once per incident, worded "vendor cut, NOT a high risk score", says the
    participant's answer may be what was lost (the filter typically cuts the screening
    question itself) and asks the on-call to consider reaching out; **none**
    does not page at the cut: it is recorded, shown on the dashboard, and checked again after
    3 minutes, when the on-call is paged if the participant has not spoken in any session
    since (the filter can end a session before the last words reach us). That later page
    states the participant's risk as it is when the check runs: if the turn the filter cut on
    was scored high after the cut, it is an URGENT page at the high level, not "nothing they
    said was flagged". Unreadable risk is treated as medium, not as none.
  - **The 3-minute silence check is owed by the stored row, not by the server process**
    (ai-therapist-362). The cut's `external_api_called` row carries
    `paging.silenceCheck: { state: 'pending' }`. The process that recorded the cut runs the
    check from a timer at 3 minutes; at startup, and every 3 minutes on the safety backstop
    tick (`messageSafety.service` `runSafetyBackstopPass`), `sweepSilenceChecks` reads every
    unfinished check: one that is due runs at once, one that is not gets a timer for the time
    it has left. So a restart or deploy inside the 3 minutes changes nothing. Whoever runs a
    check first claims it with one conditional `UPDATE` (`state: 'running'`), so two app
    instances cannot both run it, and its result is written back (`state: 'done'`, with
    `outcome` and the page's `action_id`) so it never runs twice. A claim whose process died
    is retried after 60 s; if that produces a second run, its page folds into the first when
    that was delivered. A check whose page no channel accepted is not done: it goes back to
    `pending` with `attempts` counted and the next sweep sends it again. A check found more
    than 15 minutes late (a long outage), or still undelivered then, is not paged: it is marked
    `expired`, logged at error level and shown on the dashboards (an undelivered one as "page
    NOT DELIVERED ... On-call has NOT been told"). The silence sweep runs beside the stale-scan
    re-scan on the same tick, not behind it. Harness and
    demo sessions are never swept (their check runs only in the process that recorded the cut).
  - Only a page known to be delivered absorbs another. Lookup failures, timeouts (2 s) and an
    undelivered page all fail toward paging. The sandbox check and the history lookup run
    together, and the admin-config read inside the send has its own 2 s timeout, so a database
    that has stopped answering delays a first page by about 2 s (a vendor-cut page, which also
    reads the participant's risk first, by about 4 s).
  - Every page text has a `Why:` line: `RISK SCORE n/100`, `VENDOR CUT`, or
    `VENDOR SESSION LIMIT`. A risk page says "from what the participant said" only when the
    risk pipeline scored a turn; when the flag was raised by the model's `escalate_to_human`
    tool it says the score was set by the assistant asking for a human, and that it is the
    fixed score for that request.
  - **Two paging channels, in parallel** (ai-therapist-355; `crisisAlert.service.ts`,
    `docs/on-call-paging-setup.md`): the iMessage bridge and, once
    `CRISIS_SMS_AWS_REGION` and `CRISIS_SMS_ORIGINATION_IDENTITY` are set, a carrier SMS
    through AWS End User Messaging (`SendTextMessage`). With either variable unset the second
    channel does not exist and nothing changes. Both go to the same on-call phone and obey
    the same `crisis_alert.enabled` switch. **Delivered, for the folding rule above, means at
    least one channel accepted the page.** Each channel has its own 5 s timeout, so one that
    hangs never delays the other. The page's row records every channel attempted, whether it
    accepted, an error code and the provider message ids (`paging.channels`; no phone number,
    no message text). If every channel fails the row says `not_delivered`, the server logs
    `ON-CALL PAGE NOT DELIVERED` at error level, emits `system:on-call-paging-failed` to the
    researcher room and a `session:page-decision` notice ("Page NOT delivered") to Live
    Monitoring; a single failed channel is reported the same way as degraded paging. The SMS
    copy is the same text: plain 7-bit, one SMS up to 306 characters (two segments), otherwise numbered parts
    (`(1/2) ...`) with the `Why:` line in the first. `npm run page:test` sends a labelled TEST
    page through each configured channel; no route, socket event or tool can.
  Not covered (unchanged): system alerts (assessor outage, spend cap, lost monitoring
  connection, eval drift) and thread-message alerts, which have their own throttles or none.
- **Risk score >= 25 (low and up)**: the system injects hidden de-escalation steering
  guidance into the model's context (`session.instructions.append` over the sideband for
  voice sessions; system message for chat). This changes how the agent responds — grounding, safety-checking,
  surfacing crisis resources — but is not shown or announced to the participant. Steering
  is rate-limited to once per 3 minutes per session and every injection is logged in
  `intervention_actions` (`risk_steering` / `safety_protocol`) and broadcast to the admin
  dashboard (`session:risk-steering`).

The automated system never sends a chat message *as itself* to the participant; it shapes the
agent's replies via steering and surfaces resources through the agent and the UI. The
researcher on duty decides whether and how to intervene directly.

### The agent must not hang up (2026-11-01)

Two things used to make the agent end the session on a suicidal disclosure:

- **The prompt.** The stored Crisis Protocol (seeded by migration 019 and never
  migrated since) told the model to "immediately stop normal conversation",
  state that it "cannot handle crises", give resources and ask whether the
  participant will seek help. A voice model following that says goodbye and
  calls `end_session`. Migration 117 rewrites the block in both stored prompts
  (and `DEFAULT_SYSTEM_PROMPT`): stay, respond directly, offer the resources
  alongside yourself, be honest about limits without withdrawing, and never
  end the session because risk came up.
- **The tool.** `end_session` now refuses a model-initiated end on a
  crisis-flagged session (`toolRegistry.refuseCrisisEnd`). The refusal is the
  tool result the model sees ("the session was NOT ended ... stay with them"),
  is logged as `intervention_actions.model_end_refused`, and the browser is
  told either way: an accepted end emits `session:end-approved`, which is the
  only thing that makes a GPT-Live browser tear the call down for a
  model-initiated end (a lost message fails safe: the server backstop closes
  the live session and the browser ends on `session.closed`). Under Grok Voice
  the proxy forwards `end_session` to the browser only once the end is
  confirmed. Three callers legitimately steer a session to end — the duration
  limit (nudge and hard limit), the admin wind-down and the admin trigger-tool
  — and they record a single-shot grant in `utils/modelEndAuthorization.ts`
  first. A participant who clearly asks to stop is honoured: the model passes
  `participant_requested: true`, which is logged as
  `model_end_participant_requested` because the model's word is the only
  evidence. The guard fails open if the crisis lookup throws. Migration 117
  fails (rather than warns) if a stored prompt matches neither known Crisis
  Protocol variant.

The third way a crisis conversation vanishes — OpenAI's own content filter
closing a GPT-Live session with reason `content` — is handled by the recovery
flow described in `docs/gpt-live.md` (incident 2026-09-11).

The fourth is a clock. Our own `session_limits.max_duration_minutes` is lifted
to the vendor ceiling on a high flag (`crisis_timer_extended`), the model is
told the time at fixed points so it can prepare the participant, and the
vendor's own 60-minute expiry on a flagged session runs the same recovery as
the filter. See `docs/gpt-live.md` section 11 (ai-therapist-281).

---

## Auto-Flag Condition

**File:** `src/server/index.js` (crisis detection block)

```js
const shouldFlag = riskAnalysis.severity === 'high' &&
  (!session.crisis_flagged || riskAnalysis.riskScore > currentScore + 10);
```

If the session is already flagged and the new score is not meaningfully higher, the flag is
not re-triggered (avoids duplicate events on repeated signals in the same session).

---

## Manual Flag / Unflag

Researchers use the SessionDetail UI to flag/unflag with any severity and optional
notes. Endpoints:

- `POST /admin/api/sessions/:sessionId/crisis/flag`
- `DELETE /admin/api/sessions/:sessionId/crisis/flag`

Both require `requireRole('therapist', 'researcher')`.

---

## Database Schema

### `therapy_sessions` additions

| Column                 | Type          | Notes                                        |
|------------------------|---------------|----------------------------------------------|
| `crisis_flagged`       | BOOLEAN       | Default FALSE                                |
| `crisis_severity`      | VARCHAR(10)   | `low`, `medium`, `high`                      |
| `crisis_risk_score`    | INTEGER       | 0–100                                        |
| `crisis_flagged_at`    | TIMESTAMPTZ   |                                              |
| `crisis_flagged_by`    | VARCHAR(255)  | `system` for auto, username for manual       |
| `crisis_unflagged_at`  | TIMESTAMPTZ   |                                              |
| `crisis_unflagged_by`  | VARCHAR(255)  |                                              |
| `monitoring_frequency` | VARCHAR(20)   | `normal`, `high`, `critical`                 |

### `crisis_events` (audit trail)

Complete audit trail of all crisis management events. Columns: `event_id`, `session_id`,
`event_type`, `severity`, `previous_severity`, `risk_score`, `previous_risk_score`,
`triggered_by`, `trigger_method` (`auto` / `manual` / `system`), `message_id`, `risk_factors`
(JSONB), `intervention_details` (JSONB), `notes`, `created_at`.

### `intervention_actions`

Log of all automated and manual interventions, including every `risk_steering` /
`safety_protocol` injection. Columns: `action_id`, `session_id`, `action_type`,
`risk_score`, `action_details` (JSONB), `performed_by`, `performed_at`, `outcome`, `notes`.

### `risk_score_history`

Time-series passive log. Columns: `history_id`, `session_id`, `message_id`, `risk_score`,
`severity`, `score_factors` (JSONB: keyword score, keywords, LLM assessment, method; plus
`context_wake` / `context_signals` / `session_context` / `context_fallback` /
`context_signal_floor` / `means_inquiry_floor` for a context wake, and `assessment_degraded` / `llm_error` / `moderation_unavailable` when a screen was
down), `calculated_at`.

`method` values: `keyword_only` (no assessment was called for), `llm_assessed` (keyword hit),
`llm_context` (context wake), `llm_sweep`, `llm_moderation_wake`, `keyword_fallback` (the
assessor was called and failed).

### `human_handoffs`

Tracks handoffs initiated by researchers (manual process). Columns: `handoff_id`, `session_id`,
`risk_score`, `handoff_type`, `status`, `initiated_at`, `initiated_by`, `assigned_to`,
`completed_at`, `outcome`, `external_reference`, `notes`.

### `clinical_reviews`

Post-incident reviews. Columns: `review_id`, `session_id`, `risk_score`, `review_reason`,
`review_type`, `status`, `requested_at`, `requested_by`, `assigned_to`, `reviewed_at`,
`review_findings`, `recommendations`, `compliance_status`.

---

## Socket.io Events

### Emitted by server on auto-detection

**`session:crisis-detected`** → `admin-broadcast`
```json
{
  "sessionId": "...",
  "severity": "high",
  "riskScore": 82,
  "factors": ["kill myself"],
  "messageId": 123,
  "detectedAt": "...",
  "message": "HIGH risk detected (score: 82)"
}
```

**`session:crisis-emergency`** → session room + `admin-broadcast`
```json
{
  "sessionId": "...",
  "severity": "high",
  "riskScore": 82,
  "priority": "critical",
  "emergencyAt": "...",
  "requiresImmediateIntervention": true
}
```

**`session:risk-steering`** → admin dashboard, on every steering injection.

**`session:risk-assessment-degraded`** → admin dashboard (summary tier), once per session per
assessor outage: `{ sessionId, component: 'risk_assessor', reason, message, at }`.

**`system:risk-assessment-degraded`** / **`system:risk-assessment-restored`** →
`admin-broadcast`, once per incident: `{ component, reason, code, failures, since, message }`.
The admin UI does not render these three yet (ai-therapist-190 follow-up); the durable record
is the intervention row and the page.

---

## Verification Checklist

- [ ] Message with explicit intent ("kill myself") → LLM assessment runs, session flagged HIGH,
      `session:crisis-emergency` emitted to admin-broadcast, safety-protocol steering injected
- [ ] Reference/negation ("I'd never hurt myself") → LLM assessment runs, severity `none`,
      session **not** flagged, risk_score_history row inserted
- [ ] 8 participant messages with no keyword hits → periodic sweep assessment runs
- [ ] LLM unavailable + keyword hit → keyword tier score stands (`keyword_fallback`)
- [ ] LLM unavailable twice in a row → one `external_api_called` / `degraded: risk_assessor`
      row per affected session, one on-call page for the incident, none per message
- [ ] Passive-ideation turn, then "I'm going to do it tonight, I've decided." → second turn
      `llm_context`, session flagged HIGH, on-call paged
- [ ] "I'm going to do it tonight, I've decided." in a session with no risk → assessed, scored
      near 0, no flag
- [ ] Medium severity → dashboard alert + work-queue item, no SMS
- [ ] Manual flag via SessionDetail → still works, any severity selectable
- [ ] Manual unflag → session cleared, crisis_events audit record created
