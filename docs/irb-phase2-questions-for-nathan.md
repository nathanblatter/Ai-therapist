# Phase 2 IRB — Open questions for Nathan (and Dr. Gaskin / Dr. Erekson)

## ANSWERS FROM NATHAN (2026-09-02 interview) — ALL APPLIED same day

Everything below has been executed in OneAegis + Qualtrics + the consent doc:
quiet-hours language in the form (Research Procedures, Risks) and consent v2
(re-attached, old version deleted); ZDR education-license statement in the form
(Confidentiality of Data) and consent; de Vreede row restored with her Phase 1
external-investigator form re-attached (external investigators = Yes, saved);
baseline survey CONSENTTEXT synced (quiet hours + ZDR); SONA `id` embedded-data
element added to the baseline survey flow (replicating Phase 1's mechanism —
Phase 1 has NO redirect, it captures the SONA participant id from the URL for
credit granting). Original decisions:

- **Q13 design: single-arm observational.** Proactive/reactive A/B stays as an exploratory
  under-the-hood condition. LOCKED.
- **Q19 overnight: HARD QUIET HOURS 10pm-6am America/Denver.** App blocks new sessions
  overnight and shows crisis resources instead. Consent v2 regenerated with this language;
  app feature filed as ai-therapist-152 (blocks launch). Form text updates pending re-login.
- **Q8 BAA/ZDR: zero data retention achieved via the OpenAI education license.** Hedge
  language being replaced with a plain statement. TODO Nathan: confirm which account/org
  holds the education license (ties into ai-therapist-139) and keep the documentation handy
  for the IRB.
- **Q1/Q17 clinical backstop: Triparna de Vreede is the named clinical support** (already
  registered in OneAegis; re-add row, external investigators=Yes, no new form needed per
  Nathan). CAVEAT to sanity-check: Phase 1 reviewers wanted a *licensed clinician* backstop;
  de Vreede is a PhD researcher with psychology training, not (to our knowledge) a licensed
  clinician — the application will describe her role accurately (clinical-protocol review),
  and the CAPS letter question (ask Gaskin: still needed? who signs?) matters more if no
  licensed clinician is named.
- **Q18/Q6 budget: NOT confirmed — hedge stays.**
- **All remaining ★ defaults: LOCKED as drafted.**
- **Recruitment: SONA + other channels** → SONA credit redirect to be wired into the
  baseline survey (pending Qualtrics session).
- **Submission routing: goes to Jeff Jenkins automatically on submission — no separate
  SRC step.**

## DEV UPDATE 2026-09-02 (later session — commit a509c31, stage-deployed)

Non-blocked engineering is DONE; only people-gated items remain:
- **Quiet hours BUILT (ai-therapist-152 closed).** Server-side middleware blocks new
  participant sessions 10pm-6am America/Denver (staff/demo/sandbox exempt; in-progress
  sessions never cut off) + overnight crisis-resources screen in the participant UI.
  Env-gated: set `QUIET_HOURS_ENABLED=true` at Phase 2 launch (off on stage today so
  Phase 1/demo behavior is unchanged).
- **Redaction batch bug FIXED (ai-therapist-150 closed).** The model had merged two
  messages in the un-anchored batch array; now index-anchored, strictly validated,
  retried, and per-item fallback — a bad batch can no longer leave a session unredacted.
- **Qualtrics sync hardened:** optional `QUALTRICS_SYNC_INTERVAL_MINUTES` background
  scheduler + `GET /admin/api/qualtrics/status` (linkage stats, unlinked responses).
- Still blocked on people: BYU enabling the Qualtrics API (email sent to
  qualtrics@byu.edu 2026-09-02), CAPS letter, budget, ZDR docs, prod paging env
  (ai-therapist-147), disclaimer prompt tuning (Gaskin), final review + submission.

## STATE OF THE APPLICATION (as of 2026-09-02, end of autonomous session)

Everything an agent can do without you is DONE:
- **OneAegis form**: all 19 pages drafted and saved (2025-519 Phase 2, form instance
  f49253f1...). NOT submitted — stops at the signature page per your rule.
- **Attachments in the form**: template-compliant consent (09.02), surveys, instruments,
  PHQ-2/GAD-2, recruitment materials, screener, redacted conversation-log example,
  placeholder CAPS letter, verbatim model prompts, red-team safety summary (full-suite run
  09.02: 10/12 pass, all crisis/medication/injection/minor-age assertions green).
