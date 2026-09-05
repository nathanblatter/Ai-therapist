# Phase 2 IRB Application Draft — Human + AI Therapy: Better For Everyone (Phase 2, Longitudinal)

**Status: WORKING DRAFT (agent-drafted 2026-09-01/02, not reviewed by Nathan or Dr. Gaskin).**
Mirrors the OneAegis xForm section order of the approved Phase 1 application (2025-519-BYU,
scraped in full to `docs/irb-phase1-application.md`). Items marked **[DECISION]** have a
corresponding entry in `docs/irb-phase2-questions-for-nathan.md`. Text in plain paragraphs is
proposed answer text ready to paste into the xForm.

---

## Study Information

**Project Title:** Human + AI Therapy: Better For Everyone (Phase 2: Longitudinal Use)

**Principal Investigator:** James Gaskin (Information Systems) — same PI qualifications text as
Phase 1 (reuse verbatim; it is PI-specific, not study-specific).

**Co-Investigators:** David Erekson (CAPS clinical director) — **[DECISION Q1]** confirm he
continues as Co-I; his role grows in Phase 2 (clinical oversight of longitudinal remote use).

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
and voice conversation (realtime speech-to-speech via OpenAI's Realtime API under [BAA/ZDR
status — DECISION Q8, MUST be resolved truthfully before submission]).

What it collects, per session: conversation transcripts with timestamps; participant-initiated
mood check-ins; responses to brief validated screeners (PHQ-2, GAD-2) administered in-app;
session feedback ratings; engagement metadata (session frequency, duration, time of day);
crisis-detection events and system actions. **[DECISION Q5]** Voice sessions [are / are not]
recorded as audio. Current system capability stores session audio (WAV) in access-controlled
cloud storage (AWS S3, encrypted at rest) for safety review and transcription-fidelity
auditing; Phase 1's application stated no audio is stored, so Phase 2 must either (a) disclose
audio recording explicitly in the application and consent, or (b) disable recording for Phase 2
participants. Option (a) recommended: recordings materially support safety auditing and the
consent form can disclose them plainly. If audio is stored, it is kept as (i) a session
recording (participant + agent, for safety review and transcription-fidelity auditing) and
(ii) a participant-voice-only track; derived acoustic features (e.g., pitch variability,
speaking rate, pause structure) may be computed from the participant track for research
analyses of vocal indicators of mood. Only derived, non-identifying acoustic features appear
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

**Instruments list (cards):**
1. PHQ-2 (Kroenke, Spitzer & Williams) — public-domain validated 2-item depression screener,
   administered in-app; screeners not diagnoses. Validation: extensively validated; cite
   Kroenke et al. 2003 (Med Care 41:1284-92).
2. GAD-2 (Kroenke, Spitzer, Williams & Löwe) — public-domain validated 2-item anxiety
   screener, same administration. Cite Kroenke et al. 2007 (Ann Intern Med 146:317-25).
3. Weekly check-in survey (investigator-developed, Qualtrics): usage reflection, perceived
   usefulness, and a 6-item investigator-developed working-alliance measure adapted from the
   working-alliance construct (Bordin's Task/Bond/Goal model; 2 items per dimension, 5-point
   agreement scale). **[DECIDED Q10, 2026-09-04: investigator-developed items — the WAI-SR is
   copyrighted (SPR); a permission request has been sent to SPR and, if granted before launch,
   the items may be replaced with licensed WAI-SR wording via an amendment or pre-approval
   update to this draft.]**
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
3. **Weekly:** a ~5-minute Qualtrics check-in survey (engagement reflection, alliance items,
   any adverse experiences).
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
8 × 5 min; suggested app usage ~2 × 15 min/week (participant-controlled); exit ~20-50 min;
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

**Analysis plan (proposed):** Mixed-effects models of PHQ-2/GAD-2 trajectories over time;
engagement survival analysis (time-to-disengagement); within-person alliance growth curves;
descriptive safety-system performance metrics (flag rates, time-to-researcher-acknowledgment,
false-positive review outcomes); qualitative thematic analysis of exit interviews and
de-identified transcripts. A pre-registered analysis script will be finalized before
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
- Unable to give informed consent.

**Screening:** eligibility screener in Qualtrics before consent. In-app enforcement: if a
participant discloses being under 18 during a conversation, the system's two-stage detection
automatically terminates the session in-conversation and presents youth crisis resources;
US-only access is enforced by IP geolocation blocking at the application layer (not by the
agent). Attach screening survey.

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
  the tool is not a substitute for care.

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
  with identity-disclosure consequence); audio recording disclosure [per Q5]; data flows
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
- Commercial AI models: state the CURRENT stack truthfully — voice conversation via OpenAI's
  Realtime API (gpt-realtime-2.1-mini; transcription via gpt-4o-mini-transcribe; model
  pinning per `docs/model-pinning.md`, with the per-session resolved model stamped in the
  database); typed chat via gpt-5.2 (Chat Completions, not Realtime); redaction via gpt-5
  (dual pass); auxiliary safety/analysis calls via gpt-4o-mini (crisis risk assessment,
  minor-disclosure confirmation, session naming, session insights, worksheet ranking, eval
  judging); and message embeddings via text-embedding-3-small (computed from redacted text
  only; vectors retained, never exported). Third-party processing under
  [BAA / zero-data-retention — Q8]; include the current system prompt, redaction prompt, and
  session-name prompt as Phase 1 did (pull from src at submission time so they're current).
- Automated safety processing: crisis risk assessment sends recent unredacted conversation
  excerpts to OpenAI (gpt-4o-mini) for scoring, and at elevated risk the system injects
  hidden de-escalation guidance into the AI model's context to steer its responses; the
  steering is logged but not announced to the participant.
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
- Red-team evaluation summary (NEW, strong addition Phase 1 didn't have: the nightly
  red-team suite + crisis-ladder results demonstrate systematic safety testing).
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
