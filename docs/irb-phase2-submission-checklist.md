# Phase 2 IRB submission checklist (alignment pass, 2026-11-18)

Every change made in the repo in this pass, where it has to be copied in OneAegis or Qualtrics,
the decisions that belong to the PI, and what is still missing from the repo. Nothing in this
pass was entered in OneAegis or Qualtrics; an agent cannot reach either. Work top to bottom:
decisions first, because several of them change the text to paste.

Paths are relative to the repo root. "App" means `docs/irb-phase2-longitudinal-application.md`.
Q-numbers are explained in `docs/irb-phase2-questions-for-nathan.md` (top section).

## 1. Decisions the PI must make before pasting

| # | Decision | Drafted default | Affects |
|---|---|---|---|
| Q-PSY1 | PQ-B screen-out threshold | Distress score 46 or more | Screener routing, App Exclusion |
| Q-PSY2 | Diagnosed psychotic or bipolar disorder: exclusion or monitored subgroup | Exclusion | Screener item 8, App Exclusion |
| Q-PSY3 | Keep PQ-B scores of enrolled participants as a covariate | No (eligibility only) | Consent, App Screening |
| Q-DEP1 | Weekly dependence and problematic-use flag thresholds and action | ADS Craving mean 4.0+, or +1.0 from first week, or BSMAS 19+; one check-in message, PI on a second flag | App Risks, `docs/on-call-sop.md` section 5 |
| Q-SYS1 | Grok Voice in the study | Not used; consent names only OpenAI | App "System as built" item 2 |
| Q-SYS2 | Crisis recovery prompt says "the connection dropped" (Phase 1 answered No to deception) | Keep wording, disclose in consent | Consent, App item 4 |
| Q-SYS3 | Session length and daily limits for participants | Check prod values, then state or lift | Consent, tutorial |
| Q-SYS4 | Derived records (summaries, notes, case profile, safety plans, worksheets) outlive the 24-hour wipe; summaries come from original text | Disclose retention; exclude from exports until reviewed (or ask engineering to redact) | App Confidentiality, Consent |
| Q-SYS5 | Therapist note and risk-history blocks must be impossible for research participants | Confirm by configuration | App item 7 |
| Q-SYS6 | Psychoeducation-cue A/B (off) | Describe now or amend before switching on | App item 9 |
| Q-SYS7 | Lead-conversation block (off; all sessions when on) | Decide before launch | App item 10 |
| Q-SYS8 | How model version updates are reported | Logged with date, summarised at continuing review; prompt or pipeline changes as amendments | App model table |
| Q-SYS9 | Home-screen progress card vs "no gamified engagement mechanics" | PI judgement | App Risks |
| Q8 | Consent sentence on OpenAI data retention (no BAA, no ZDR) | "No zero-data-retention agreement; OpenAI may keep request data up to 30 days for abuse monitoring" | Consent, baseline consent text |

Still open from earlier passes and unchanged here: Q5 audio, Q6 budget, Q11 onboarding, Q17 CAPS
letter / Sagers, Q19 overnight policy, ai-therapist-147 paging env vars.

## 2. Qualtrics

Weekly survey SV_emV8ohMB6FujVLU (Draft):

- [ ] Add matrix question W11 (5 rows, Strongly disagree to Strongly agree) and its note W11NOTE,
  text from `docs/irb-phase2-instruments/qualtrics_weekly.txt`, on a new page after W6.
- [ ] Add matrix question W12 (6 rows, Very rarely to Very often) and note W12NOTE, same file,
  same page.
- [ ] Do not add display logic: W11 and W12 are shown to everyone, including non-users.
- [ ] Add scoring: `ADS_CRAVING` = mean of W11 rows (1-5); `BSMAS` = sum of W12 rows (6-30).
- [ ] Change the intro WINTRO from "about 5 minutes" to "about 7 minutes".
- [ ] Record the new QIDs. `src/server/services/qualtricsScoring.service.ts` does not read them
  yet, and the daily survey-drift guard will file a `survey_drift` work item for the edit; both
  are expected. Scoring them in the app is a later engineering task; until then the RA reads
  the scores in Qualtrics during the weekly review.

