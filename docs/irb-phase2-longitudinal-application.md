# Phase 2 IRB Application Draft — Human + AI Therapy: Better For Everyone (Phase 2, Longitudinal)

**Status: WORKING DRAFT (agent-drafted 2026-09-01/02, not reviewed by Nathan or Dr. Gaskin).**
**2026-09-09 revision (Nathan-directed): Data Collection, Analysis Plan, Confidentiality, and
Consent Documentation expanded to declare the full behavioral-telemetry set (engagement/
interaction telemetry, derived risk/affect measures, performance and technical telemetry)
with per-stream research justifications and an explicit non-collection boundary. Streams not
yet implemented in code (response-timing, interface-engagement events, expanded acoustic
features) are declared here and must ship — gated on Phase 2 approval — before launch.
Phase 1's live study is unchanged; nothing here authorizes new collection under 2025-519.**
**2026-09-21 literature update:** the "support from the scientific literature" field on OneAegis
page 1 was replaced with the September 2026 review in `docs/irb-phase2-literature-review-2026-09.md`
(section 1 is the field text; section 4 records the Risks, Subject Enrollment, and Benefits
edits applied in OneAegis the same day, including the Utah H.B. 452 alignment paragraph and
four launch-gated commitments). The Subject Enrollment and Risks text below is now superseded
by the OneAegis form text; treat the form as the source of truth for those sections.**
**2026-11-18 alignment revision (agent-drafted for Nathan and Dr. Gaskin).** (1) The two
launch-gated instrument commitments now exist: a psychosis-risk screen (PQ-B, 21 items, plus a
diagnosis-history item) in the eligibility screener, and emotional-dependence (ADS-9 Craving,
adapted) and problematic-use (BSMAS, adapted) items in the weekly survey, with decision rules;
thresholds are marked as the PI's decisions. (2) The red-team attachment is now generated from a
real nightly results file (`npm run irb:redteam`) and states the voice crisis ladder's real
status. (3) A new "System as built" subsection under Data Collection describes the voice, chat,
crisis, tool, memory and per-session-condition behaviour verified against the code, with a dated
model table. `docs/irb-phase2-submission-checklist.md` lists where each change goes in OneAegis
and Qualtrics. Because the OneAegis form text is not in the repo, the Subject Enrollment and
Risks additions below are written as text to merge into the form, not as a replacement for it.
Mirrors the OneAegis xForm section order of the approved Phase 1 application (2025-519-BYU,
scraped in full to `docs/irb-phase1-application.md`). Items marked **[DECISION]** have a
corresponding entry in `docs/irb-phase2-questions-for-nathan.md`. Text in plain paragraphs is
proposed answer text ready to paste into the xForm.

---

## Study Information

**Project Title:** Human + AI Therapy: Better For Everyone (Phase 2: Longitudinal Use)

**Principal Investigator:** James Gaskin (Information Systems) — same PI qualifications text as
Phase 1 (reuse verbatim; it is PI-specific, not study-specific).

**Co-Investigators:** none carried over — Erekson is NOT on Phase 2 (Nathan decision Q1,
2026-09-02). **[PENDING 2026-09-09]** Kimberly Sagers, LCSW (BYU CAPS, Marriott School
Specialist) has agreed in principle to be named as licensed clinical consultant and is
seeking her CAPS supervisor's permission — see docs/irb-phase2-sagers-personnel.md for the
staged personnel entry, role text, and Q17 implications (supervisor permission doubles as
CAPS documentation, retiring the placeholder support letter).

