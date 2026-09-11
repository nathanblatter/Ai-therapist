# Live verification checklist (one voice session)

Code-side halves of ai-therapist-15 / ai-therapist-53 are verified statically
(see "Static findings" below). The items in this checklist need one real voice
session on production (or a prod-like run with real OpenAI keys) that is
allowed to hit the max-duration limit. Watch the **server logs**, the
**browser console**, and the **admin Live Monitoring page** simultaneously.

> **Before you start:** check Admin → System Config → Session Limits.
> `max_duration_minutes` may still be set to the **5-minute test value**
> (migration default is 30). 5 min is convenient for this checklist — but
> remember to restore the intended study value afterwards.

## A. Sideband attach (GPT-Live)

Rewritten for GPT-Live. The Realtime-era steps (`call_id` scraped from a
`Location` header, `register-call`, the attach race and its retries, the
ephemeral-key fallback) are all gone — the session id comes back in the JSON body
of `POST /api/live/session` and is valid immediately. See `docs/gpt-live.md`.

1. Start a voice session. In the browser console expect
   `[Live] Session started: live_...` on the data channel. There is no
   `call_id` extraction or registration step any more; if you see one, you are
   running stale client code.
2. Server logs expect, in order:
   - `[Live] Attaching sideband for <session>... -> live_...`
   - `[Live] Sideband established for <session>...`
3. **Must NOT appear:** `Live sideband upgrade rejected: HTTP 401/403` — the
   sideband must use the same project API key that created the session, and
   there is no fallback credential. A 4xx here means the key or the session id
   is wrong.
4. In admin Live Monitoring, the session shows a green "connected" sideband
   entry and the Live Transcript streams both sides as you talk. Note that
   participant turns appear as a running caption and only commit as a finished
   turn after ~900 ms of silence (server-side turn assembly).

## A2. GPT-Live specifics (new, unverified live)

1. **Delegation fires.** Say something substantive. Expect
   `[Live] ... Event: session.delegation.created` server-side and the admin
   "backend thinking" indicator; the spoken reply should follow.
2. **Usage meters.** `live_usage` gets a row for the session with
   `duration_seconds` climbing as `session.usage.updated` arrives. Confirm it is
   ONE row that is overwritten — never multiple rows, and never a sum.
3. **Finalization.** After a clean end, that row must have `finalized = true`
   and a `close_reason`. `finalized = false` means `session.closed` never
   arrived and the duration is provisional — check for
   `No session.closed within 5000ms ...; final usage unconfirmed.`
4. **Backend token usage.** `session_llm_usage` has rows with
   `purpose = 'live_delegation'` naming the backend model.
5. **Crisis steering delivery.** A crisis-tier turn should produce
   `session.instructions.append` on the sideband and an `intervention_actions`
   row. Remember the acknowledgement does not prove the model acted — judge by
   what it says next, not by the event.

## B. Two-phase auto-terminate + goodbye (ai-therapist-53)

1. Let the session run to `max_duration_minutes`. At the limit, server logs:
   `⏰ Session <id> hit <N>min limit — asked model to wrap up (75s grace)`.
2. The ASSISTANT should audibly say a brief goodbye (2-3 sentences, no new
   topics) and the session should END ITSELF within ~75s of the limit
   (client log: `end_session` tool → session teardown ~6s after the goodbye
   audio). The hard-end log
   (`⏰ Auto-terminating session ... after N minutes (+grace)`) should **NOT**
   appear — if it does, phase 1 failed and the backstop fired.
3. The participant sees the session close normally (no abrupt cut mid-audio).

## C. Recording integrity (ai-therapist-53)

1. During the session, server logs show exactly **one**
   "started recording"-style line per session (recorder start) — no double
   start after reconnects.
2. After the session ends: recording finalizes once;
   `recording_duration_ms` (admin Session Detail → recording info) should
   match the actual conversation length (limit + goodbye overhang), not a
   longer/shorter phantom duration.
3. After the end, the browser must **stop** POSTing `/api/sessions/:id/audio`
   within one flush interval: expect at most ONE 410 response in the network
   tab, then silence. Repeated 410s = uploader stop logic regressed.

## D. Live monitoring (ai-therapist-16)

1. Open admin Live Monitoring AFTER the session has been running a few
   minutes (late join): the session row appears with correct message count,
   and opening its transcript panel shows the FULL history (DB seed) followed
   by live turns — not just turns since the page loaded.
2. Message count and "last activity" tick live between the 15s DB flushes.
3. Briefly kill and restore the admin's network: on reconnect the list
   re-seeds (no ghost sessions, counts reconcile).

## E. Tool-call single-handling (ai-therapist-15)

1. Ask the AI for a breathing exercise (or trigger any UI tool).
2. Expect: overlay appears once, ONE `Tool <name> executed` server log
   (sideband), ONE tool_call/tool_response message pair in the transcript,
   and the model responds once (no doubled reply audio).

## Static findings (already verified in code, no live action needed)

- **ai-therapist-15:** no double-handling exists. The server sideband is the
  canonical executor — under GPT-Live it sends `response.item.create`
  (`function_call_output`) followed by a separate `response.create`, since
  appending a result does not continue the backend response on its own. The
  client handles the same nested `response.event` → `response.output_item.done`
  only to drive local UI and logging; it never answers the tool call. Minor
  leftover, still present: the client `fns` map has a dead `stopSession` key
  (no tool by that name; the real tool is `end_session`). The
  previously-noted `useRealtimeSession.ts` duplicate was already deleted in
  commit c595052 (dead-code removal) — nothing to do.
- **ai-therapist-53:** the two-phase terminate (phase 1 sideband wrap-up
  injection at the limit, phase 2 hard end after 75s grace, both re-checking
  session status), the recorder `finalized` set guarding
  `appendChunk`/`finalize` against post-end writes, and the 410 →
  uploader-stop path (`dead = true`, timer cleared, buffer dropped) are all
  intact on main.
