# Researcher tutorial narration (2026-09-04). Slides from tutorial-screenshots/.

1. [title-researcher] Welcome to the research portal. This tour covers the researcher role — the study-operations seat with the widest access. Everything you'll see here is synthetic staging data.

2. [r01-sessions] Your home is Session History: every study session, searchable and filterable, with full transcript drill-down. As a researcher you hold the full-content data tier. Demo and test sessions are excluded from research exports automatically.

3. [r02-live-monitoring] Live Monitoring shows active sessions in real time — active users, message counts, and crisis sessions, with a crisis-only filter. From a live session you can observe, and when warranted, use the sideband controls.

4. [r03-analytics] Analytics gives you usage, performance, cost, and tool tabs over any date range — session activity, voice share, durations, and model spend. Descriptive operations data; the research dataset itself comes from Export.

5. [r04-crisis-management] Crisis Management aggregates every crisis event, intervention, and risk assessment, with what triggered each flag and the factors involved.

6. [r05-adverse-events] Adverse Events is your IRB duty station. High-severity flags and distress survey responses auto-draft reports here with review deadlines — the nav badge turns red when anything is overdue. Review, complete, and sign off; this queue feeds IRB reporting.

7. [r06-users] Users is the account directory. Researchers are the only role that can create accounts and change roles — this is where research assistants, therapists, and caseworkers get their access.

8. [r07-study-ops] Study Ops is the protocol control panel: enrollment against target, condition-arm balance with an imbalance alarm, sessions per participant, and protocol deviations, with an on-demand scan.

9. [r08-qualtrics-sync] Qualtrics Sync keeps all five study surveys flowing in on a schedule. Watch linkage health: unlinked finished responses usually mean a mistyped study ID and need human attention. Survey Data next door shows the per-participant completion matrix.

10. [r09-evals] Evals is the safety harness: nightly simulated sessions run through the real pipeline and are judged against gating assertions, with pass-rate trends, judge calibration, and drift alerts.

11. [r10-export] Export produces the de-identified research dataset — pseudonymized CSVs plus a codebook, deterministic for a given date, with no message content and no pseudonym mapping, ever. Redacted transcripts are a separate opt-in artifact.

12. [r11-sandbox-invites] Sandbox Invites mint one-time links that give a new therapist or caseworker an isolated practice environment with synthetic clients. Sandbox data never reaches exports, crisis paging, or email — it's how new staff learn safely. That covers daily operations. Now the system surfaces — the levers that shape the AI itself.

13. [r12-system-prompts] System Prompts holds the instructions the AI runs on: one prompt for voice sessions, one for chat, and the therapeutic-modality layer the condition arms toggle. The crisis-text variable injects the configured crisis line, so numbers are never hardcoded here. One rule above all: during the study, this prompt is a frozen instrument on file with the IRB. Read and verify, but treat any edit as a protocol event — coordinate with the PI first. Every save is versioned.

14. [r13-knowledge-base] The Knowledge Base is what the AI can retrieve mid-conversation — psychoeducation, techniques, and worksheets. Only approved content ever reaches live sessions, so the approval gate is your quality control. Use Test retrieval to probe what a query would surface, and the Retrieval log to see what participants actually pull. Like the prompt, the corpus is part of the intervention — keep it stable and log additions.

15. [r14-redaction-review] Redaction Review is the human check on the de-identification pipeline. Every message is automatically redacted and the original deleted after the retention window — this page is where you spot-check that nothing identifying slipped through, and that redaction kept the clinical meaning. If something got past the pipeline, edit it right here. A periodic pass, and always before any transcript export, is a protocol expectation.

16. [r15-consent-versions] Consent Versions is the audit trail for what participants agreed to. Each acceptance stores a hash of the exact text shown, so you can always prove which words a participant accepted. When an amendment changes consent copy, publish a new version here with an effective date — never edit copy anywhere else, and keep it matched to the IRB-approved document.

17. [r16-system-config] System Config holds study-level operational settings. Two matter most: the crisis contact block — the hotline and text line participants see in crisis moments — and on-call crisis paging, which texts the on-call phone on any high-severity flag. The dashboard toast only reaches someone watching the dashboard; the pager works at 2 A.M. Verify the on-call number at every handoff, and coordinate before changing anything here.

18. [r17-data-retention] Data Retention runs the data-minimization commitment: original message text is deleted after the retention period, but only once its redacted copy exists. Ready-to-wipe and awaiting-redaction are normal flow. Watch the errors card — a persistent nonzero count means originals are outliving the window and needs attention. The retention period itself is an IRB-filed parameter; the audit log below records every wipe.

19. [r18-triage-readonly] Last, the care-team connection. Triage is the same attention-ranked view therapists work from — for you it's oversight: audit that flags and escalations are being worked, and pull care context when reviewing an adverse event. And Caseload is where you assign participants to therapists — a therapist only ever sees their assigned clients. The care workflows themselves belong to the care roles and their own tutorials. That's the researcher seat — operations, safety, data, and the levers that shape the AI. Welcome aboard.