- **Qualtrics**: 4 surveys built (baseline SV_aW32vA2r2yHrpI2, weekly SV_emV8ohMB6FujVLU,
  exit SV_cZPBcn5vOkfXOCi, week-12 SV_6QIBQHIbJeGgR70) with all skip/display logic,
  force-response on gates and study-ID fields, cleaned blocks. All Draft, unpublished.
- **Consistency pass**: compensation/durations/contacts/crisis numbers verified identical
  across form, consent, surveys.

**What only you can do** (details in sections below): answer the ★ defaults (esp. Q8 BAA,
Q13 design, Q19 monitoring, Q17 CAPS), real CAPS letter, de Vreede decision + form,
crisis/dashboard screenshots, redaction evidence, budget confirmation (Q6), SONA redirect
decision, then review everything and submit with Gaskin. Two code items filed in
flightdeck: ai-therapist-150 (redaction batch bug, HIGH) and ai-therapist-151
(disclaimer-timing prompt tuning).

---

Running list maintained during the 2026-09-01/02 drafting session. Q-numbers are referenced
from `docs/irb-phase2-longitudinal-application.md`. Defaults marked ★ are what the draft
currently assumes; correct anything wrong and the draft gets updated.

## Blocking / must-answer-before-submission

- **Q8 — OpenAI BAA / zero-data-retention (ai-therapist-132).** Phase 1's application asserts
  "a signed Business Associate Agreement (BAA) is in place with the model provider (OpenAI)"
  and "zero-retention endpoint." Flightdeck says this is UNVERIFIED. Phase 2 cannot restate it
  without proof. Who actually holds the OpenAI agreement, and does it cover the Realtime API?
  (Related: ai-therapist-139, moving off Gaskin's personal account — ideally done before
  submission so the application names the right account owner.)
- **Q5 — Audio recordings.** Phase 1 told the IRB "no audio is stored," but the current system
  stores voice-session WAVs in S3. For Phase 2: ★ disclose audio recording in application +
  consent (recommended — it supports safety review) or disable recording for study
  participants. Either way, Phase 1's running study is currently out of sync with its
  approved protocol if voice sessions are being recorded there — consider whether the
  in-progress Phase 1 amendment should fix that too.
- **Q19 — Monitoring staffing promise.** Phase 1 promised two RAs watching live at all times
  (workable for lab sessions only). Phase 2 draft promises: 24/7 automated detection + SMS
  paging to rotating on-call researcher, ★ 15-min acknowledgment target during waking hours.
  What's the honest overnight policy? (Options: best-effort overnight; agent-only overnight
  with morning review; quiet-hours usage discouragement in-app.) Also BLOCKER
  ai-therapist-147: prod crisis paging env is unset — must be wired before launch.
- **Q17 — CAPS role for remote participants.** Phase 1's escalation = RA escorts participant
  to CAPS from the lab. Remote participants can't be escorted. Need Erekson to agree in
  writing (updated support letter) to CAPS being the named clinical resource for remote BYU
  participants + what CAPS wants the after-hours path to be (988 first?).
- **Q13 — Study design.** ★ Option A: single-arm observational longitudinal cohort.
  Option B: 2-arm randomized proactive-offering comparison (pre-registration angle,
  ai-therapist-108). Gaskin's call — affects sample size, analysis plan, and how "experiment"
  reads to reviewers.

## Design decisions (defaults chosen, cheap to change now)

- **Q4 — Duration & cadence:** ★ 8 weeks access, suggested (not required) ≥2 short sessions/
  week. Alternatives: 4, 6, 12 weeks.
- **Q12 — Post-access follow-up:** ★ yes, single Week-12 survey.
- **Q15 — Sample size:** ★ enroll 120, expect 70–90 completers. Run the power notebook
  (ai-therapist-108) before submitting to justify.
- **Q7 — Exit interviews:** ★ yes, n≈15–20 subsample, Zoom, ~30 min.
- **Q11 — Onboarding modality:** ★ in-person SONA-lab onboarding (consent review + guided
  first session), with remote-Zoom fallback. Alternative: fully remote onboarding.
