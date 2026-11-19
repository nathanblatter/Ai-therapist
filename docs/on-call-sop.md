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

### What a page means, and when you will NOT get a second one

Every page has a `Why:` line. Read it first (`docs/crisis.md`, "Whether a
high-severity event becomes an SMS"; code: `crisisPaging.service`):

- **`Why: RISK SCORE n/100`** ("URGENT: ... HIGH crisis flag"): "from what the
  participant said" means the detector scored something the participant said
  as high risk. "set by the ASSISTANT asking for a human (escalate tool)" means
  the assistant itself asked for a person at high urgency; the 80 on that page
  is the fixed score for such a request, not a score of the participant's
  words, so read the transcript to see what prompted it. "(ESCALATED)" means
  the score has since reached 90 or more.
- **`Why: VENDOR CUT`**: the voice vendor's content filter ended the
  participant's voice session. The page says what their risk was:
  - "during a HIGH crisis flag" (URGENT): they were at high risk and lost the
    assistant mid-conversation.
  - "NOT a high risk score ... MEDIUM": they were at medium risk. The filter
    often cuts the assistant's own screening question, so the participant's
    answer may be what was lost (the page says so). Review the transcript and
    consider reaching out; do not read "not high" as "no concern".
  - "could NOT be read": the system could not determine their risk. Treat it
    as possibly serious.
  - "the participant has NOT come back": a session was cut and the participant
    has not said anything in any session for 3 minutes. If it also says "at
    HIGH risk" it is URGENT.
- **`Why: VENDOR SESSION LIMIT`**: a voice session reached the vendor's
  maximum length during a high flag; the app reconnects the participant.

One participant, one incident, few texts. After a page is **delivered**, later
events for the **same participant** in the next **15 minutes** (the
acknowledgement target below) that say nothing new or worse are **not texted
again**. They are recorded and appear on the dashboard: a banner in Live
Monitoring, and "external api called" rows with a "Not paged: ..." line in
Crisis Management → Interventions. You are texted again inside the 15 minutes
only for something new or more serious: a higher level, or the vendor cutting
a session you were just told is high risk. So after any page, **keep the
dashboard open for that participant for at least 15 minutes**: silence on the
phone does not mean nothing further happened.

A vendor cut of a session with **no** risk flag is not texted at the cut. It
is shown on the dashboard, and you are texted 3 minutes later only if the
participant has not spoken again. That check survives a server restart or
deploy: it is stored with the record of the cut and picked up again when the
server starts. Only if the server is down for more than 15 minutes after the
cut is the check not run; the cut's dashboard record then says "Silence check
NOT run", and nobody is texted for it.

A participant's first high-risk statement in a **recovery session** (the
session the app opens after a vendor cut) pages like any other and is on the
record as a crisis flag of its own, with its score; if the incident had no
adverse-event draft yet, one is drafted then.

A text counts as delivered when the SMS relay accepts it. If your phone was
off or out of coverage, texts for that participant may have been folded for
up to 15 minutes: on coming back into coverage, check the dashboard.

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
- **Dependence and problematic-use flags (weekly survey W11/W12, added
  2026-11-18; thresholds are the PI's decision, Q-DEP1):** reviewed in the
  same one-business-day pass as W7/W8. A participant is flagged when any of:
  W11 (ADS-9 Craving, adapted) mean of 4.0 or more; W11 mean up by 1.0 or
  more from their first weekly survey; W12 (BSMAS, adapted) total of 19 or
  more. A flag is not a crisis page. The reviewing researcher sends one
  check-in message through the in-app messaging channel within one business
  day: thanks them, restates that the agent is not a substitute for people or
  professional care, lists CAPS (801-422-3035) and 988, and reminds them they
  may pause. A second consecutive flag goes to the PI, who decides whether to
  offer a pause or a call. If the same survey's free text (W8/W10) describes
  risk, use the triage ladder in section 4 instead. Record each flag and
  action in the weekly-review notes for that participant; flags are counted in the weekly
  review and reported at continuing review.
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
- **Risk assessor outage page (ai-therapist-190):** a page beginning "the AI risk
  assessor is failing" is a system alert, not a participant crisis. The assessor has
  failed at least twice in a row for a reason other than the spend limit (the page
  names it: `timeout`, `overloaded`, `other` with a code such as `model_not_found`).
  Until it recovers, crisis detection runs on the keyword screen only, so risk stated
  without a crisis keyword can be missed; explicit and passive-ideation phrases still
  flag and page. Check status.openai.com, the API key, and the `crisis.risk_model`
  setting in System Config (a mistyped model id causes exactly this). One page per
  outage, at most one an hour; there is no all-clear page. Sessions touched by the
  outage show an "external api called" intervention with `degraded: risk_assessor`;
  consider watching any live session until it is resolved.
- **OpenAI spend limit page (ai-therapist-190):** a page beginning "OpenAI is
  rejecting requests because the account spend or usage limit has been
  reached" is a system alert, not a participant crisis. While it lasts, crisis
  detection runs on the keyword screen only (no AI risk assessment, no
  moderation screen), async client messages without crisis keywords wait
  unscanned (`scan_failed`, re-tried every 3 minutes), new voice sessions cannot
  start and chat replies fail. Raise the limit in the OpenAI billing settings at once. The page
  repeats hourly until it is fixed.
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
| Crisis Text Line | participant resource | text HOME to 741741 |
| Emergency | immediate danger | 911 |