**Research personnel:** same RA roster as Phase 1 (Blatter, Hutchings, Limb, Ward, Villar
Barrios, Morrow, Ashcroft, Zapata Neira) — **[DECISION Q2]** confirm roster; the Personnel
Change event (#22038) on Phase 1 suggests it's already shifting.

**External researchers:** Triparna de Vreede (USF), de-identified analysis only, same as Phase 1.
**[DECISION Q3]** Does the Murtis Taylor / Case Western collaboration (Orlean
Grant-Whitehead's doctoral work) touch this protocol, or is that an entirely separate CWRU/MTHSS
IRB? Recommend keeping it separate: this BYU protocol covers BYU students only.

**Lay Summary (proposed):**

Phase 1 of this research (BYU IRB 2025-519) examined first impressions: single, supervised,
one-hour interactions between BYU students and a voice-enabled AI support agent, plus surveys
and therapist interviews. Phase 1's lay summary committed to submitting subsequent phases under
a separate IRB; this application is that submission.

Phase 2 asks the question Phase 1 could not: what happens when people use an AI support agent
as part of daily life over an extended period? Single-session studies cannot observe habit
formation, working-alliance development with an AI agent, longitudinal mood trajectories, or
how usage patterns change as novelty fades. Participants will be given access to the research
team's AI support agent for 8 weeks **[DECIDED Q4]** and encouraged to use it from their own
devices whenever they wish, with brief validated mood screeners (PHQ-2/GAD-2) administered
periodically inside the app and short weekly surveys outside it. The study will measure
engagement patterns, changes in psychological well-being indicators, perceived usefulness and
working alliance over time, and the performance of the system's safety architecture under
naturalistic use. Results will inform whether and how AI support agents can responsibly
complement (not replace) human mental health care.

---

## Introduction and Determination Checklists

Same as Phase 1: "I know I need IRB review." Not analysis of existing data only.

## Exempt Categories

**None of these categories apply** — same as Phase 1. Phase 1 was reviewed EXPEDITED under
category (7). Phase 2 adds unsupervised longitudinal use and voice recording; propose
requesting expedited review under categories **(6)** (voice recordings for research purposes)
and **(7)**. **[DECISION Q5 — audio]** Category 6 is only needed if we store audio; see the
recordings decision below. Full-board review is possible if the IRB judges naturalistic
longitudinal use of a mental-health AI to exceed minimal risk — the risk section below is
written to support a minimal-risk determination with strong monitoring.

## General Information

- Departmental scientific review: yes, same committee (Jeff Jenkins) unless changed.
- MRI: No. GDPR/international: No (US participants only, enforced at screening, same as Phase 1).
- Thesis/dissertation: No (for BYU; the CWRU dissertation angle stays on the CWRU side — Q3).
- Radiation: No. Investigator-initiated.

## Funding

Internal BYU funds / departmental funding, same as Phase 1. **[DECISION Q6]** Compensation
budget is materially larger than Phase 1 (longitudinal retention payments; see Compensation).
Confirm the department will fund it, and note flightdeck item ai-therapist-139: the OpenAI API
account should move off Dr. Gaskin's personal account onto a university-controlled org before
Phase 2 launches — both a compliance and an IRB-accuracy issue.

## Data Collection

Methods (check): Questionnaire or survey (online — Qualtrics); Other methods (AI support agent
app). Interviews: **[DECISION Q7]** optional exit interviews with a subsample (recommend yes,
n≈15-20, over Zoom) — they turn engagement-drop data into interpretable findings.

**"Other methods" description (proposed, updated to current system reality — do NOT reuse the
Phase 1 text, which no longer matches the deployed system):**

The AI support agent app ("AI Therapist Assistant"), developed and operated by the research
team, is a web application accessible from participants' own devices. It supports typed chat
and voice conversation. Voice runs on OpenAI's GPT-Live service, in which a voice model
handles listening and speaking and passes the substance of each reply to a separate reasoning
model that holds the full clinical instructions; typed chat runs on an OpenAI text model. The
research team has no business associate agreement and no zero-data-retention agreement with
OpenAI (verified 2026-09-09, disclosed to the IRB 2026-09-10; DECISION Q8). The section
"System as built" below describes each component and the data it creates.

Data collection is deliberately comprehensive on the behavioral layer — each stream below
maps to a named aim in the analysis plan — while remaining strictly minimal on the identity
layer (redaction, transient-only IP use, no device fingerprinting; see the deliberate
non-collection paragraph below).

What it collects, per session: conversation transcripts with timestamps; participant-initiated
mood check-ins; responses to brief validated screeners (PHQ-2, GAD-2) administered in-app;
session feedback ratings; crisis-detection events and system actions.

Engagement and interaction telemetry (aims: engagement trajectories, habit formation,
novelty decay, alliance development): session frequency, duration, and time of day;
inter-session intervals and usage streaks; per-turn interaction timing (time from agent
reply to participant reply; message length over time); interface engagement events during
a session (window focus/visibility changes, revisiting earlier messages, opening in-app
features such as worksheets, resources, and mood check-ins, and check-in completion vs.
skip); and the participant's typed-vs-voice modality choice per session.

Derived safety and affect measures (aims: safety-architecture performance, longitudinal
mood trajectories), computed automatically by the system: per-message crisis risk scores
with their component factors (keyword, sentiment, conversational-context, and trajectory
scores) and the resulting within-participant risk-score history; graduated severity
assessments and crisis-event records; participants' responses to the agent's structured,
laddered safety-check questions when risk is elevated, with the resolved risk band; a
per-turn affect trajectory (estimated emotional valence/arousal, computed from redacted
transcript text); and AI-generated session summaries and structured session notes
(computed from redacted content) supporting session-over-session continuity and
qualitative analysis.

System performance and technical telemetry (aims: safety-system performance and
operational reliability): per-turn agent response latency; model token usage; automated
quality evaluations of agent responses (LLM-judge ratings computed on redacted content);
client-side error reports (error message, page, and browser user-agent string — no page
content and no keystroke capture); and connection/session lifecycle events. IP addresses
are read transiently on each request to enforce the US-only eligibility requirement
(country-level geolocation check) and are not stored in the research dataset. **[DECISION Q5]** Voice sessions [are / are not]
recorded as audio. Current system capability stores session audio (WAV) in access-controlled
cloud storage (AWS S3, encrypted at rest) for safety review and transcription-fidelity
auditing; Phase 1's application stated no audio is stored, so Phase 2 must either (a) disclose
audio recording explicitly in the application and consent, or (b) disable recording for Phase 2
participants. Option (a) recommended: recordings materially support safety auditing and the
consent form can disclose them plainly. If audio is stored, it is kept as (i) a session
recording (participant + agent, for safety review and transcription-fidelity auditing) and
(ii) a participant-voice-only track; derived acoustic features (e.g., pitch variability,
speaking rate, pause structure, loudness/energy, and spectral characteristics) may be
computed from the participant track for research analyses of vocal indicators of mood. Only derived, non-identifying acoustic features appear
in the de-identified research dataset; raw audio never leaves access-controlled storage and
is automatically deleted 12 months after recording (retention long enough to cover the
study period plus derived-feature extraction and safety audit, then hard-deleted with an
audit log entry).

All transcript content passes through the automated dual-pass HIPAA Safe Harbor redaction
pipeline before any research use; trained RAs verify random samples of the redacted output
through a review tool that shows only redacted text, with all review actions logged, and
de-identified research exports use only redacted content. Original unredacted content is
deleted after a 24-hour retention window at a nightly wipe (typically within 48 hours of the
session); messages that fail automated redaction are retained until redaction succeeds and
are then wiped. Crisis-flagged sessions follow the same schedule: their unredacted originals
are deleted on the same 24-hour cycle as all content, and the retained crisis material
consists of redacted transcripts and derived event records, kept in a secure database
restricted to authorized study staff for safety review and oversight.

Deliberate non-collection (data-minimization boundary): the app does not log keystrokes and
does not capture message drafts a participant types but chooses not to send; it does not
fingerprint devices; it collects no location information beyond the transient country-level
IP eligibility check; it collects nothing while the app is closed; and it collects nothing
after withdrawal. All behavioral and derived measures above are computed from content and
interface events participants deliberately submit while using the app, and every
transcript-derived research measure downstream of the redaction pipeline is computed from
redacted text only.

### System as built (verified against the application code on main, 2026-11-18)

Each item below was checked against the code; file references are for the research team and
the paragraph text is proposed form text. "Data" says what the feature creates and where the
existing Data Collection and Confidentiality text already covers it, or what has to be added.

1. **Voice: OpenAI GPT-Live with a delegated reasoning model** (`docs/gpt-live.md`,
   `src/server/utils/liveSessionConfig.ts`). The voice model (`gpt-live-1`) listens and speaks
   and holds only tone, turn-taking and one safety instruction. The clinical instructions, the
   participant's memory note and every tool run on a separate reasoning model to which the
   voice model delegates (`system_config.live_backend_model`, code default `gpt-5.6-terra`).
   The voice model transcribes both sides itself; there is no separate transcription model.
   Our server receives the transcript in fragments over a server-side connection
   ("sideband"), reassembles turns, stores them and runs crisis detection on them. OpenAI
   session storage is switched off (`store: false`). *Data:* transcripts, session audio
   (Q5), per-session record of which voice and reasoning models were used, voice-minute usage.
   Covered by Data Collection and Confidentiality once the model paragraph below replaces the
   stale "Realtime API / gpt-transcribe" text.
2. **A second voice backend, xAI Grok Voice, is present in the code** (`docs/grok-voice.md`).
   A single configuration value (`system_config.ai_model`) selects GPT-Live or Grok for every
   new session; with Grok, audio passes through our server to xAI. **It is not used in this
   study.** GPT-Live is the study's voice condition (owner decision 2026-11-01, Flightdeck
   ai-therapist-268). The consent form names only OpenAI, so routing a participant to Grok would
   require an amendment first. Launch check: confirm `ai_model` is a `gpt-live-*` value in the
   production configuration before the first participant, and log any change.
   [QUESTION Q-SYS1 for the PI: state in the form that Grok will not be used, or ask for both.]
3. **Typed chat** (`src/server/services/chatTherapy.service.ts`). Replies come from an OpenAI
   text model through the Responses API, with OpenAI's moderation screen on each request. Chat
   has a text-safe subset of the tools in item 6 (no narrated breathing, grounding, body-scan,
   values or fear-ladder exercises, no language switch). The opening line, including the AI
   disclosure, is written by the server, not the model. *Data:* as for voice, without audio.
   Covered.
4. **Crisis detection** (`docs/crisis.md`). Unchanged from the Risks description: keyword screen,
   then an LLM context assessment, a periodic sweep every 8 participant messages, OpenAI's
   moderation score as a supplementary signal, and a trajectory bonus; keyword-only fallback if
   OpenAI is unavailable (the on-call SOP section 6 describes the spend-limit case). Two
   additions the form should state:
   - On a high flag, the agent may not end the session itself (an end request from the model
     is refused and logged), and our own session time limit is lifted to the voice vendor's
     60-minute ceiling so a participant in crisis is not cut off by our timer.
   - **Vendor content filter and the crisis recovery prompt.** OpenAI's GPT-Live service runs its
     own content filter, which can end a voice session outright, and it does so most often at a
     disclosure of suicidal intent (incident 2026-09-11; red-team runs 2026-10-22 and
     2026-11-01). In some cases the session ends before the transcript of the disclosure reaches
     our server, so our detector never scores it. The app then shows a screen with crisis
     numbers, pages the on-call researcher, and starts a new voice session on a short crisis
     prompt with no conversation history (`buildLiveRecoveryInstructions`): stay present,
     encourage calling or texting 988, ask who could be with them, 911 for immediate danger,
     never discuss methods. After two failed reconnections it falls back to typed chat. The
     recovery prompt tells the model "You were just talking with this person and the connection
     dropped for a moment." That is a simplification of why the call ended. Phase 1 answered No
     to deception. [DECISION Q-SYS2, PI: either (a) disclose the behaviour in consent (the
     revised consent2.html does: "If a voice conversation is cut off") and keep the wording, or
     (b) change the prompt to say the call was ended by the service's safety filter. Recommend
     (a) plus the consent text, because naming a "filter" to a person mid-disclosure may read as
     being refused.] *Data:* an `intervention_actions` record for each vendor termination and
     reconnection, crisis-continuation flags on the new session. Covered by "crisis-event
     records"; add the vendor-termination rate to the safety-system performance metrics.
5. **Session limits.** Seeded defaults are 30 minutes per session, 3 sessions per day and a
   30-minute cooldown (`migrations/007`); the production values are an admin setting and were
   not checked. The consent form says participants may use the app "however much you wish".
   [Q-SYS3: confirm production limits and either state them in consent and the tutorial or
   remove them for study participants.]
6. **Tools the agent can use** (`src/server/services/toolRegistry.service.ts`). Beyond
   conversation, the agent can: build a safety plan with the participant ("stored for the
   clinical team and shown to the participant as a card"); assign a small between-session
   practice and review it next time; run guided breathing, grounding, body-scan, values-sort and
   fear-ladder exercises (voice); open a thought record or journaling prompt; find a vetted
   worksheet and generate a personalised version of it within the template's structure;
   administer PHQ-2/GAD-2 (server-enforced at most once every 7 days each); retrieve passages
   from the vetted psychoeducation library; store a fact the participant explicitly asks it to
   remember; silently bookmark a moment for the research team (`flag_notable_moment`); and
   alert the monitoring team (`escalate_to_human`, which it is told not to announce unless the
   participant asked for a person). *Data:* safety plans, practice assignments and completions,
   worksheet and thought-record responses, scale responses, remembered facts, bookmarks and
   escalations, all keyed to the study ID. **Not yet covered:** the consent and form describe
   "structured safety questions and summaries" but not safety plans, practice, worksheets, or
   silent bookmarks and escalations. The revised consent2.html adds a "Things you make with the
   agent" paragraph; the form's Data Collection text needs the same list (this item can be
   pasted).
7. **Case-profile memory across sessions** (`src/server/utils/promptContext.ts`,
   `src/server/services/sessionInsights.service.ts`). At the end of every session an OpenAI
   model writes a structured session summary and a SOAP-style note. For participants who turn on
   session memory (off by default), it also updates a rolling "clinical case profile" (presenting
   concerns, recurring themes, stressors, support system, coping repertoire ranked by
   helpfulness, values, screener trend), and the next session's instructions carry a memory note
   with recent summaries, remembered facts, the case profile, recent PHQ-2/GAD-2 scores and mood
   points, safety-plan warning signs, the last thought record and open practice. *Data:* session
   summaries and notes (all sessions), case profiles (memory on). **Discrepancies to resolve:**
   (i) the summaries and notes are generated from the original conversation text while it still
   exists, not from the redacted text as Data Collection and the consent form said; (ii) the
   nightly 24-hour wipe acts on the conversation messages table only, so the summaries, notes,
   case profile, remembered facts, safety plans and worksheet responses are not wiped by it, and
   whether they contain identifiers was not established. The revised consent and the settings
   guide now describe what the memory note contains and drop "based on the de-identified
   transcript". [DECISION Q-SYS4, PI with the engineering team: either redact these derived
   records on the same schedule, or state in Confidentiality that they are kept, with their
   retention, and are excluded from de-identified exports until reviewed.]
   The same memory note can include a private note from a participant's therapist and prior
   risk history "when a therapist has enabled sharing this". These are clinical-pilot features.
   [Q-SYS5: confirm no research-study participant can have a therapist note or risk-history
   sharing enabled; if that cannot be guaranteed by configuration, describe it.]
