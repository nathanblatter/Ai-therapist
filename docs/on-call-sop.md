# On-Call Safety Monitoring SOP (Phase 2)

**Status: DRAFT for Nathan + Dr. Gaskin to review.** The Phase 2 IRB
application promises "a trained on-call researcher is designated at all times
during the study period with a documented escalation path." This is that
document. Bracketed items are decisions the team must finalize before launch.

---

## 1. What the system does automatically

When a participant's message trips the imminent-risk detector
(`docs/crisis.md` — explicit suicidal/self-harm intent only):

1. The **agent** follows its crisis protocol in-session: acknowledges, checks
   immediate safety, and surfaces 988, the Crisis Text Line, and CAPS.
2. The **admin dashboard** shows a real-time crisis alert to every monitoring
   researcher (Crisis Management view).
3. The **on-call phone is paged by SMS/iMessage** with a link to the session
   (`crisisAlert.service`; destination phone is admin-configurable in System
   Config → crisis_alert, so rotation requires no redeploy).
4. Session monitoring frequency is elevated; every event and system action is
   logged (`crisis_events`, intervention log).

No automated message beyond the agent's own protocol is sent to the
participant — a trained human decides the response.

## 2. On-call rotation

- One **on-call researcher** is designated at all times during the study
  period. [Roster + rotation length: weekly? — decide with the RA team.]
- The rotation is changed by updating the on-call phone in System Config →
  crisis_alert (researcher role required). The change takes effect on the next
  alert; verify by sending a test page after each handoff.
- On-call researchers must have completed [CITI human-subjects training +
  the crisis-response walkthrough with the PI/clinical support].

## 3. Response targets

- **Waking hours (6:00 AM – 10:00 PM Mountain):** acknowledge the page within
  **15 minutes** — open the session in the dashboard, review context, and
  begin triage (below).
- **Overnight (10:00 PM – 6:00 AM Mountain):** the app blocks new participant
  sessions (quiet hours) and shows crisis resources instead, so no new
  conversations occur overnight. A session already in progress at 10:00 PM may
  run to completion; the pager stays armed for it. Pages arriving overnight
  from any residual activity are acknowledged by [next-morning 8:00 AM at the
  latest — confirm this is the promise made to the IRB, and say it plainly in
  the consent if it changes].

## 4. Triage ladder

On acknowledging a page:

1. **Review** the flagged session (transcript, risk score, prior events for
   the participant). The agent has already surfaced crisis resources.
2. **Classify:**
   - **False positive / no imminent risk** (e.g. idiom, media reference):
     record the determination in the crisis event notes; no participant
     contact. These reviews feed the weekly false-positive audit.
   - **Concerning but not imminent:** message the participant through the
     in-app messaging channel within [24 hours] with resources and a check-in;
     create a work-queue follow-up; note the event.
   - **Imminent risk indicated:** proceed to step 3 immediately.
3. **Escalate (imminent risk):**
   - Contact the participant using [the contact pathway consented to —
     in-app message first; phone if a number is on file].
   - Consult the clinical escalation contact: [Dr. de Vreede for protocol
     questions; CAPS crisis line 801-422-3035 / after-hours via BYU Police
     801-422-2222 for clinical emergencies — CONFIRM with the CAPS letter].
   - If there is reason to believe the participant is in immediate danger,
     contact emergency services (911) and provide identity information as the
     consent's mandatory-reporting disclosure describes.
   - Notify the PI (Dr. Gaskin) the same day.
4. **Document everything** in the crisis event record: timestamps, what was
   reviewed, determination, actions, who was consulted.

## 5. Weekly review + IRB reporting

- **Weekly:** the research team reviews all crisis events, response times
  (page → acknowledgment), false-positive determinations, and any adverse
  experiences reported in the weekly survey (W7/W8). Owner: [rotating RA].
- **Serious adverse events** are filed through the in-app adverse-event
  reporting module and reported to the IRB per BYU HRPP policy timelines.
- **Drift check:** if flag rates or false-positive rates move materially,
  raise at the weekly meeting; detector changes are protocol-relevant and get
  PI sign-off.

## 6. System health (the pager must itself be watched)

- Prod uptime is checked every 5 minutes from the home box
  (`scripts/prod-uptime-check.sh`, launchd job `com.nathan.ai-therapist-uptime`);
  2 consecutive failures page the on-call phone; recovery pages once.
- **Launch blocker (ai-therapist-147):** the prod crisis-paging env vars are
  currently UNSET — paging must be wired and test-fired before the first
  participant onboards.
- After every deploy touching the crisis path: run the red-team smoke suite
  (CI does this automatically) and send one manual test page.

## 7. Contact card

| Who | Role | Contact |
| --- | --- | --- |
| On-call researcher | first responder | System Config → crisis_alert phone |
| Nathan Blatter | study coordinator | nzb22@byu.edu |
| Dr. James Gaskin | PI | james.gaskin@byu.edu |
| [Dr. Triparna de Vreede] | clinical-protocol support | [confirm] |
| BYU CAPS | clinical resource | 801-422-3035 (after hours: BYU PD 801-422-2222) |
| 988 Suicide and Crisis Lifeline | participant resource | call/text 988 |
| Crisis Text Line | participant resource | text HELLO to 741741 |
| Emergency | immediate danger | 911 |
