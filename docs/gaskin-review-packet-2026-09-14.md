# Items Needing PI Review — AI Support Agent Longitudinal Study

**Prepared by:** Nathan Blatter
**Date:** September 14, 2026
**For:** Dr. James Gaskin, Principal Investigator

This is the consolidated list of everything currently waiting on your review, decision, or signature, organized by the kind of input needed. Items A1–A3 are the critical path to Phase 2 launch.

---

## A. Phase 2 IRB signature path (your signature is the gate)

1. **Phase 2 longitudinal IRB application (in OneAegis, validation clean).**
   Needs your end-to-end read of the protocol design — measures (PHQ-2/GAD-2, WAI-SR), 8-week schedule, study arms, safety-monitoring plan — then signature. An open-questions list is drafted for you, notably the **study budget** (Q6) and **study framing** (Q14), plus the Sagers supervisor-permission question.

2. **OneAegis re-paste before signing.**
   The September 9 telemetry expansion changed the Data Collection / Confidentiality text after the form was first filled. What you sign needs to be the re-pasted version declaring the full behavioral-telemetry set and its non-collection boundary.

3. **Consent v3.**
   Consent gained a "What the App Records and Analyzes" section and an indefinite-retention/embeddings sentence. Needs your review of the new language before the v3 document is attached and signed.

## B. Compliance decisions only the PI / BYU can make

4. **No OpenAI BAA, no zero-data-retention (top compliance blocker).**
   Phase 1's approved text claims both. Decision needed: (a) pursue a BAA + ZDR through OpenAI sales — which requires the real university org, see next item — or (b) have the IRB explicitly bless the current data flow and correct Phase 1's language.

5. **The OpenAI org is a self-serve account merely named "Brigham Young University,"** not an institutional org. Decision needed: who at BYU owns standing up or connecting the real university-controlled org, and on what timeline. This gates the BAA path above.

6. **The $120/month hard OpenAI spend cap will rate-limit the crisis-detection path when hit** and is undersized for Phase 2. Needs the real study budget (your Q6 answer) so the cap can be raised safely above projected spend.

## C. Study-design decisions

7. **Recording retention (90 days) vs. prosody research aims.**
   The 90-day window erodes the participant-audio corpus the prosody analysis (eGeMAPS) needs. Decision: the Phase 2 retention window — and it must match the consent language.

8. **Almost no human ground truth.**
   Current state: 1 human rating vs. 76 LLM evaluations and ~700 automated risk scores — the system's safety evidence is largely a model judging a model. Decision: a human-rating/adjudication protocol (who rates, sampling plan, instrument).

9. **Pre-registered analysis plan.**
   The LLM-as-second-coder qualitative methodology must be named in the pre-registration, and primary outcome models plus power analysis need PI sign-off before unblinding. Decision: approve the analysis-plan approach so it can be written down as the pre-registration artifact.

## D. Decisions already made that should be ratified by the PI

10. **GPT-Live model cutover and "Phase 1 is done, no amendment needed"** (Nathan's call, September 11): the voice backend was fully replaced between phases. Needs your confirmation that Phase 1 enrollment is closed and the cutover lands cleanly between phases.

11. **Privacy incident** (15,949 raw pre-redaction transcripts retained at OpenAI; fixed, purged, IRB write-up filed September 10). Needs: confirmation you have seen the report and agree with the disposition. Root-cause remediation is items 4–5 above.

12. **Phase 2 telemetry expansion** (acoustic features, engagement events — feature-flagged OFF until approval). You are effectively signing this in items 1–2; flagging it explicitly rather than letting it ride in the paste.

## E. Study ops and personnel

13. **Research team needs to be told old accounts are void** (production database fresh start August 28; participants get re-created). Needs you or the study coordinator to communicate re-onboarding to the team.

14. **New collaborator (from our September 14 meeting):** needs a name and start date from you. Before they touch participant data: IRB personnel amendment, CITI training, and data-access scoping. A ready-to-hand-off lane of self-contained, non-safety-critical work is already prepared.

## F. Intellectual property

15. **Developer allocation settled in writing while still hypothetical** (per the conception-record / TTO plan). Needs: a short written-agreement conversation.

---

## Additions from the September 14 meeting follow-through

16. **Exit Survey question X3** ("What did you use the AI support agent for most?") is arguably computable from session topic analysis. Your call under the "measure objectively where we can" rule: keep it as a perception measure, or remove it.

17. **FYI for the next IRB touchpoint:** per your direction, the two self-report usage questions (times used, voice/text) were removed from the live Weekly Check-in survey on September 14 — usage and modality are now measured from app telemetry. This is a reduction in data collected, but worth noting in the next amendment or continuing-review report.

Already executed from that meeting (no action needed): removal of the computable weekly survey questions, removal of orange from the app and survey styling, and the caseworker catch-up view.