Baseline survey SV_aW32vA2r2yHrpI2 (Draft), Screening block:

- [ ] Add SCR8 (diagnosis history, Yes / No / Not sure) after SCR7, force response.
- [ ] Add a page with PQBINTRO, then PQB1 to PQB21 (Yes / No) and PQB1D to PQB21D (5-point
  distress), then PQBNOTE, from `qualtrics_baseline.txt`.
- [ ] Display logic: show each PQBnD only if PQBn = Yes.
- [ ] Scoring categories: `PQB_TOTAL` (each PQBn Yes = 1) and `PQB_DISTRESS` (PQBnD Strongly
  disagree 1 ... Strongly agree 5; unanswered or No = 0).
- [ ] Branch logic: SCR8 = Yes (per Q-PSY2), or `PQB_DISTRESS` >= threshold (per Q-PSY1), goes to
  the existing referral end message MS_4bay6k70pI9IZRu. The message text is unchanged on
  purpose: it does not say which answer screened the person out.
- [ ] Decide how "Not sure" on SCR8 routes (drafted: continue).
- [ ] Replace CONSENTTEXT with the revised text in `qualtrics_baseline.txt` (weekly survey is 7
  minutes and asks about reliance; OpenAI named, no ZDR agreement; session memory; per-session
  differences; voice cut-off reconnection).
- [ ] Re-run the cross-document consistency check (weekly minutes now 7 everywhere).

## 3. OneAegis (form instance f49253f1..., not submitted)

Attachments:

- [ ] Consent: regenerate the docx from `docs/irb-phase2-instruments/consent2.html`
  (`build_consent_doc.py`), date it, replace AI Longitudinal Participant Consent_Main Group
  09.10.2026v3. Changes: weekly survey 7 minutes with reliance questions and the check-in it can
  trigger; reliance monitoring in Risks; session-summary sentence corrected; new paragraphs for
  session memory, things made with the agent (safety plans, worksheets, practice, silent
  bookmarks and escalations), per-session differences, and voice cut-off reconnection;
  Confidentiality names OpenAI, says models may be updated, and drops the zero-data-retention
  claim.
- [ ] Screening survey: replace with `screener.html` (PQ-B and item 8 added). Remove the bracketed
  decision note in item 8 and the threshold note once Q-PSY1 and Q-PSY2 are decided.
- [ ] Weekly survey: regenerate Phase2_Weekly_Checkin_Survey docx from `weekly.html` (W11, W12,
  7 minutes) and replace the 09.09.2026 file.
- [ ] Red-team summary: replace Redteam_Safety_Evaluation_Summary_09.02.2026.docx in OneAegis (moved
  to `superseded/` in the repo; it reports the voice crisis ladder 12/12 PASS from a pre-GPT-Live
  run)
  with `redteam.html` (print to PDF or Word). Regenerate it first from the newest nightly run:
  `gh run download <id> --name redteam-full-results --dir <fresh temp dir>` then
  `npm run irb:redteam -- --from <dir>/summary.json --run-url <run url> --model ...` (see the
  script header). Add a voice row to `VOICE_EVIDENCE` in `src/server/irb/redteamAttachment.ts`
  if a newer GPT-Live voice run exists.
- [ ] App tutorial and session-settings guide: regenerate App_Tutorial docx/pdf
  (`build_tutorial_pages.py`) from `app-tutorial.html`; the session-memory text in both files now
  lists what the memory note contains and that memory starts off.
- [ ] Recruitment materials: weekly survey now "7-minute" in `recruit.html` (email, classroom
  script, SONA description).
