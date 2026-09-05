# IRB Reviewer Feedback — Phase 1 Inventory and Phase 2 Pitfall Checklist

**Purpose:** context document for the team drafting the Phase 2 (longitudinal) IRB application.
It inventories every reviewer comment/stipulation received on the Phase 1 protocol (BYU IRB
2025-519, "Human + AI Therapy: Better For Everyone (Phase 1)"), extracts the pattern behind
them, and turns that pattern into a checklist of likely Phase 2 objections with suggested
pre-emptive mitigations.

**Sources:**
- `docs/irb-phase1-application.md` (full scraped Phase 1 application with inline stipulations)
- `docs/irb-responses.md` (formal responses to two stipulations, dated 2026-01-29)
- `docs/irb-phase2-longitudinal-application.md` and `docs/irb-phase2-questions-for-nathan.md`
  (current Phase 2 draft context)

---

## 1. Complete inventory of Phase 1 reviewer stipulations

Nine distinct stipulations were received across three review rounds (12/15/2025, late January
2026, and 02/13/2026). All were resolved before final submission on 02/13/2026.

### Round 1 — Research Procedures section, 12/15/2025 (three stipulations, all Resolved)

**S1. Therapy-benefit inconsistency / overpromising.**
> "You state in the Procedures section that 'This study is not therapy'. However, the Student
> Consent Form states subjects may receive 'potential benefits from engaging in therapy' and
> under the Compensation section states subjects have the potential to receive 'effective
> mental health therapy'. Please be consistent in stating the potential benefits. If this is
> not clinical therapy, remove all promises of therapeutic benefits or 'effective therapy'
> from the consent documents."

Resolution: therapy-benefit language removed from consent and compensation sections; final
application states "No" direct benefits, "There is no guaranteed direct benefit to
participants," and frames all benefits as societal/indirect.

**S2. Time-commitment inconsistency across documents.**
> "Make the time commitment consistent across all documents. Your recruitment email states the
> study takes about 20 minutes, but your consent form says it takes 30 minutes for the first
> study. Update all documents to show the same time commitment."

Resolution: time commitments harmonized (final: Part 1 survey 10-15 min, therapist interviews
15 min, Part 3 session about 1 hour) across recruitment, consent, and application.

**S3. Study-location inconsistency (in-person vs. "all remote").**
> "You describe the study locations inconsistently. You state earlier in the application that
> some interviews may occur 'In-person'. However, at the bottom of the current section, it
> states that 'All participation is remote.' Select one setting and update the application to
> match. If you intend to conduct in-person interviews, you must remove the 'remote only'
> statement and describe the physical location where the interviews will take place."

Resolution: locations enumerated explicitly — BYU campus (SONA lab for Part 3) plus
off-campus/online (student apartments and homes for the Part 1 survey), with the off-campus
location table completed.

### Round 2 — Consent form stipulations, 01/28/2026 (four stipulations, all Resolved)

**S4. Concrete AI-interaction risk disclosure.**
> "The risks section does not clearly disclose concrete risks of interacting with an AI
> Chatbot. More direct phrasing is needed, for example: 'Although unlikely, it is possible
> that the chatbot interactions may worsen your condition, or may trigger a crisis episode.'"

Resolution: consent risk section revised with the reviewer's concrete phrasing (worsening of
condition, possible crisis episode); revised consent forms dated 02-02-2026 attached.

**S5. "Effective mental health therapy" listed as compensation.**
> "The compensation section states, 'Participants have the potential to receive effective
> mental health therapy.' This is not compensation. It is a possible (and unconfirmed) benefit
> of the research. Please remove this statement."

Resolution: statement removed. (Note this is the reviewers flagging the same overpromising
theme as S1 a second time, in a second round — it recurred because the fix was not applied
everywhere the first time.)

**S6. Vague mandatory-reporting language.**
> "The consent form states, 'If any harmful or concerning information is disclosed, we are
> required to report it'. This is too vague, and does not sufficiently disclose the risks to
> the participant if they disclose something with a mandatory reporting requirement. Revise
> the statement 'If you share during the AI chat information regarding ongoing abuse, neglect,
> sexual exploitation, or risk of harm toward self or others, we are required to report this
> to legal authorities, along with information about your identity. This could result in the
> arrest and prosecution of the perpetrators.'"

