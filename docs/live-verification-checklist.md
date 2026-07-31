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

## A. Sideband attach with the standard API key (ai-therapist-62 — NEW, unverified live)

1. Start a voice session. In the browser console expect
   `[Sideband] Extracted call_id: rtc_...` then
   `[Sideband] Registered call_id with server`.
2. Server logs expect, in order:
   - `[Sideband] Attaching to wss://api.openai.com/v1/realtime?call_id=... (attempt 1)`
   - possibly 1-2 `call_id not registered yet; retrying attach ...` lines (the known race)
   - `[Sideband] Connection established for session ...`
3. **Must NOT appear:** `Standard API key rejected (HTTP 401/403)` — if it does,
   the ephemeral fallback kicked in and OpenAI really does reject the standard
   key for sideband: reopen ai-therapist-62 with the logged status/body.
4. In admin Live Monitoring, the session shows a green "connected" sideband
   entry and the Live Transcript streams both sides as you talk.

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
  canonical executor (sends `function_call_output` + `response.create`); the
  client `fns` map in `App.tsx` reacting to the same
  `response.function_call_arguments.done` event only drives local UI and
  logging — it never answers the tool call. Minor leftovers: the `fns` map has
  a dead `stopSession` key (no tool by that name; the real tool is
  `end_session`). The previously-noted `useRealtimeSession.ts` duplicate was
  already deleted in commit c595052 (dead-code removal) — nothing to do.
- **ai-therapist-53:** the two-phase terminate (phase 1 sideband wrap-up
  injection at the limit, phase 2 hard end after 75s grace, both re-checking
  session status), the recorder `finalized` set guarding
  `appendChunk`/`finalize` against post-end writes, and the 410 →
  uploader-stop path (`dead = true`, timer cleared, buffer dropped) are all
  intact on main.