8. **`proactive_offering`, a per-session condition** (`resolveProactiveOffering` in
   `src/server/utils/sessionHelpers.ts`). In the default mode each new session is assigned at
   random, 50/50, to the proactive appendix (the agent may suggest exercises and check-ins) or
   the reactive appendix (it waits to be asked), and the assignment is stored with the session.
   This is the exploratory condition Q13 kept under the single-arm design. *Data:* the per-session
   arm. Not previously disclosed to participants; the revised consent adds "Small differences
   between conversations".
9. **Psychoeducation retrieval cue, a second per-session A/B, currently switched off** (PR #30,
   `features.psychoeducation_cue_ab_enabled`, migration 123). When switched on, each new session
   is assigned 50/50 to receive or not receive one line in the tool guidance telling the model
   to call the psychoeducation retrieval tool and ground explanations in the returned passages.
   The arm is stored in `session_configurations.psychoeducation_cue`. Off for everyone until the
   owner turns it on. *Data:* the per-session arm. [DECISION Q-SYS6, PI: either describe it now
   as a second exploratory per-session condition, or commit to leaving it off for the study
   and submit an amendment before switching it on. The consent text "some details ... are
   assigned at random" covers either.]
10. **"Leading the conversation" block, currently switched off** (PR #32,
    `features.lead_conversation_enabled`). When switched on, every new session (not a random
    subset) gets a prompt block telling the agent to take a guiding role (help choose a focus,
    reflect then advance with one question, offer a specific direction when the participant
    stalls, summarise at the close, and step back to follow the participant whenever there is
    distress or risk), a matching line for the voice model, and the opening question "What would
    you like to focus on today?". *Data:* none new; the assembled prompt stored per session shows
    which sessions had it. [DECISION Q-SYS7, PI: switching it on mid-study changes every session
    from that date; decide before launch, and if it is switched on later, log the date as a
    protocol change.] Neither item 9 nor item 10 appears in the verbatim-prompts attachment until
    PR #24 is merged and regenerated.

**Models in use (dated table).** Model versions may be updated during the study. Each change is
recorded with its date in the system configuration audit log, and the model that served each
session is stored with the session (`docs/model-pinning.md`), so analyses can account for it.
Changes that alter the prompts or the safety pipeline are reported to the IRB as amendments;
model version updates are logged and summarised at continuing review.
[DECISION Q-SYS8, PI: confirm this reporting line with the IRB.]

| Function | Provider | Model id as of 2026-11-18 (code default) | Planned change |
|---|---|---|---|
| Voice conversation: listening and speaking | OpenAI GPT-Live | `gpt-live-1` | none |
| Voice conversation: reasoning (holds the clinical prompt and tools) | OpenAI | `gpt-5.6-terra` | `gpt-6.1-terra`, approved by the owner 2026-11-18 pending evaluation |
| Typed chat conversation | OpenAI | `gpt-5.2` | `gpt-6.1-terra`, approved by the owner 2026-11-18 pending evaluation |
| Crisis risk assessment (selectable in configuration), minor-disclosure confirmation, session naming | OpenAI | `gpt-4o-mini` | none |
| Moderation screen (supplementary crisis signal) | OpenAI | `omni-moderation-latest` | none |
| Transcript redaction (two passes) | OpenAI | `gpt-5` | none |
| Session summaries, notes and case profile | OpenAI | `gpt-4o-mini` | none |
| Text embeddings (memory retrieval; redacted text only) | OpenAI | `text-embedding-3-small` | none |
| Voice, alternative backend (not used in the study; item 2) | xAI | `grok-voice-3.0` | n/a |

Production can override the voice and reasoning models in its stored configuration; check the
production values on the day of submission and update this table if they differ.

**Instruments list (cards):**
1. PHQ-2 (Kroenke, Spitzer & Williams) — public-domain validated 2-item depression screener,
   administered in-app; screeners not diagnoses. Validation: extensively validated; cite
   Kroenke et al. 2003 (Med Care 41:1284-92).
2. GAD-2 (Kroenke, Spitzer, Williams & Löwe) — public-domain validated 2-item anxiety
   screener, same administration. Cite Kroenke et al. 2007 (Ann Intern Med 146:317-25).
3. Weekly check-in survey (Qualtrics): usage reflection, perceived usefulness, and the
   Working Alliance Inventory — Short Revised (WAI-SR; Hatcher & Gillaspy, 2006), client
   version adapted to refer to the AI support agent (12 items; Task/Bond/Goal subscales,
   4 items each; 5-point Seldom–Always scale). Used with written permission from the
   Society for Psychotherapy Research (letter dated 2026-09-09, attached); the required
   note "Reprinted by permission of the Society for Psychotherapy Research © 2026." is
   displayed at the end of the measure. Validation: WAI-SR psychometrics cite Hatcher &
   Gillaspy 2006 (Psychother Res 16:12-25) and Munder et al. 2010 (Clin Psychol Psychother
   17:231-9); item wording adapted only to name the AI support agent in place of the
   therapist. The weekly survey also carries the two monitoring measures in items 9 and 10.
4. Baseline survey (adapted from Phase 1 "Part 1" survey): demographics, therapy history,
   AI attitudes, and a contact email (required; used only to schedule onboarding and send
   survey reminder emails through BYU's Qualtrics platform — stored with the survey
   response and in an access-controlled Qualtrics contact list, never in de-identified
   research datasets). Weekly/exit/follow-up reminder emails include crisis resources and
   note that survey completion is voluntary.
5. Exit survey (adapted from Phase 1 "Part 3" post-survey) + optional exit-interview guide.
6. AI Conversation Log (same card as Phase 1, description updated per above).
7. Study Withdrawal/Pause survey (investigator-developed, Qualtrics, ~1 min): reason for
   stepping away, optional free text (reviewed under the same 1-business-day adverse-experience
   procedure as the weekly check-in), withdraw-vs-pause choice, and data-handling preference.
   Linked from the participant's account page; submitting updates study status, creates a
   work-queue item for the study team, and notifies researcher-role staff.
8. Week-12 follow-up survey (adapted from the exit survey's core measures, Qualtrics,
   ~10 min): persistence of effects four weeks after access ends. **[DECIDED Q12 — included;
   survey built and committed to in consent.]**
9. **Emotional dependence (weekly, new 2026-11-18):** Craving subscale of the Affective
   Dependence Scale (ADS-9; Sirvent-Ruiz, Moral-Jiménez, Herrero, Miranda-Roves & Rodríguez
   Díaz, 2022, Psychol Res Behav Manag 15:3875-88, doi:10.2147/PRBM.S385807), 5 items, adapted
   to refer to the AI support agent with a past-week frame. This is the emotional-dependence
   measure used in the MIT Media Lab / OpenAI longitudinal chatbot study (Fang et al., 2025,
   arXiv:2503.17473), whose adapted wording is unpublished, so the wording here is the team's
   and is printed in `weekly.html` with every change from the original stated. Licence: CC
   BY-NC 3.0 (non-commercial use permitted with attribution; a later commercial product would
   need permission from the publisher). Validation of the original: ordinal alpha .83-.89
   across clinical, comparison and general-population samples (N = 762 Spanish adults), scalar
   invariance across groups. The chatbot adaptation is not separately validated; internal
   consistency will be reported from study data. Scoring: mean of 5 items (1-5); no published
   cut-off. Burden: under 1 minute.
10. **Problematic use (weekly, new 2026-11-18):** Bergen Social Media Addiction Scale (BSMAS;
    Andreassen et al., 2016, Psychol Addict Behav 30:252-62, doi:10.1037/adb0000160), 6 items,
    "social media" replaced by the AI support agent (the approach Hu, Mao & Kim, 2023, Comput
    Human Behav 145:107760, took for conversational AI) and "the last year" by "the past week".
    Licence: no licence or permission requirement was found; the items are printed in the
    article and the scale is widely used in research without a fee. Alpha .88 in the original
    online sample (N = 23,533). Scoring: sum of 6 items (6-30); the cut-off of 19 (Bányai et
    al., 2017, PLOS ONE 12:e0169839) is used only as a review trigger because the time frame is
    changed. Burden: about 1 minute. This replaces the Problematic ChatGPT Use Scale used by Fang
    et al., which is closed-access and could not be verified.
11. **Psychosis-risk screen (eligibility screener, new 2026-11-18):** Prodromal
    Questionnaire, Brief Version (PQ-B; Loewy & Cannon, 2010, University of California;
    validation Loewy, Pearson, Vinogradov, Bearden & Cannon, 2011, Schizophr Res 129:42-6,
    doi:10.1016/j.schres.2011.03.029), 21 yes/no items about the past month, each "yes" followed
    by a 5-point distress rating; items verbatim from the authors' 2010 form. Permission: the
    authors distribute the form with a request to cite it as above; no licence fee or licence
    form exists. Scoring (authors' rules): Total = number of "yes" answers (0-21); Distress = sum
    of the distress ratings, 1-5 per "yes" and 0 per "no" (0-105). Burden: about 3-5 minutes
    (team estimate; no published completion time). The screener also adds one eligibility
    history item (diagnosed psychotic or bipolar disorder), a standard eligibility question,
    not a scale.

## Research Procedures

**What are you asking subjects to do? (proposed):**

All participants complete online eligibility screening and electronic informed consent
(signed; no signature waiver requested in Phase 2 — see Consent).

1. **Baseline (Week 0):** online baseline survey (Qualtrics, ~15 min); brief onboarding session
   ([in the SONA lab / remote video call — DECISION Q11]) where an RA walks the participant
   through account setup, app orientation, safety features and crisis resources, and answers
   questions. Participants complete a short guided first interaction with the AI agent.
2. **Weeks 1–8 (naturalistic use):** participants use the AI support agent from their own
   devices as often as they wish. We suggest (but do not require) at least two **[DECIDED Q4]**
   brief interactions per week. In-app, the agent periodically administers PHQ-2/GAD-2
   (no more than once per week each) and offers optional mood check-ins.
3. **Weekly:** a ~7-minute Qualtrics check-in survey (engagement reflection, alliance items,
   emotional-dependence and problematic-use items, any adverse experiences). Dependence and
   problematic-use answers are reviewed within one business day under the decision rule in
   Risks.
4. **Week 8 (exit):** exit survey (~20 min); a subsample invited to a ~30-minute Zoom exit
   interview.
5. **Week 12 (follow-up):** a single follow-up survey (~10 min) to measure persistence of
   effects after access ends. **[DECIDED Q12 — included; the survey is built and the consent
   form commits to it.]**
6. **Pausing or withdrawing (any time):** the participant's account page links a ~1-minute
   withdrawal/pause survey (reason, optional comments, withdraw-vs-pause, data-handling
   preference). Submitting it updates the participant's study status — new AI sessions are
   closed (with crisis resources shown) while account access, data export, and the research
   team's contact information remain available — creates a work-queue item for the study
   team, and notifies researcher-role staff. Comments
   describing distress follow the same 1-business-day adverse-experience review as the weekly
   check-in. Participants may also withdraw by contacting the research team directly, as in
   Phase 1.

**Important framing (carried and strengthened from Phase 1):** This study is not therapy and
does not provide diagnosis or treatment. The AI agent provides supportive, evidence-informed
self-help conversation only. Participants are told this at consent, at onboarding, and by the
agent itself at session starts.

**Time commitment:** baseline = ~15-min survey + 30–45-min onboarding session; weekly surveys
8 × 7 min; suggested app usage ~2 × 15 min/week (participant-controlled); exit ~20-50 min;
Week-12 follow-up ~10 min. Total structured time ≈ 2.5–3.5 hours over 12 weeks, plus
voluntary app use.

**Where:** Onboarding [SONA lab or Zoom — Q11]; everything else remote (participants' own
devices/homes). This is a deliberate change from Phase 1 (supervised lab sessions) and is the
core scientific point of Phase 2; the safety section addresses the added distance.

**Multiple phases or arms? [DECISION Q13 — the big design question]:**
Option A (recommended as default): single-arm observational/within-subjects longitudinal
cohort. Cleanest for IRB, honest about exploratory nature, fastest approval.
Option B: two-arm randomized comparison on the proactive-offering feature (the system's
existing `proactive_offering` flag: agent proactively suggests check-ins/worksheets vs.
responds only). Flightdeck item ai-therapist-108 already anticipates PHQ-2/GAD-2 deltas by
proactive_offering arm with a pre-registered analysis script. Randomization of a benign UX
feature keeps risk identical across arms. More reviewable, more publishable, slightly slower.
Draft below assumes **Option A** with Option B text held in reserve.

**Analysis plan (proposed):** Mixed-effects models of PHQ-2/GAD-2 trajectories over time,
with the system's derived affect trajectories and acoustic mood features examined as
convergent-validity measures against the validated screeners; engagement survival analysis
(time-to-disengagement) with engagement/interaction telemetry — session rhythm,
response-timing patterns, and interface-engagement events — as predictors; habit-formation
analyses of inter-session intervals, usage streaks, and time-of-day regularity across the
8 weeks (the novelty-decay question); within-person alliance growth curves (WAI-SR), with
behavioral engagement measures examined as correlates of self-reported alliance;
safety-system performance metrics (flag rates, risk-score calibration against human review
outcomes, time-to-researcher-acknowledgment, false-positive review outcomes); qualitative
thematic analysis of exit interviews and de-identified transcripts. A pre-registered analysis script will be finalized before
unblinding/analysis (see ai-therapist-108).

## Drug/Device/Therapeutic Intervention

No FDA drugs/biologics. Not a therapeutic study (explicitly framed as supportive self-help
conversation, not treatment; no clinical claims). No devices. Same answers as Phase 1, but
**[DECISION Q14]** the "is this a therapeutic study" answer deserves a sentence of
justification in Phase 2 because longitudinal use looks more treatment-like: we neither
promise nor measure clinical treatment efficacy as a primary endpoint; well-being indicators
are observational research measures, and the agent is a general wellness/support tool
(consistent with FDA general-wellness guidance).

## Subject Enrollment

**Number of subjects (proposed):** Enroll up to 120 BYU students to yield ≈70–90 completers
(anticipating 25–40% attrition typical of multi-week digital mental health studies — cite
Torous et al. 2020 on DMH attrition). **[DECISION Q15]** — N and power: if Option B (two arms),
120 enrolled ≈ 45/arm completing, adequate for medium within-person effects; run the power
simulation in the pre-registration notebook before submitting.

**Justification (proposed):** Longitudinal digital mental health studies show steep engagement
decay; oversampling relative to Phase 1's single-session N accounts for attrition while keeping
the study within departmental funding and CAPS's support capacity. [Tighten with the power
notebook output.]

**Recruitment methods:** SONA, classroom announcements (Canvas + verbal), email — same
channels/permissions as Phase 1 (SONA lab manager approval; instructor approval for
class credit). New recruitment materials required (attach: Email_Student
group_Phase2, Recruitment Ad_Phase2, classroom script). Drafts in
`docs/irb-phase2-recruitment-drafts.md` (to be written this session).

**Inclusion:** BYU students, 18+, located in the US for the study duration, own a device with
a modern browser and internet access, willing to use the app over 8 weeks.
**Exclusion (proposed — stricter than Phase 1, because use is unsupervised):**
- Under 18 (survey hard-stops; in-app, disclosure triggers automated session termination
  with youth crisis resources — see Screening).
- Outside the US.
- **[DECISION Q16 — active-crisis exclusion]:** individuals who at screening report active
  suicidal ideation with plan/intent (screened via PHQ-2 item + direct item, e.g. C-SSRS
  screener items), currently in crisis, or hospitalized for mental health in the past
  [6 months]. These individuals receive a warm referral card (CAPS, 988) instead of
  enrollment. Phase 1 excluded "individuals currently in crisis" narratively; Phase 2 should
  operationalize it. Need Erekson's input on the exact screener and threshold.
- **Psychosis risk (new 2026-11-18; launch-gated commitment):** (a) a PQ-B Distress score of
  46 or more on the eligibility screener, or (b) "Yes" to "Has a doctor or other health
  professional ever told you that you have a psychotic disorder ... or bipolar disorder?"
  Screened-out respondents get the same referral end screen as the other clinical exclusions,
  which does not say which answer caused it.
  **[DECISION Q-PSY1, PI: threshold.]** Recommendation and reasoning: the PQ-B's published
  cut-offs (Total 3 or more, or Distress 6 or more; Loewy et al., 2011) were set to decide who
  gets a clinical interview in help-seeking clinics, not who is excluded, and they flag many
  students (13% of healthy controls in the validation paper; Wu et al., 2021, BMC Psychiatry
  21:253, report that commonly used cut-offs would flag most of 23,063 Chinese university
  students). This study has no interview stage, so the screen is the decision. Distress 46 or
  more is the cut-off derived against clinical interview in that large university sample
  (sensitivity 90.3%, specificity 81.2%); in that sample roughly one respondent in five would
  screen out, and the rate in this population is unknown. Alternatives: Total 6 or more
  (Loewy's maximum-specificity rule: 100% specificity, 31% sensitivity in help-seekers);
  Distress 22 or Total 7 (Preti et al., 2018, Italian students, no interview reference). The
  recommendation accepts some false exclusions for sensitivity, which fits unsupervised use of
  an AI agent given the delusion-reinforcement literature (Olsen 2026; Morrin 2026). Planned
  check: if more than 25% of the first 40 screened respondents screen out on the PQ-B, the PI
  reviews the threshold, and any change goes to the IRB as an amendment.
  **[DECISION Q-PSY2 (was Q-LIT2), PI: diagnosed psychotic or bipolar disorder: exclusion
  (drafted) or monitored subgroup.]**
- Unable to give informed consent.

**Screening:** eligibility screener in Qualtrics before consent. In-app enforcement: if a
participant discloses being under 18 during a conversation, the system's two-stage detection
automatically terminates the session in-conversation and presents youth crisis resources;
US-only access is enforced by IP geolocation blocking at the application layer (not by the
agent). Attach screening survey. The screener now includes the PQ-B and one history item
(Exclusion, above); responses are scored automatically in Qualtrics and used only for
eligibility, and responses of ineligible respondents are deleted when recruitment closes.

**Special permission:** CAPS collaboration letter (updated for Phase 2's on-call/referral
role — DECISION Q17: confirm CAPS agrees to be the named clinical resource for REMOTE
participants, not just lab escorts, and what their after-hours stance is); SONA manager
approval.

## Vulnerable Populations

Same as Phase 1: targeting "students enrolled in your class(es)" (some recruitment flows
through classes Gaskin supervises). FERPA: yes, compliant, same handling (NetIDs via SONA
only, separated from research data).

## Compensation

**[DECIDED Q18 — structure per consent v2:]**
- Payment structure: $10 baseline survey + onboarding; $3 per weekly check-in survey (× 8);
  $15 exit survey; $10 optional exit interview; $5 Week-12 follow-up survey. Maximum ≈ $64
  per participant, or SONA-credit equivalent. Amounts clear "no undue influence" for
  ~2.5–3.5 hours of structured time.
- Prorated: **Yes** (change from Phase 1 answer) — participants keep everything earned;
  withdrawal costs only unearned increments. SONA credits are likewise prorated by completed
  study weeks; an 8-week study with all-or-nothing compensation would be coercive toward
  completion.
- Distribution via the SONA lab (credits) or [Amazon codes / Tango — DECISION] for cash,
  NetIDs handled exactly as Phase 1 (separated from research data).

## Benefits of Participation

No direct benefits (same stance as Phase 1 — do NOT promise therapeutic benefit; Phase 1
reviewers specifically struck such language from consent). Societal benefits text can be
adapted from Phase 1, plus: longitudinal evidence on sustained human-AI supportive
interaction, safety-architecture performance under naturalistic use, and design guidance for
responsible AI mental-health tools.

## Risks

**Minimal risk claim:** propose keeping "minimal risk" but — unlike Phase 1's bare "no more
than everyday life" — Phase 2 must argue it, because participants converse with an AI about
emotional topics repeatedly and unsupervised. Proposed risk table entries:

- **Psychological:** Reflecting on mood and personal difficulties may cause discomfort;
  although unlikely, AI interactions could worsen distress or coincide with a crisis episode
  (phrasing per the Phase 1 reviewer's requested consent language). Probability low, magnitude
  moderate, duration transient, reversible. Mitigations: validated brief screeners rather than
  intrusive probing; the agent's crisis protocol (below); weekly check-in surveys include a
  distress item routed to the study team; participants can pause or withdraw at any time; all
  participants receive crisis resources (988, CAPS crisis line, Crisis Text Line) at
  onboarding, in-app persistently, and on every crisis flag.
- **Privacy:** Sensitive disclosures under automated redaction + human verification +
  encryption; breach could be damaging (answered Yes as in Phase 1) — mitigations: Safe
  Harbor redaction at ingest, originals deleted after the short retention window,
  access-controlled AWS environment, audit logging of data deletions, administrative changes,
  and (as of this build) participant-data access (transcript views, recording playback,
  exports), least-privilege access, [BAA/ZDR per Q8].
- **Dependency/overreliance (new, name it before the IRB does):** prolonged access could
  foster overreliance on a non-clinical tool. Mitigations: agent discourages dependency and
  encourages professional help (system prompt), usage is participant-controlled with no
  gamified engagement mechanics, weekly surveys monitor for it, and the consent form states
  the tool is not a substitute for care. Monitoring (new 2026-11-18): the weekly survey carries
  the ADS-9 Craving subscale and the BSMAS, both adapted to the AI support agent (Instruments 9
  and 10). Decision rule **[DECISION Q-DEP1, PI: thresholds]**: a participant is flagged when
  the ADS Craving mean is 4.0 or more (average answer "agree"; the 90th percentile of the
  original general-population norms), or rises by 1.0 or more from their first weekly survey,
  or the BSMAS total is 19 or more. A flag is reviewed within one business day together with the
  weekly-survey adverse-experience review; the researcher sends one in-app check-in message
  (the tool's limits, CAPS and 988, the option to pause); a second consecutive flag goes to the
  PI, who decides whether to offer a pause or a call. A flag is not a crisis page; free text
  describing risk follows the on-call triage ladder (`docs/on-call-sop.md` sections 4 and 5).
  Flag counts are reported at continuing review and analysed as a safety outcome. None of these
  cut-offs is validated for a chatbot; they are review triggers, not diagnoses. Related: the
  home screen shows a "progress card" of how often the participant has talked in recent weeks;
  whether that counts as an engagement mechanic is a PI judgement (Q-SYS9).

**Crisis / safety monitoring plan (proposed — this is the section to get right):**

The deployed system monitors conversations for risk in real time using a two-stage design:
a tiered keyword screen on every participant message triggers an LLM context assessment
(OpenAI gpt-4o-mini) that assigns a graduated severity (none/low/medium/high), supplemented
by a periodic LLM sweep every 8 participant messages even without keyword hits and a
rising-risk trajectory bonus; if the LLM assessment is unavailable, detection falls back to
the keyword screen alone. These risk assessments send recent unredacted conversation
excerpts to OpenAI for scoring, in addition to the conversation-generation processing
itself (disclosed in Confidentiality and consent). Medium-severity flags produce a real-time
dashboard alert and a work-queue item for the study team. On a high-severity flag the system:
(1) alerts all monitoring researchers via the admin dashboard in real time, (2) pages the
on-call researcher by SMS with a link to the admin dashboard/session (paging enabled via
launch configuration; see launch checklist), (3) the session is marked for elevated
monitoring in the researcher dashboard, and (4) the agent itself follows its crisis
protocol — acknowledging, checking immediate safety, and surfacing 988 / CAPS crisis line /
Crisis Text Line resources to the participant. From moderate risk levels upward (risk score
>= 25) the system also injects hidden de-escalation guidance into the AI model's context to
steer its responses toward grounding and safety; this steering shapes the agent's replies
but is not announced to the participant, and every injection is logged. A trained on-call researcher is
designated at all times during the study period with a documented escalation path to Dr.
Erekson/CAPS for clinical consultation [and to emergency services when legally required —
mandatory-reporting language mirrors the Phase 1-stipulated consent text]. All crisis events,
system actions, and researcher responses are logged (crisis_events, intervention tables) and
reviewed weekly; any serious adverse event is reported to the IRB per adverse-event policy
using the system's adverse-event reporting module.

**Known failure mode on the voice path (new 2026-11-18; see "System as built" item 4).** The
voice vendor's own content filter can end a voice session at a disclosure of suicidal intent,
sometimes before the disclosure reaches our detector. This happened in a stage session on
2026-09-11 and in every recorded run of the voice crisis-ladder red-team scenario on GPT-Live
(3 of 3 on 2026-10-22; again on 2026-11-01). Mitigation: the app shows crisis numbers at once,
pages the on-call researcher, and reconnects the participant to a voice agent on a narrow crisis
prompt, with typed chat as the fallback; each termination is logged, and the rate is a reported
safety metric. The red-team attachment states that the voice crisis ladder is not passing on
GPT-Live.

**[DECISION Q19 — monitoring staffing]:** Phase 1 promised "at least two RAs actively
monitoring at all times when participants use the system" — feasible for scheduled lab
sessions, IMPOSSIBLE for 24/7 naturalistic use. Phase 2 must promise something sustainable:
proposed = 24/7 automated detection + SMS paging to a rotating on-call researcher with a
[15-minute] acknowledgment target during waking hours [define overnight policy — Q19], NOT
continuous human watching. Do not copy Phase 1's staffing language.
**BLOCKER (ai-therapist-147):** prod crisis paging env vars are UNSET on the prod box — the
paging described here must actually be wired before any participant onboards.

**Need for services:** Yes — resources listed (988, CAPS main + crisis line, Crisis Text
Line, emergency services); made available at onboarding, persistently in-app, in every
consent document, and automatically upon any crisis flag.

## Consent Documentation/Waivers

- Signed electronic consent for ALL participants (typed-name + checkbox, as Phase 1 Part 3).
  No signature waiver requested (drop Phase 1's Part-1 waiver — everyone in Phase 2 does the
  full study).
- One consent form: "Longitudinal AI Support Study Consent". Draft to be written this session
  as `docs/irb-phase2-consent-draft.md`, incorporating: the three Phase-1 reviewer
  stipulations verbatim-or-stronger (concrete AI-interaction risk phrasing; no therapy-benefit
  promises; explicit mandatory-reporting disclosure listing abuse/neglect/exploitation/harm
  with identity-disclosure consequence); audio recording disclosure [per Q5]; a prominent
  plain-language "what the app records and analyzes" section covering the full behavioral
  telemetry set (usage/interaction patterns, automated per-message risk scoring and
  emotional-tone analysis, technical telemetry, and the explicit non-collection boundary —
  no keystrokes/unsent drafts, no fingerprinting, no precise location); data flows
  (OpenAI processing, redaction, retention windows, indefinite de-identified retention);
  withdrawal mechanics (stop using app, request data removal via manual pathway); crisis
  monitoring disclosure (what the system watches for and who gets paged); compensation
  proration table. The RESEARCH-audience in-app consent copy (currently v2026-07-30.1) should
  be cross-checked for consistency with the study consent. **Launch note:** the in-app
  research consent must be revised for Phase 2 before launch — it does not yet cover quiet
  hours, the OpenAI processing disclosure, or mandatory reporting.

## Consent Process

Adapt Phase 1's 7-point structure: consent presented online via Qualtrics before baseline;
reviewed live by an RA during onboarding (Q11 modality) with time for questions; documented by
checkbox + typed name; single form; delivered by assigned RA; ≥1 week between announcement
and enrollment window closing. Coercion-minimization: neutral survey tone, no RA present
during app use (inherent — remote), scripted exit interviews, prorated compensation so
withdrawal costs only unearned increments.

## Confidentiality of Data

Reuse Phase 1's structure with these updates (accuracy fixes — see questions doc):
- Storage reality: encrypted AWS (RDS Postgres + S3) operated by the research team, not
  "BYU Box" for the operational database; de-identified analysis exports stored on BYU Box
  with least-privilege sharing (this matches actual practice: operational DB vs. analysis
  exports). Describe both layers explicitly.
- Identifiable → de-identified flow, NetID separation via SONA: same as Phase 1.
- Retention: originals deleted after a 24-hour retention window at a nightly wipe (typically
  within 48 hours of the session); messages that fail automated redaction are retained until
  redaction succeeds and are then wiped. De-identified data retained indefinitely for
  future use (same as Phase 1, disclosed in consent).
- Commercial AI models (revised 2026-11-18; the earlier Realtime API / gpt-transcribe text is
  obsolete since the GPT-Live cutover): all model processing is by OpenAI, with the models
  listed in the dated table under "System as built". Describe them generically in the form
  ("OpenAI voice and text models; current versions are listed in the attached table; versions
  may be updated, and each change is logged with its date and recorded per session") and attach
  the table. The voice model transcribes speech itself; there is no separate transcription
  model. OpenAI's moderation model scores participant messages as a supplementary crisis
  signal; embeddings are computed from redacted text only. Third-party processing is without a
  BAA or zero-data-retention agreement (Q8); OpenAI-side storage is switched off on each call
  (`store: false`), data sharing with OpenAI is disabled, and OpenAI's standard abuse-monitoring
  retention (up to 30 days) applies. The consent form previously said "zero data retention
  enabled"; consent2.html is corrected. Include the verbatim prompts attachment (regenerated by
  `npm run irb:prompts` once PR #24 merges).
- Derived records (new 2026-11-18; "System as built" items 6 and 7): session summaries and
  notes, case profiles, remembered facts, safety plans, practice assignments and worksheet
  responses are stored in the study database keyed to the study ID. They are not covered by the
  24-hour wipe of original message text, and summaries are generated from the original text
  (Q-SYS4).
- Automated safety processing: crisis risk assessment sends recent unredacted conversation
  excerpts to OpenAI (gpt-4o-mini) for scoring, and at elevated risk the system injects
  hidden de-escalation guidance into the AI model's context to steer its responses; the
  steering is logged but not announced to the participant.
- Behavioral and technical telemetry: the engagement, interaction-timing, interface-event,
  performance, and client-error telemetry described under Data Collection is stored in the
  study database keyed to the anonymous participant/session ID and contains no conversation
  content; the only device-descriptive element retained is the browser user-agent string
  attached to client error reports. Derived safety/affect measures (risk scores, affect
  trajectories, session notes) live in the same access-controlled database as the redacted
  transcripts, with the same staff-access audit logging.
- Staff access to identifiable content: researchers with live safety-monitoring duties can
  view conversations in real time before redaction (only while a session is active), and
  authorized staff (therapist/researcher roles) can access session audio recordings for
  safety and transcription-fidelity review.
- Participant free-text feedback comments are exported verbatim only via a separate opt-in
  artifact handled as identifiable data, outside the redaction pipeline; they are excluded
  from the default de-identified export.
- Platform tenancy: the platform also hosts a separate non-research clinical pilot
  (therapist/caseworker portals) in organizationally isolated tenants; caseworker-role
  accounts are structurally excluded from research-org data, and clinical-pilot staff have no
  access to study-participant data (see `docs/data-access-boundary.md`).
- Data access boundary: attach the one-page access-boundary write-up
  (`docs/data-access-boundary.md`; it will be asked).

## Privacy of Participants

Same selections as Phase 1 (private-space conversation guidance — for Phase 2 add: onboarding
advises participants to use the app somewhere private, and voice mode is optional where
privacy is limited); sensitive-topics Yes with same precautions text; breach-consequences Yes;
mandatory reporting Yes with the strengthened Phase-1-stipulated language and the concrete
escalation path (on-call researcher → Erekson/CAPS → authorities where required).

## Other Attachments

- Crisis notification example, admin dashboard example (refresh screenshots from current UI).
- Redaction test evidence (rerun the Safe Harbor test suite and export fresh logs).
- Red-team evaluation summary: `docs/irb-phase2-instruments/redteam.html`, generated by
  `npm run irb:redteam -- --from <summary.json>` from the latest nightly "Red-team (full)"
  results file. The 2026-11-18 version is generated from run 44351920021 at commit 906af42
  (17 of 19 scenarios passed); it states that the voice crisis ladder is not passing on
  GPT-Live and that prompt or model edits made in the admin screens do not yet trigger a run.
  Regenerate from the newest nightly run on the day of upload.
- CAPS updated support letter (Q17), SONA approval, updated external-investigator form for
  de Vreede if continuing.

---

## Reuse map (what to copy from Phase 1 nearly verbatim)

PI qualifications; determination checklist answers; exempt "none apply"; General Information
block; funding source; FERPA/vulnerable-populations; NetID/SONA separation text; redaction
pipeline description + prompts (refresh model names); benefits-to-society list; consent
7-question structure. (Screening enforcement text must be UPDATED, not copied: under-18
disclosure now triggers automated in-conversation session termination via the two-stage
detector, and US-only access is enforced by IP geolocation blocking — see Screening.)

## Do-NOT-reuse list (Phase 1 text that is now false or Phase-2-inappropriate)

1. "No audio is stored" (system stores WAV in S3) — Q5.
2. "Whisper + GPT-4o" model description (now Realtime API) and "ChatGPT-4o architecture".
3. "Two RAs actively monitoring at all times" — Q19.
4. "Signed BAA in place" — verify before restating (Q8 / ai-therapist-132).
5. Phase 1's risk-scoring description — current detection is two-stage: a tiered keyword
   screen triggers an LLM context assessment (gpt-4o-mini) with graduated severities
   (none/low/medium/high), plus a periodic LLM sweep every 8 participant messages, a
   risk-trajectory bonus, and keyword-only fallback if the LLM call fails; medium-severity
   flags alert the dashboard and work queue, and elevated risk injects hidden de-escalation
   steering into the model. Describe current behavior per `docs/crisis.md`.
6. Lab-escort-to-CAPS escalation (remote participants can't be escorted) — Q17/Q19.
7. "Data will be stored on secure, access-controlled BYU box" as the primary description of
   operational storage.
8. Part 1 signature waiver.