Resolution: consent revised with the reviewer's explicit language, naming the reportable
categories (abuse, neglect, sexual exploitation, risk of harm to self or others), the
disclosure of identity to legal authorities, and the possible consequence (arrest and
prosecution of perpetrators).

**S7. Consent changes must propagate back into the application.**
> "Once you make these changes to the consent form, also update the corresponding sections of
> the IRB application."

Resolution: application sections updated to match the revised consent forms. (Again the
consistency theme: the reviewers explicitly check that consent and application text agree.)

### Round 2 (parallel) — System/safety stipulations answered in `docs/irb-responses.md`, responses dated 01/29/2026

**S8. Crisis alerting — passive logging is not enough.**
> "The protocol states that in crisis situations, the App will store data 'like how serious it
> was, when it happened, and what actions the system took'. Because this is a mental health
> support system, logging the data for later inspection is not sufficient. If technologically
> possible, modify the App to send an alert message to an on-call researcher, notifying them
> that an incident has occurred."

Resolution: the app was enhanced and the response documented a real-time alerting system —
multi-layered detection with a 0-100 risk score, WebSocket dashboard alerts, browser push
notifications, push notification to the on-call researcher's mobile device for high-risk
events, a full audit trail (crisis_events, intervention_actions, human_handoffs,
clinical_reviews tables), and a staffing promise: "At least two Research Assistants will be
actively monitoring the Live Monitoring dashboard at all times when participants are using
the system." The application also states "We designed the app to notify on call researcher of
all crisis levels" and attaches an example crisis notification.

**S9. Third-party AI data flows — describe the redaction layer and name the vendor.**
> "Please describe how the automated redaction layer works. Is a third-party system being
> used? If so, please include a link to the third party company and clearly indicate which of
> the company's services are used."

Resolution: response identified OpenAI (Responses API, GPT-5 model) with company link, API
docs link, data processing agreement, and zero-retention statement; described the dual-pass
HIPAA Safe Harbor redaction architecture, redaction placeholder format, prompt-injection
resistance, and rationale for neural over rule-based redaction. The final application also
includes vendor privacy/terms links and the full system, redaction, and session-name prompts.

### Round 3 — Recruitment stipulation, 02/13/2026 (Resolved)