- **Q16 — Active-crisis exclusion screener:** need Erekson: exact items (C-SSRS screen?
  custom item?) and threshold; ★ exclude active SI-with-plan/intent + past-6-mo psych
  hospitalization, with warm-referral card for excluded respondents.
- **Q18 — Compensation:** ★ prorated: baseline $10, $3/weekly survey, $20 exit, ≈$54 total
  (or SONA-credit equivalents; drawing as budget fallback). Needs budget confirmation (Q6)
  and coercion check.
- **Q10 — Alliance measure: DECIDED by Nathan 2026-09-04 — investigator-developed items.**
  The weekly W4 matrix is expanded from 3 to 6 items covering Bordin's Task/Bond/Goal
  dimensions (2 each, 5-pt agree scale); scoring (task/bond/goal subscale means + 6-item
  total) is wired into the app's surveys_scored export. In parallel, Nathan sent a WAI-SR
  permission request to SPR (sprexecutive@gmail.com, 2026-09-04); if SPR grants a license
  before launch, the Draft survey items can be swapped for licensed WAI-SR wording (surveys
  are still Draft; drift guard + QID re-verification apply).
- **Q14 — "Not a therapeutic study" framing:** draft argues general-wellness/support framing.
  Sanity-check with Gaskin — FDA general-wellness guidance language included.

## Personnel / collaboration

- **Q1 — ANSWERED by Nathan mid-session (2026-09-02): "dont include davey erekson."** Erekson
  is NOT on the Phase 2 form. Follow-up consequence to decide: a longitudinal mental-health
  protocol with no licensed clinician among key personnel will draw reviewer attention — the
  Phase 1 reviewers already cared a lot about clinical backstop. Options: name a different
  clinical consultant, lean entirely on the CAPS support letter (Q17, now more critical), or
  accept the risk of a stipulation. Also: who signs the CAPS permission letter for Phase 2 if
  not Erekson (he was the CAPS clinical director contact in Phase 1)?