- [ ] Verbatim prompts: after PR #24 merges, run `npm run irb:prompts`, convert, and replace
  AI_Model_System_Prompts_Verbatim_09.04.2026.docx. Until then the attachment omits the
  lead-conversation block, the psychoeducation cue and the GPT-Live voice-layer and recovery
  prompts.
- [ ] Attach the dated model table (App, end of "System as built") as its own short document or
  paste it into Confidentiality.
- [ ] Instrument cards: add PQ-B (screener), ADS-9 Craving adapted and BSMAS adapted (weekly),
  using App Instruments items 9 to 11 for citation, licence, validation and burden.

Form pages:

- [ ] Data Collection, "Other methods": replace the Realtime API sentence with App's revised first
  paragraph, and paste "System as built" items 1 to 10 (trim the file references) after the
  non-collection paragraph.
- [ ] Data Collection, instruments: add App Instruments 9 to 11.
- [ ] Research Procedures: weekly survey ~7 minutes with dependence items; time commitment 8 x 7
  min; Multiple arms: say that `proactive_offering` is a per-session random 50/50 assignment
  (item 8) and how Q-SYS6 was decided.
- [ ] Subject Enrollment, Exclusion: replace the bracketed PENDING DECISION psychotic-spectrum
  text added on 2026-09-21 with App's "Psychosis risk" bullet (as decided).
- [ ] Subject Enrollment, Screening: replace "the item will be added before submission" with App's
  Screening sentence.
- [ ] Risks, dependency: replace "launch-gated problematic-use and dependence items" with App's
  monitoring paragraph and decision rule.
- [ ] Risks, crisis plan: add App's "Known failure mode on the voice path" paragraph. This is the
  Flightdeck-tracked "IRB wording for the content-filter failure mode" (ai-therapist-268).
- [ ] Risks, red-team mitigation: the delusion scenario now runs nightly and failed its referral
  check on 2026-11-18; describe it as tested, not as passing.
- [ ] Wherever the form promises the suite is re-run "whenever the system prompt, crisis-detection
  logic, or model version changes": replace with "the full suite runs nightly on the main branch
  and a smoke suite gates every deploy; an automatic run on prompt and model edits made in the
  administrator screens is planned" (the attachment states the same).
- [ ] Confidentiality of Data: replace "Commercial AI models" with App's revised bullet; add the
  "Derived records" bullet as decided under Q-SYS4.
- [ ] Other Attachments: describe the red-team summary as generated (App, Other Attachments).

## 4. Before launch (not paperwork, but the paperwork depends on it)

- [ ] Prod `system_config.ai_model` is a `gpt-live-*` value (Q-SYS1); log any later change.
- [ ] Prod `live_backend_model` and chat model match the dated model table on the day of
  submission; if the `gpt-6.1-terra` move happens, update the table with its date.
- [ ] Features `psychoeducation_cue_ab_enabled` and `lead_conversation_enabled` are in the state
  the protocol says (Q-SYS6, Q-SYS7).
- [ ] Session limits match what consent says (Q-SYS3).
- [ ] Weekly dependence review is on the RA rota (`docs/on-call-sop.md` section 5).

## 5. Still missing from the repo

- The OneAegis form text itself. The Risks, Subject Enrollment and Benefits pages were edited
  directly in OneAegis on 2026-09-21 and only backups in a session scratchpad exist, so this
  pass could not diff against them. Export each page's current text into the repo before
  pasting.
- The Phase 1 consent PDFs and the Phase 1 verbatim-prompts attachment as approved.
- A real CAPS support letter (only `PLACEHOLDER_CAPS Support Letter_09.01.2026.docx`), or the
  Sagers personnel entry that replaces it (Q17).
- Written confirmation of PQ-B research use from the authors (optional; not sent).
- A GPT-Live voice crisis-ladder run newer than 2026-11-01. The attachment reports the last
  recorded runs; none passed.
- An automatic red-team trigger on prompt and model edits made in the admin screens (being built
  separately; describe as planned until it merges).