**S10. State therapist compensation in recruitment materials.**
> "Thank you for your detailed updates. One more minor, but required, item. Please state if
> therapists will be compensated (https://irb.byu.edu/recruitment-materials-and-guidelines...)."

Resolution: therapist recruitment email revised (Email_Therapist group_02.13.2026) to state
that therapists are not compensated; application compensation section states "Therapists - No
compensation will be granted."

---

## 2. The pattern — what this IRB's reviewers demonstrably care about

Ranked by how often and how forcefully it showed up:

1. **Cross-document consistency.** Four of ten stipulations (S1, S2, S3, S7) are pure
   consistency checks. The reviewers read the application, every consent form, and every
   recruitment document against each other, and they flag any divergence — time commitments,
   locations, benefit claims, and even require that consent edits be propagated back into the
   application. Assume every number, location, staffing claim, and benefit statement will be
   diffed across all attachments.

2. **No overpromising therapeutic benefit.** Flagged twice, in two separate rounds (S1, S5).
   "This study is not therapy" must be true everywhere: no "effective therapy," no "benefits
   from engaging in therapy," and benefit language never appears under Compensation. They
   distinguish sharply between compensation, direct benefit, and societal benefit.

3. **Concrete, specific risk disclosure — the reviewer will write your sentence for you.**
   In both S4 and S6 the reviewer supplied exact replacement language. Vague hedges ("harmful
   or concerning information," "there may be risks") get rejected; they want the mechanism
   (chatbot interaction may worsen your condition or trigger a crisis episode) and the
   consequence chain (identity reported to legal authorities, possible arrest and prosecution)
   spelled out. The path of least resistance is to adopt reviewer-grade phrasing pre-emptively.

4. **Explicit mandatory-reporting disclosure** (S6). The named categories — ongoing abuse,
   neglect, sexual exploitation, risk of harm toward self or others — plus identity disclosure
   and legal consequences must appear verbatim-or-stronger in every consent form.

5. **Crisis-alert adequacy — active, real-time, human-in-the-loop** (S8). For a mental health
   system, passive logging "is not sufficient." The reviewers expect detection to reach a
   human researcher in real time, and they accepted a response built on named mechanisms
   (push notification to an on-call researcher, staffing commitments, audit tables). Whatever
   Phase 2 promises here will be treated as a binding operational commitment.

6. **Third-party AI data flows must be fully specified** (S9). Vendor named and linked,
   specific service identified, retention/training posture stated, and the actual mechanism of
   de-identification described. The team pre-loaded the final application with prompts, test
   evidence, and vendor links — that level of disclosure is now the established baseline.

7. **Small procedural completeness items get caught too** (S10). Even a "minor, but required"
   omission (stating that a group receives no compensation) generated a stipulation and a
   round-trip. Recruitment materials are checked against the IRB's published guidelines page.

One more meta-observation: **stipulation responses become promises.** The crisis-alert
response (S8) committed to "at least two Research Assistants actively monitoring at all
times" — feasible for supervised lab slots, impossible for Phase 2's 24/7 remote use. Anything
written to satisfy a stipulation is part of the approved protocol and will be compared against
the Phase 2 text.

---

## 3. Potential pitfalls for Phase 2 (longitudinal, unsupervised, remote, voice)

Checklist of likely reviewer objections, each with a suggested pre-emptive mitigation in the
application text. Ordered roughly by severity.

### P1. Monitoring staffing promise vs. 24/7 naturalistic use
- **Likely objection:** "Phase 1 committed to at least two RAs actively monitoring at all
  times. How is continuous monitoring achieved when participants use the app from home at
  2 a.m.?" (Direct descendant of S8; the reviewers already ruled that passive logging is not
  sufficient for a mental health system.)
- **Pre-emptive mitigation:** Do not copy Phase 1's staffing language. State a sustainable
  model explicitly and contrast it with Phase 1: 24/7 automated real-time detection; SMS
  paging of a designated rotating on-call researcher on every high-severity flag; a defined
  acknowledgment target during waking hours; an honest, written overnight policy (per Q19 —
  e.g., agent-delivered crisis resources plus first-thing morning review, or in-app quiet-hours
  guidance); and the agent's own in-session crisis protocol (988, CAPS crisis line, Crisis
  Text Line surfaced to the participant immediately, independent of researcher response time).
  Note operational blocker ai-therapist-147: prod crisis-paging env vars must actually be
  wired before any participant onboards — do not promise paging that is not deployed.

### P2. Audio storage vs. Phase 1's "no audio is stored" claim
- **Likely objection:** "Phase 1 stated 'no audio is stored.' Phase 2 records voice sessions.
  Explain the change, the retention, and whether Phase 1 as currently running conforms to its
  approved protocol." Voiceprints are HIPAA Safe Harbor identifier 16 (biometric), so stored
  audio also undercuts an unqualified Safe Harbor de-identification claim.
- **Pre-emptive mitigation:** Resolve Q5 before drafting. Either (a) disclose audio recording
  plainly in application and consent — what is recorded, why (safety review and
  transcription-fidelity auditing), where (encrypted, access-controlled S3), retention period,
  and that audio is identifiable and therefore excluded from the de-identified research
  dataset — or (b) disable recording for study participants and keep the "no audio stored"
  posture. Do not let the reviewers discover the discrepancy; if Phase 1 is currently
  recording voice sessions, fix that via the in-progress Phase 1 amendment first so the
  program's record is clean when Phase 2 arrives.

### P3. BAA / zero-retention claims that cannot be evidenced
- **Likely objection:** S9 shows the reviewers drill into third-party AI data flows. Phase 1
  asserted "a signed Business Associate Agreement (BAA) is in place with the model provider
  (OpenAI)" and zero-retention endpoints. If Phase 2 restates this and is asked for the
  agreement — or the agreement does not cover the Realtime API now used for speech-to-speech —
  the whole data-flow section loses credibility.
- **Pre-emptive mitigation:** Verify before writing (Q8 / ai-therapist-132): who holds the
  OpenAI agreement, what it covers (must include the Realtime API), and the actual retention
  posture; move the account off the personal account to a university-controlled org
  (ai-therapist-139) so the application names the right owner. Then replicate the S9-response
  disclosure level for the current stack: vendor, exact services (Realtime API,
  redaction/analysis models by name from src/config at submission time), links, DPA/BAA
  status, retention, no-training statement, and current prompts attached. State only what is
  documented.