- **Q2 —** RA roster for Phase 2 (Phase 1 has a personnel-change event in progress, #22038 —
  what's changing there?).
- **Q3 —** Murtis Taylor / Case Western (Orlean's dissertation, the caseworker surveys we
  drafted 2026-09-01): ★ kept entirely OFF this BYU protocol — assume it will be a separate
  CWRU (+MTHSS) IRB with its own reliance arrangements. Confirm that's the plan, and whether
  this BYU Phase 2 needs any mention of it at all (draft says no).
- **Q6 —** Departmental funding covers ~$6-7k compensation budget? And ai-therapist-139
  (university OpenAI org) before launch?

## Accuracy fixes noticed while scraping Phase 1 (not questions, FYI)

- Phase 1 describes multi-layer risk scoring (keywords + sentiment + trajectory); the shipped
  detector is keyword-only for flagging (trajectory logged passively). Phase 2 draft describes
  current behavior; if Phase 1 keeps running as approved, its description is stale but was
  accurate when written — flag to Gaskin whether the in-progress amendment should refresh it.
- Phase 1 says operational storage = BYU Box; reality = AWS RDS/S3 with Box for de-identified
  exports. Phase 2 draft describes both layers truthfully.
- Q9 — confirm the prod retention window for unredacted originals (application says 24h
  default; verify prod env value before submission).

## New items from the OneAegis draft session (2026-09-02, form is FULLY drafted, NOT submitted)

- **De Vreede is currently OFF the Phase 2 form.** The form requires a filled
  external-investigator form to save her row; "external investigators" is answered **No** for
  now. If she continues: flip to Yes, re-enter her row (text is in
  docs/irb-phase2-longitudinal-application.md), and attach her form (Phase 1's is in the
  Phase 1 event attachments).
- **CAPS letter placeholder.** Special-permission is answered Yes with
  PLACEHOLDER_CAPS Support Letter docx attached (clearly labeled). Replace with the real
  updated CAPS letter before submission.
- **Compensation entered as:** $10 baseline+onboarding, $3/weekly survey, $15 exit,
  $10 optional interview, $5 Week-12 follow-up (~$64 max), prorated, cash via gift codes at
  Weeks 4 and 12 or SONA equivalents. Marked "[pending final budget confirmation]" in the form.
- **BAA/ZDR honestly flagged inside the form** ("the research team is confirming the exact
  agreement status... will provide documentation to the IRB before launch") — resolve before
  submission (Q8).
- **Attachments still needed from Nathan/team:** refreshed crisis-notification + admin
  dashboard screenshots, fresh redaction test evidence, real CAPS letter, de Vreede form
  (if continuing).
- **Red-team summary DONE and ATTACHED (09.02).** Ran the FULL suite locally (scratch DB,
  live paging disabled, commit e6502d9, seed 42, $0.13 API cost): **10/12 scenarios passed;
  every crisis-ladder (both pipelines), medication, prompt-injection, and minor-age safety
  assertion passed.** Two failures, honestly disclosed in the attached doc
  (Redteam_Safety_Evaluation_Summary_09.02.2026.docx, Other Attachments, Study Material):
  (1) disclaimer-timing style rule — agent re-disclaimed on turn 2 in two scenarios and
  once gave the opening disclaimer on turn 2 instead of turn 1 (prompt tuning item, not a
  safety failure); (2) one checker false-positive — the no-diagnosis regex flagged a reply
  that was actually refusing to diagnose. Follow-ups filed in flightdeck: disclaimer-timing
  prompt tuning (needs Gaskin sign-off — prompt changes are research-sensitive) and a REAL
  bug observed in run logs: "Batch redaction returned 5 items, expected 6" → session
  redaction failed and name-generation returned "null" (IRB-relevant: redaction reliability
  is promised in the application).
- **DONE 09.02: verbatim model prompts attached.** AI_Model_System_Prompts_Verbatim_09.02.2026.docx
  (Other Attachments page, type Study Material) — extracted verbatim from
  src/server/utils/sessionHelpers.ts: base DEFAULT_SYSTEM_PROMPT, proactive/reactive
  exercise-offering appendices (per-session A/B research condition), and the 4 modality
  appendices (supportive/CBT/ACT/MI) with a note about phase-pacing guidance. CAVEAT for
  Nathan: prod's DB config (system_prompts.realtime/chat) can override the code default —
  verify the deployed prod prompt matches this document before submission, and keep the
  admin-edited prompt in sync with the IRB-approved version going forward.
- **Final consent form (UPDATED 09.02):** rewritten on the official BYU "Standard Consent
  Form with Key Information" template (required because ours exceeds 3 pages) and re-attached
  in the form as AI Longitudinal Participant Consent_Main Group_09.02.2026.docx, replacing
  the 09.01 version. Includes: Key Information summary, template section order, the
  DO-NOT-ALTER HRPP rights paragraph verbatim, audio-recording consent adapted from the
  Adult Media Release template (scoped honestly to our transcription/safety-review use, no
  publication rights), Gaskin + Nathan contact emails from the Phase 1 Qualtrics consent,
  and printed-name/signature/date lines. Source: docs/irb-phase2-instruments/consent2.html.
  Template downloads cached in scratchpad; the External Investigator Form template for
  de Vreede is at https://irb.byu.edu/protocol-templates-forms (HRPP Forms section).
- The form's remaining click path is: page 19 → Next → Submit (sends to Gaskin for PI
  signature). Nobody clicks that but you.

## Qualtrics surveys (built 2026-09-02, all Draft, none published)

- Baseline (screening + consent + baseline): SV_aW32vA2r2yHrpI2
- Weekly check-in: SV_emV8ohMB6FujVLU
- Exit (Week 8): SV_cZPBcn5vOkfXOCi
- Week-12 follow-up: SV_6QIBQHIbJeGgR70 (built 2026-09-02: mood/stress, PHQ-2+GAD-2 matrix,
  missed-availability, post-study support-seeking, retrospective helpfulness, lasting effects
  + conditional describe, open feedback)
- Withdrawal/pause: **SV_esmJYmrhsHOayWy** (BUILT 2026-09-04 via the survey-definitions API,
  Draft): DINTRO=QID1, DID=QID2 (force-response, wid-autofill JS attached), D1=QID3,
  D2=QID4 (free text -> QID4_TEXT), D3=QID5, D4=QID6; sid embedded-data element first in
  flow. WITHDRAWAL_KEYS in qualtricsSync.service.ts verified against these live QIDs.
  QUALTRICS_WITHDRAWAL_SURVEY_ID set in the stage env; PROD env still needs it at promotion.
  Remaining manual (Qualtrics UI, before launch): anonymize-responses setting + a Workflows
  WebService POST to /api/qualtrics/webhook (same pattern as the other four surveys).
- Qualtrics ops build-out (2026-09-04, "do 1-4"): (a) BASELINE CONTACT EMAIL: new required
  BEMAIL question (QID35, validated email) added to the live baseline before NEXTSTEPS —
  fixes the survey promising RA contact while collecting no contact info. NATHAN REVIEW: the
  email lives in the response + an app-managed XM Directory mailing list (list
  CG_3D2zUrMzUJWwfbV, directory POOL_1mV0vCm5qzt9GR5) — consent "Confidentiality" text and
  the OneAegis data-collection answer should mention study-communication email use.
  (b) REMINDERS: app-driven invite + 48h follow-up emails per due survey via Qualtrics
  distributions (library message MS_V4tNz2KFqgkkLvx in UR_eLnQWgQoVDDlg4m); ships dark until
  QUALTRICS_DIRECTORY_ID/MAILING_LIST_ID/LIBRARY_ID/REMINDER_MESSAGE_ID are set in env
  (go-live step, after surveys are published). (c) ENROLLMENT QUOTA: cap 40 consented
  (QO_5vdfxnprkPfaoqW) — respondent 41 gets end-of-survey at the consent gate; review the
  default end-of-survey message wording in the Qualtrics UI. (d) D4 DELETION REQUESTS:
  researcher-confirmed endpoint POST /admin/api/qualtrics/participants/:userId/delete-survey-data
  deletes Qualtrics responses remotely + blanks local answers with audit rows
  (reason participant_request). (e) PARADATA: completion_seconds + speeder flag now in
  surveys_scored.csv.
- Weekly W4 alliance matrix: APPLIED 2026-09-04 via the API to the live Draft survey
  (SV_emV8ohMB6FujVLU) — QID7 now has rows _1.._6 in the txt order; full weekly QID map
  re-verified same day (QID4/6/8/9/10/11 unchanged; alliance = QID7, matching
  ALLIANCE_MATRIX_QID in qualtricsScoring.service.ts). The drift guard will file one
  expected survey_drift work item per edited/new survey on its next daily run.
- DONE this session: all skip logic (baseline SCR1-7 hard-stops + consent-decline
  skip-to-end; exit X0 withdraw gate); display logic (weekly W7=Yes reveals W8; week-12
  F7=any-Yes reveals F8); empty "Default Question Block" shells deleted in all 4 surveys;
  force response set on baseline SCR1-7 + CONSENT + CONSENTNAME, weekly WID, exit X0 + XID,
  week-12 FID.
- Still to do: SONA end-of-survey credit redirect (Nathan-gated — depends on whether
  recruitment actually goes through SONA; Phase 1's redirect lives in its end-of-survey
  element, copy from SV_e3dRBIcxM0ne3ga if wanted), publish (only after IRB approval).
- Cross-document consistency pass DONE (2026-09-02): compensation figures identical across
  OneAegis form, consent docx, and baseline CONSENTTEXT ($10 / $3x8 / $15 / $10 / $5,
  ~$64 max, prorated, keep-what-you-earned); time estimates match (baseline 15 min,
  onboarding 30-45, weekly 5, exit 20); contacts match (Gaskin, nzb22@byu.edu, HRPP
  801-422-1461); crisis numbers match everywhere (CAPS 801-422-3035, 988, Crisis Text Line
  741741, BYU Police 801-422-2222 in the screener referral). Three trivial diffs, all
  harmless but noted: (1) week-12 survey intro says "about 5 minutes" vs consent's
  conservative "about 10 minutes"; (2) survey consent says "(or 1 SONA credit)" without the
  consent docx's "pending professor approval" qualifier; (3) SCR2 asks about US presence for
  "the next 10 weeks" while total study span is 12 weeks (defensible — only the 8-week use
  period + onboarding needs US presence; Week-12 survey is online).

## Process questions

- Who is the Phase 2 form creator in OneAegis (Madison did Phase 1)? Nathan is drafting via
  his RA (write) access; PI signature/submission stays with Gaskin.
- Target submission date? Scientific Review Committee (Jeff Jenkins) again first?
- Does the annual check-in (due 2027-02-12) or the open amendment interact with timing?
