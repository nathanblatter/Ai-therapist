# IRB continuing-review packet

One-click assembly of the numbers the IRB asks for at continuing review
(Phase 1 protocol 2025-519-BYU; annual check-in). Researcher-only, scoped to
the caller's organization. Generated from the Study Ops view (IRB packet
section: date range, "Open printable", "Download zip") or directly:

| Route | Returns |
| --- | --- |
| `GET /admin/api/irb/packet?from&to` | JSON (`IrbPacket`, see `src/server/services/irbPacket.service.ts`) |
| `GET /admin/api/irb/packet.html?from&to` | Self-contained printable HTML (inline CSS, no external assets; browser Print / Save as PDF) |
| `GET /admin/api/irb/packet.zip?from&to` | `packet.json`, `adverse_events.csv`, `deviations.csv`, `consent_versions.csv`, `README.md` |

`from`/`to` are `YYYY-MM-DD` or ISO timestamps; default is the trailing 365
days, maximum window 400 days. Every HTML or zip generation writes one
`data_access_log` row (`action = 'export'`, `detail.kind = 'irb_packet'`,
with the format and period), so the packet is itself visible in the Data
Access view. Sandbox accounts get 404; other roles 403.

Code: `src/server/db/irbPacket.queries.ts` (SQL),
`src/server/services/irbPacket.service.ts` (composition, HTML, CSV, zip),
`src/server/routes/admin/irbPacket.routes.ts`.

## Scope rules

- Demo sessions (`is_demo`) and sandbox users are excluded everywhere.
- Participant data is in scope when `users.organization_id` is the caller's
  org. Rows with no participant (anonymous sessions, unattributed adverse
  events) count only when the caller's org is `irb-study`, matching the
  adverse-event register.
- Protocol deviations, eval drift alerts and harness runs are study-global
  tables (no org column) and are windowed only.
- Counts only, except adverse events and deviations, which the IRB needs as
  records. Those rows never carry `participant_ref`, `user_id`, `session_id`,
  `transcript_excerpt` or any staff username; free text is additionally
  scrubbed of email addresses and "participant/user NNN" ids.

## Sections and their sources

| Section | Source | Notes |
| --- | --- | --- |
| Header / 1. Study | `system_config.study_protocol` (`protocol_id`, `principal_investigator`, `study_title`, targets, study window) and `deployment_mode` | Identifiers are set on the Study Ops protocol form; blank until filled. Header also carries generated-at and the build git sha. |
| 2. Enrollment | `therapy_sessions` x `users` | Newly enrolled = first in-scope session inside the window; cumulative cohort = participants with any session on or before `to`. Active / paused / withdrawn from `users.study_status` (withdrawal survey, migration 087), with in-window status changes from `study_status_changed_at`. Completed = reached `expected_sessions_per_participant`. Arms: in-window sessions and participants per `session_configurations.proactive_offering` and `ai_model`. |
| 3. Sessions | `therapy_sessions`, `session_configurations.modality` | Sessions started in the window; ended count; mean `ended_at - created_at` in minutes; split by `session_type` and modality. |
| 4. Safety | `crisis_events`, `therapy_sessions.crisis_*`, `intervention_actions`, `escalations` | Crisis events by `event_type` x `severity`; sessions flagged in the window and whether they were unflagged, stayed flagged, or got an AE report; interventions by `action_type`; pages sent = `crisis_sms_alert` actions; care-team escalations by status x urgency (org-scoped by `escalations.org_id`). |
| 5. Adverse events | `adverse_event_reports` (`occurred_at` in window, register scope) | Tallies by severity / status / category plus the de-identified register: id, occurred, severity, category, trigger, status, summary, submitted, closed, resolution (status + last `actions_taken` action name). Full reports stay in the AE register and its print view. |
| 6. Protocol deviations | `protocol_deviations` (`occurred_at` in window) | Tallies plus register: id, occurred, source (auto / manual), category, severity, status, description, resolved. |
| 7. Consent | `consent_documents`, `participant_consents` | Versions in force at any point in the window per audience (effective on or before `to`, not superseded before `from`), whether still in force at period end, acceptances in window and total by in-scope participants. |
| 8. Quality monitoring | `eval_drift_alerts`, `harness_runs` | Drift alerts opened / acknowledged / open at period end / paged. Red-team and simulation harness runs per suite (dry runs excluded): runs, scenarios, passes, pass rate, last run. |
| 9. Data access | `data_access_log` | Counts by action x actor role where the actor or the participant is in the org (same scope as the Data Access view). The packet's own generation rows appear here on the next run. |
| 10. Incidents | none | Always empty. See below. |
| 11. Narrative | none | Blank lines and a signature line on the printable. |

`packet.json` repeats this mapping under `meta.sources`.

## What still has to be written by hand

- **Data-security incidents.** There is no automated source. Fill from the
  on-call log and the security mailbox: date, what happened, data involved,
  number of participants affected, containment, and whether the IRB was
  notified inside the reporting window. Write "None during this period"
  explicitly when that is the case.
- **Narrative and attestation.** Progress since the last review, changes to
  protocol, personnel or consent, the reason for any deviation still open,
  and the PI signature.
- **Study identifiers** if they are blank: set protocol id, PI and title on the
  Study Ops protocol form so the header fills itself next time.
- **Context for counts.** The packet reports what the database holds; it does
  not interpret. A drop in harness pass rate, an open major deviation or a
  still-flagged session needs a sentence from the researcher.

## Verification

`src/server/services/irbPacket.service.test.ts` (composition, scrubbing,
escaping, empty render), `src/server/routes/admin/irbPacket.routes.test.ts`
(role matrix, sandbox 404, org scope, audit row, zip entries),
`src/server/db/irbPacket.queries.test.ts` (window and scope params). The SQL
was also exercised against the stage database when the feature shipped.