### P4. Clinical backstop with no clinician co-investigator
- **Likely objection:** Phase 1 had the CAPS clinical director as Co-I and a lab-escort-to-CAPS
  escalation path. Phase 2 (per Q1 decision) drops Erekson from the form, while risk goes up
  (longitudinal, unsupervised, remote). Expect: "Who provides clinical oversight? What is the
  escalation path for a remote participant in crisis — they cannot be escorted to CAPS?"
- **Pre-emptive mitigation:** Secure an updated CAPS support letter (Q17) that explicitly
  covers remote participants and names the after-hours path (e.g., 988 first, CAPS crisis line
  during business hours), and cite it in the procedures and risk sections. Name a licensed
  clinical consultant in the escalation chain even if not a Co-I, or be explicit that clinical
  response is via CAPS/988 referral rather than study personnel. Write the remote escalation
  procedure step-by-step (flag, page, researcher contact attempt, resource delivery, adverse
  event report) so no reviewer has to ask how a remote crisis reaches a human.

### P5. Minimal-risk justification for unsupervised longitudinal use
- **Likely objection:** Phase 1's risk section said only "No more than risks that are found in
  everyday life" — for a supervised one-hour lab session. That bare claim will not survive for
  repeated, unsupervised, remote emotional conversations with an AI; per S4 the reviewers
  demand concrete risk mechanisms, and they may push the study to full-board review.
- **Pre-emptive mitigation:** Keep the minimal-risk claim but argue it: enumerate
  psychological risk (including, verbatim-or-stronger, the S4 phrasing that interactions may
  worsen a participant's condition or trigger a crisis episode), privacy risk, and
  dependency/overreliance risk (name it before the IRB does), each with probability, magnitude,
  and mitigation. Support with the active-crisis exclusion screener at enrollment (Q16 —
  operationalized, e.g., C-SSRS-style items, with warm referral for excluded respondents),
  weekly distress items routed to the study team, in-app persistent crisis resources, and the
  red-team/crisis-ladder test evidence as attachments (a stronger version of the crisis test
  logs that satisfied Phase 1).

### P6. Dependency and overreliance risk (new category, likely reviewer-invented if we do not name it)
- **Likely objection:** "Eight weeks of open-ended access to a therapy-like AI may foster
  dependence on a non-clinical tool or delay help-seeking. How is this monitored and
  mitigated?"
- **Pre-emptive mitigation:** Dedicate a named risk entry: agent system prompt discourages
  dependency and encourages professional help; no gamified engagement mechanics; usage
  entirely participant-controlled; weekly surveys include overreliance/help-seeking items;
  consent states plainly the tool is not a substitute for professional care; access ends at
  week 8 with an off-ramp (resource list, optional Week-12 follow-up).

### P7. Compensation proration and undue influence
- **Likely objection:** S10 proves recruitment/compensation details get line-checked against
  IRB guidelines. Phase 1 answered "Will compensation be prorated? No" — acceptable for a
  one-hour session, coercive for an 8-week study (all-or-nothing payment pressures completion
  and penalizes withdrawal). Reviewers will also check that every group's compensation (or
  lack of it) is stated in every recruitment document.
- **Pre-emptive mitigation:** Answer "Prorated: Yes" with a per-milestone table (baseline,
  each weekly survey, exit) in the application, the consent form, and all recruitment
  materials — identical numbers everywhere (see P10). State explicitly that withdrawal forfeits
  only unearned increments. State compensation (including "none") for every participant group
  in recruitment materials, and keep total amounts modest enough to clear undue-influence
  review for about 3 hours of structured time.

### P8. "Not therapy" framing under longitudinal load
- **Likely objection:** The overpromising theme (S1, S5) plus the Drug/Device section: an
  8-week AI "support agent" measuring PHQ-2/GAD-2 trajectories looks more treatment-like than
  a one-hour lab chat. "If this is not a therapeutic study, justify that; if consent or
  recruitment hints at mental-health benefit, remove it."
- **Pre-emptive mitigation:** Scrub every document for benefit promises before submission —
  recruitment, consent, compensation, lay summary. Keep "no direct benefit" and put all value
  under societal benefit. Add an explicit sentence under the therapeutic-study question:
  well-being indicators are observational research measures, not treatment endpoints; the
  agent is a general wellness/support tool (FDA general-wellness framing, per Q14); the
  not-therapy statement is delivered at consent, at onboarding, and by the agent itself.

### P9. Mandatory reporting and monitoring disclosure in consent
- **Likely objection:** S6's exact language is now the floor. A remote longitudinal study adds
  a wrinkle: participants must also understand that researchers are watching crisis flags from
  their private at-home conversations (a monitoring disclosure, not just a reporting one).
- **Pre-emptive mitigation:** Carry the S6 language verbatim-or-stronger (ongoing abuse,
  neglect, sexual exploitation, risk of harm toward self or others; identity disclosed to
  legal authorities; possible arrest and prosecution). Add a plain-language crisis-monitoring
  disclosure: what the system detects, that a researcher is paged on high-severity flags, and
  what happens next. Cross-check the in-app clinical-mode consent copy (v2026-08-27.c1)
  against the study consent so the two cannot be diffed into a stipulation.

### P10. Cross-document consistency at much larger surface area
- **Likely objection:** The reviewers' favorite check (S1, S2, S3, S7, S10), now applied to
  more documents: application, one consent form, multiple recruitment pieces, CAPS letter,
  screening survey, weekly survey, in-app consent copy. Prime targets: total time commitment
  (baseline + 8 weekly surveys + suggested usage + exit must sum identically everywhere),
  study duration ("8 weeks" everywhere once Q4 is decided), locations (onboarding modality Q11
  vs. "remote"), compensation numbers, staffing/monitoring claims (application vs. any
  echoed Phase 1 response text), and audio/recording statements.
- **Pre-emptive mitigation:** Before submission, run a deliberate consistency pass: one person
  builds a table of every quantitative or categorical claim (minutes, weeks, dollars, N,
  locations, staffing, retention windows, model names) and greps every attachment for each.
  Phase 1 needed three rounds largely because of consistency misses; this pass is the cheapest
  way to save a round.

### P11. Accuracy of system description vs. deployed reality
- **Likely objection:** Not raised in Phase 1 (the description was accurate when written), but
  Phase 2 restating stale Phase 1 text creates contradictions the reviewers can catch against
  attachments and prior filings: "Whisper + GPT-4o" (now Realtime API), multi-layer risk
  scoring (shipped detector flags on keywords, trajectory logged passively), "BYU Box" as
  primary storage (reality: AWS RDS/S3 operational layer, Box for de-identified exports),
  24-hour original-retention default (verify prod value, Q9).
- **Pre-emptive mitigation:** Use the Phase 2 draft's do-not-reuse list. Describe the current
  system: exact model names pulled from src/config at submission time, keyword-based
  flagging with passive trajectory logging, both storage layers explicitly, verified retention
  window. Attach refreshed evidence (current dashboard/notification screenshots, rerun
  Safe Harbor redaction tests, red-team suite summary). If needed, refresh Phase 1's
  description via its open amendment so the two applications on file agree.

### P12. Remote participation logistics fully specified
- **Likely objection:** S3 descendant — "Where does the research occur?" must enumerate remote
  settings. A study conducted in participants' homes also raises privacy-of-setting questions
  (others overhearing voice sessions).
- **Pre-emptive mitigation:** Complete the off-campus location table (participants' homes/
  apartments, own devices) and the onboarding location (SONA lab and/or Zoom, matching Q11
  exactly wherever mentioned). In Privacy of Participants, add that onboarding advises using
  the app in a private space and that voice mode is optional where privacy is limited.

---

## Quick-reference: top five, if you read nothing else

1. **Staffing promise (P1):** replace Phase 1's "two RAs at all times" with an honest 24/7
   automated-detection + on-call-paging model, and wire prod paging before launch.
2. **Audio (P2):** reconcile "no audio is stored" with the S3 WAVs — disclose or disable, and
   clean up Phase 1 via amendment first.
3. **BAA (P3):** verify the OpenAI agreement (including Realtime API coverage) before
   restating it; move off the personal account.
4. **Clinical backstop (P4):** with no clinician Co-I, the updated CAPS letter covering remote
   participants plus a written remote escalation path is load-bearing.
5. **Minimal risk + consistency (P5/P10):** argue minimal risk concretely (reuse the
   reviewers' own S4/S6 phrasing) and run a full cross-document consistency pass — that is
   where Phase 1 lost two review rounds.
