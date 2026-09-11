# GPT-Live voice backend (`gpt-live-1`)

The voice side of the study runs on OpenAI's GPT-Live model. It replaced the
Realtime API outright — there is no dual-path fallback in the code, only a
config switch (`system_config.ai_model`) that a rollback would have to point at
a Realtime model id, and a `src/redteam/voiceClient.ts` that has not been ported
(see `docs/redteam.md`).

GPT-Live is **full duplex**: it listens and speaks at the same time, rather than
alternating turns. That single property explains most of the differences below —
no turn-completed events, no server VAD to disable, no way to force the model to
speak, and transcripts that arrive as timestamped fragments rather than finished
utterances.

Source of truth for everything here:

| Concern | File |
|---|---|
| Session config, prompt split, voice registry | `src/server/utils/liveSessionConfig.ts` |
| SDP handshake, gates, session creation | `src/server/routes/public/liveSession.routes.ts` |
| Sideband: events, transcripts, tools, usage | `src/server/services/sidebandManager.service.ts` |
| Per-second voice billing | `src/server/db/liveUsage.queries.ts` |
| Auto-termination (shared with any voice path) | `src/server/utils/sessionAutoTerminate.ts` |
| Schema + config cutover | `src/database/migrations/098_gpt_live.sql`, `099_gpt_live_voices.sql` |
| Browser WebRTC + data channel | `src/client/main/components/App.tsx` |

---

## 1. Two models, not one

A GPT-Live session runs **two** models:

- **The voice model** (`gpt-live-1`). Owns the spoken conversation: listening,
  speaking, pacing, backchannels, interruption handling, and the decision to
  hand work to the backend. It is not the clinician.
- **The delegated backend** (`gpt-5.6-terra` by default, via Responses
  delegation). Owns the clinical content: the full therapy system prompt, the
  modality appendix, the participant's check-in and memory block, and every tool
  schema. Substantive therapeutic responses come from here.

This is configured once, at session creation, in the `delegation` block:

```jsonc
delegation: {
  type: 'responses',
  responses: {
    model: backendModel,          // system_config.live_backend_model
    instructions: <clinical prompt>,
    tools: [...],                 // registry tools, Responses function schema
    tool_choice: 'auto',
    parallel_tool_calls: false,
  }
}
```

`parallel_tool_calls` is off deliberately. Several tools mutate session state
(`end_session`, scale administration); parallel calls would let the backend
request an end alongside work that assumes the session is still open.

**Why it matters for the study:** clinical response quality is determined by
`live_backend_model`, not by `ai_model`. An analyst comparing sessions must read
both (see `docs/model-pinning.md`).

### The prompt split

| Layer | Holds | Built by |
|---|---|---|
| Voice model (`session.instructions`) | Role and tone, backchannel policy, interruption policy, delegation policy, one safety line | `buildLiveInstructions()` |
| Backend (`delegation.responses.instructions`) | The entire clinical system prompt, wrapped in voice-transcript framing and a "return the result" contract | `buildLiveBackendInstructions()` |

The split is not cosmetic. The live model has a small context window, and
copying a long Realtime-era prompt wholesale into `session.instructions` degrades
it. Keeping the clinical prompt in the backend also means the therapy content
runs on a model we pin ourselves, independently of the voice model.

The clinical prompt string is assembled exactly as the Realtime path assembled
it — base prompt + modality + proactive-offering arm + language addition + tool
guidance + memory block + check-in block — so the therapeutic content is
unchanged by the migration and sessions remain comparable across it.

One substantive addition over the vendor's starter template: the voice model is
told that if the participant expresses thoughts of suicide, self-harm, or harming
someone else, it must stay present and respond itself rather than going quiet
while it waits for the backend. A crisis disclosure must never sit behind a
round-trip. The actual crisis handling still runs server-side (see
`docs/crisis.md`).

The delegation policy describes backend **capabilities**, not tool-call syntax.
Those lines tell the voice model what help is available; they are not
instructions for it to invoke anything itself. Only the backend calls tools.

---

## 2. Connection handshake

The handshake is **inverted** relative to Realtime, and the inversion is an
improvement.

Realtime: the server minted an ephemeral client secret, the browser POSTed its
SDP straight to OpenAI, and the server only learned the call id when the browser
scraped it out of a `Location` response header — a step that silently failed
whenever CORS hid the header. That failure mode is what the `sideband_no_location`
beacon existed to report.

GPT-Live:

1. The browser opens the mic, creates the `oai-events` data channel (before
   `createOffer()` — the channel is negotiated in the SDP), builds an SDP offer,
   and waits for ICE gathering to complete. The offer travels in one HTTP
   request, so late candidates would have nowhere to go.
2. The browser POSTs `{ sdp, voice, language, checkin }` to **our**
   `POST /api/live/session`.
3. The server runs every gate first — consent, quiet hours, study status,
   rate limits, one-active-session idempotency — and validates that
   `system_config.ai_model` is a `gpt-live-*` id. Gates run **before** the
   OpenAI call because session creation costs money the moment it succeeds
   (see Billing).
4. The server assembles the session config and POSTs to
   `https://api.openai.com/v1/live/sessions` with the **project API key**, body
   `{ session, transport: { type: 'webrtc', sdp } }`.
5. OpenAI returns `session.id` and `transport.sdp` in the **JSON body**. No
   header scraping.
6. The server writes the session rows, attaches the sideband, arms
   auto-termination, and returns `{ session_id, sdp, voice, language,
   session_limits }`.
7. The browser applies the answer with `setRemoteDescription`, then waits for
   `session.started` on the data channel. Nothing may be sent before that event.

Consequences worth stating plainly:

- **No ephemeral key ever reaches the browser.** The project key stays
  server-side, and the sideband uses the same key that created the session —
  the docs require it, so there is exactly one correct credential and no
  ephemeral-key fallback path.
- **The `register-call` endpoint is gone**, along with the call-registration
  race and its retry loop. The session id is valid the moment the create call
  returns.
- **The sideband attaches before the SDP answer is returned to the client**, so
  no transcript fragment — and therefore no crisis signal — can arrive before
  the server is listening.
- The GPT-Live session id **is** our therapy session id. It is treated as
  opaque; the `live_...` prefix is preserved and never parsed. It is stored
  separately from `openai_call_id` because the two are different namespaces with
  different attach URLs.

If the DB write fails after OpenAI has created the session, the route logs and
continues: the voice session is already live and billing, and losing it over a
DB hiccup would be worse than running with a lazily-created row.

### Opening preamble

Realtime opened the conversation with a hidden user turn plus a forced response.
GPT-Live has neither. The preamble is delivered as a trusted instructions append
telling the model to speak first, immediately, then pause and listen.

---

## 3. The sideband

The server attaches a WebSocket to the browser-owned WebRTC session:

```
wss://api.openai.com/v1/live/sessions/{session_id}/attach
```

Authenticated with the project API key plus `OpenAI-Safety-Identifier`. It is
how the backend executes tools, persists transcripts, meters usage, and steers
the conversation.

The manager's public surface (`tryInject` / `isConnected` / `disconnect` /
`getActiveConnections` / `reattachActiveSessions` / `injectMessage` /
`updateSession` / `interrupt` / `createResponse` / `triggerTool`) was preserved
so the ~20 existing call sites in crisis intervention, session lifecycle, the
tool registry and the admin routes did not have to change. The semantics
underneath changed a great deal — see Removed capabilities.

### Event vocabulary: Realtime to GPT-Live

| Realtime | GPT-Live |
|---|---|
| `wss://…/v1/realtime?call_id=rtc_…` | `wss://…/v1/live/sessions/{id}/attach` |
| `conversation.item.input_audio_transcription.delta` / `.completed` | `session.input_transcript.delta` (deltas only — no completion event) |
| `response.output_audio_transcript.*` | `session.output_transcript.delta` |
| `conversation.item.create` (role: system) | `session.instructions.append` / `session.thinking.append` / `session.commentary.append` |
| `response.function_call_arguments.done` | `response.event` → `response.output_item.done` |
| `conversation.item.create` (`function_call_output`) | `response.item.create` (`function_call_output`) |
| `response.done.usage` → tokens | `session.usage.updated` → `{ seconds }` |
| `session.update { type: 'realtime', … }` | `session.update { delegation: { responses: … } }` |
| `response.cancel` + `output_audio_buffer.clear` | (no equivalent — advisory stop only) |

Other events the sideband handles: `session.started` / `session.updated`
(broadcast to admins), `session.delegation.created` (drives the admin "backend
thinking" indicator), `session.closed`, the three `*.appended`
acknowledgements, and `error`.

### The three append channels

| Event | Meaning | Used for |
|---|---|---|
| `session.instructions.append` | Trusted application instruction | Crisis steering, phase nudges, wrap-up, admin injections, stop-speaking |
| `session.thinking.append` | Quiet context the model may use but should not announce | Re-grounding summaries |
| `session.commentary.append` | A verified result the model should say aloud (it may paraphrase) | Exposed on the manager; **no callers yet** |

All three are capped at **500 tokens** by the API. The cap is enforced
client-side on characters (1600, at a deliberately pessimistic 3.2 chars/token)
rather than risking a rejected event — dropping a crisis steer because it ran
three words long is not an acceptable failure mode.

The matching `*.appended` events are **acknowledgements only**. They are
explicitly not proof that the model consumed the update, spoke it, or that the
participant heard anything.

Quiet context is not a privacy boundary. It can still influence later speech, so
anything appended via `session.thinking.append` must be factual and must contain
nothing the model can never be allowed to reveal.

---

## 4. Transcripts and turn assembly

This is the hardest difference, and it is safety-critical.

Realtime emitted a terminal `…input_audio_transcription.completed` event
carrying a whole user turn. That event was what the crisis pipeline scored.

GPT-Live emits only `session.input_transcript.delta` and
`session.output_transcript.delta`, each carrying:

```jsonc
{ delta: "…", start_ms: 12340, end_ms: 12980 }
```

There is **no turn-completed event and no item id**, because the model is full
duplex and both speakers can talk at once. The fragments are documented as not
being a complete user turn.

So turn assembly happens server-side, in `TranscriptAssembler`:

- Close a turn when **900 ms** passes with no new fragment for that speaker.
- Sort fragments by `start_ms`, not arrival order — late and out-of-order
  delivery is allowed, and concatenating in arrival order would scramble the
  sentence.
- Concatenate **exactly** as received: no trimming, no inserted spaces. The
  model's fragments already carry their own leading and trailing whitespace.
- A fragment that arrives after a flush starts a **new** turn rather than being
  dropped or retroactively merged, so every word stays in the record.
- The two speakers are tracked independently, because in a full-duplex
  conversation their turns legitimately overlap.
- Flush on `session.closed` and on socket close, so a final utterance — which in
  this application could be the most clinically important thing said — is never
  lost.

### Why 900 ms, and why the error is asymmetric

The gap is tuned conservatively in one specific direction. Flushing **late**
costs latency. Flushing **early** means the crisis assessor scores half a
sentence:

> "I've been thinking about" scores very differently from
> "I've been thinking about killing myself."

900 ms is long enough to ride through the pauses inside a sentence — which
matter a great deal in therapy, where people stop mid-thought — and short enough
that crisis scoring is not delayed past the model's own reply. If this value is
ever retuned, retune it upward, not downward, and record the change: it changes
what the crisis pipeline sees.

An assembled participant turn is persisted to `messages` (with
`metadata: { channel: 'live', start_ms, end_ms }`) and then pushed through
`runCrisisPipeline`. The pipeline runs **even if persistence failed** — a DB
outage must never silently disable crisis detection. The pipeline channel stays
`'realtime'`: that argument selects steering *delivery* (sideband vs. the chat
request/response cycle), and this is the sideband path.

Because fragments carry no item id, admin transcript rows are keyed by
`role` + turn using a stable synthetic id (`live-user` / `live-assistant`), which
keeps the existing admin client accumulator working without a protocol change.

---

## 5. Tool execution

Tools are called by the **delegated backend**, not by the voice model. Their
events arrive wrapped:

```jsonc
{ type: 'response.event', delegation_id: 'dlg_…', event: { type: 'response.output_item.done', item: { … } } }
```

Dispatch must be on the **inner** type while preserving the outer
`delegation_id`. Treating top-level `response.*` values as unwrapped Responses
events would silently drop every tool call.

Only two inner types matter:

- **`response.output_item.done`** with `item.type === 'function_call'` — the
  single source of truth for what needs a result. An arguments-done event alone
  cannot identify a call (it carries neither the function name nor the
  `call_id`), and the terminal lifecycle snapshot deliberately reports
  `output: []` — an empty terminal output list does **not** mean there are no
  pending calls.
- **`response.completed`** — backend token usage, recorded once per response id
  into `session_llm_usage` with purpose `live_delegation`. Metered response ids
  are remembered so a duplicate or replayed event cannot double-bill.

Returning a result is a two-step protocol, different from Realtime:

1. `response.item.create` with a `function_call_output` item appends the result.
2. `response.create` continues the backend response.

Appending a result does **not** continue the response automatically, and
`response.create` must not carry a Responses request body. The continuation is
sent only once every outstanding call for the session has a submitted result —
continuing early would run the backend while it is still waiting on a sibling
call.

Every call and result is written to `messages` as a `tool_call` /
`tool_response` pair, broadcast to the admin dashboard, and logged via
`insertToolInvocation`.

### Admin "trigger tool"

Realtime pinned `tool_choice` on the session, forced a response, and restored
`'auto'` on the next `response.done`. The Live equivalent pins `tool_choice` on
the **delegated backend** and appends an instruction nudging the voice model to
delegate.

The restore is a plain **45-second timer**, not an event-driven restore. GPT-Live
has no `response.done` for the spoken turn, so there is no reliable "the forced
turn finished" signal to hang it on. The window is deliberately generous, because
leaving `tool_choice` pinned would make the backend call the same tool for the
rest of the session.

---

## 6. Usage and billing

Two separate meters.

**Voice layer.** `$0.05 per minute`, billed **per second** and **not** rounded up
to the minute. `session.usage.updated` reports `usage.seconds` as a **cumulative
snapshot, never an increment** — summing snapshots would massively overcount a
long session. `live_usage` therefore holds exactly one row per session, and each
snapshot overwrites it (`GREATEST` of stored and incoming, so a late out-of-order
frame cannot move the number backwards). Rates live in `LIVE_RATES_PER_MINUTE`
and are a hand-maintained estimate for relative cost tracking; invoices are the
source of truth.

**Backend layer.** The delegated model is billed separately at normal token
rates. Those figures arrive in nested `response.completed` events and land in
`session_llm_usage` with purpose `live_delegation`, so the existing cost
dashboard picks them up with no special handling.

**Initialization charge.** `POST /v1/live/sessions` bills **15 seconds** of voice
duration at initialization, credited back against the running session. A
created-but-abandoned session therefore costs real money. This is why the route
runs every gate before calling OpenAI, why the one-active-session idempotency
check happens before the OpenAI call (a double-click must not bill two
initializations), and why the client asks for the microphone before starting the
handshake.

`peak_context_ratio` is also recorded, from `context_window.usage_ratio`.
GPT-Live swaps in a replacement voice engine past 90%, which drops older
history — worth knowing when a transcript looks like it lost the thread.

---

## 7. Session close, and why `session.closed` matters

Teardown order is prescribed:

1. Send `session.close`.
2. Keep reading the socket until `session.closed` arrives with the confirmed
   duration (5 s grace by default).
3. Only then tear down the transport.

Closing the transport immediately after the command can prevent the final event
from ever arriving. **A socket close alone does not establish finalization.** If
the connection drops before `session.closed`, the duration we hold is the last
in-flight snapshot and is formally unconfirmed; it is persisted anyway so the
session is not billed as zero, but `finalized` stays `false` and the cost
dashboard reports it as provisional (`unfinalized_sessions`).

`finalized` is sticky: once `session.closed` has confirmed the total, a stray
in-flight snapshot must not downgrade it back to provisional.

`session.closed` `reason` values: `close_requested`, `expired`, `content`,
`remote_hangup`, `connection_lost`.

On process shutdown the graceful wait is skipped (`graceMs: 0`) — waiting on
`session.closed` for every session would stall the shutdown.

### Reconnects

Sidebands are reattached after a deploy from
`therapy_sessions.openai_live_session_id` (active sessions created within the
last 2 hours, and only when `ai_model` is a Live model, so the Realtime and Live
namespaces never cross). A dropped socket retries up to 3 times with linear
backoff, but never for a session already ended — the live session id is gone.

Errors are surfaced three ways: `therapy_sessions.sideband_error`, the
`sideband:error` / `sideband:status-update` admin broadcasts, and server logs.
An HTTP upgrade rejection is captured with its status code and body, because a
bare "upgrade failed" is undiagnosable.

---

## 8. Voices

Twelve voices arrived with GPT-Live. The ten Realtime-era voices are retained:
the session guide names `marin` — a Realtime voice — as the GPT-Live default, so
the original set is still accepted. Keeping them matters for the study, since
participants already enrolled with a saved preference are not silently
reassigned a different voice mid-enrollment.

**Native GPT-Live voices**

| Voice | Style | Language / accent |
|---|---|---|
| Gleam | Bright and clear | English, North American |
| Meridian | Even and grounded | English, North American |
| Delta | Warm Southern lilt | English, Southern U.S. |
| Cinder | Low and unhurried | English, Southern U.S. |
| Vesper | Measured | English, British |
| Willow | Soft | English, Irish |
| Stone | Steady | English, Irish |
| Quartz | Crisp | English, Australian |
| Ripple | Relaxed | English, Australian |
| Beacon | Open | English, Filipino |
| Bossa | — | Brazilian Portuguese |
| Tempo | — | Brazilian Portuguese |

**Retained Realtime-era voices:** Marin (default), Cedar, Alloy, Ash, Ballad,
Coral, Echo, Sage, Shimmer, Verse.

Notes:

- `marin` is the default. Migration 099 moved `default_voice` from `cedar` to
  `marin`; this affects only participants with **no** saved preference. Existing
  `user_preferences` rows are untouched.
- Regional labels describe a voice's **speaking style**, not a guarantee of
  accent fidelity.
- Each voice is `natural` (derived from a human recording) or `generated`. This
  is recorded because voice naturalness plausibly affects therapeutic alliance —
  it is a variable an analyst may want.
- Bossa and Tempo are Brazilian Portuguese. `liveVoicesForLanguage()` filters the
  picker by language, because offering a Portuguese voice for an English session
  produces a noticeably wrong accent. If a language has no dedicated voices the
  full list is returned — a mismatched-but-present voice beats an empty picker.
- `resolveLiveVoice()` coerces an unrecognised voice to the default with a
  warning. Forwarding it would 400 the whole session creation, which the
  participant experiences as "the session won't start" with no explanation.
- The voice catalogue exists in **two** places on purpose: the TypeScript
  registry in `liveSessionConfig.ts` (what the server validates against, so a bad
  admin edit can never 400 a session mid-handshake) and `system_config.voices`
  (what the participant sees in the picker, admin-editable). Keep them in sync.

---

## 9. Capabilities removed by the migration

Three Realtime capabilities have no GPT-Live equivalent. Each was removed rather
than faked, because a fake would have been worse — code would keep calling
something that quietly did nothing.

### `hold_floor` (tool deleted)

It worked by setting `turn_detection: null`, taking the model out of
voice-activity turn-taking so it would not interrupt. GPT-Live owns turn-taking
natively and exposes **no VAD to disable**. There is no field to set, so the tool
was removed from the registry.

### Hard interrupt

Realtime could stop the model dead: `response.cancel` plus
`output_audio_buffer.clear` cancelled generation and discarded buffered audio.
GPT-Live has neither. `interrupt()` now routes to `requestStopSpeaking()`, which
appends an instruction asking the model to stop and yield.

This is **strictly weaker**. It cannot cancel generation and it cannot retract
audio the participant has already heard; the docs are explicit that a corrective
instruction cannot un-say something. The acknowledgement does not prove speech
stopped. Admin callers must treat it as a request, and anything needing a real
stop must also cut playback client-side.

### Out-of-band responses (re-grounding)

Mid-session re-grounding (ai-therapist-49) used a Realtime response with
`conversation: 'none'` so the generated summary never became a conversational
turn. GPT-Live has no out-of-band response mode.

It is reimplemented as: a **direct Responses call** over the transcript we
already persist (last 200 messages, `store: false`, one short paragraph, billed
to purpose `insights`), whose summary is fed back as quiet context via
`session.thinking.append`. The model can use it but will not read it aloud.

Re-grounding remains opt-in (`features.regrounding_enabled`, default off;
interval `features.regrounding_interval_minutes`, default 5).

### Also deleted

`src/server/utils/transcriptionConfig.ts` and `getTranscriptionModel` are gone.
GPT-Live transcribes both sides internally and emits
`session.*_transcript.delta`; there is no `audio.input.transcription` block to
configure, and this codebase has no offline `/audio/transcriptions` path either,
so those helpers had no readers left. The `transcription_model` and
`transcription_context` rows in `system_config` are left in place (marked
`_deprecated` by migration 099) so migration 097's history stays coherent and a
rollback has something to restore. They are inert.

### Behaviour changes inside preserved method names

| Method | What changed |
|---|---|
| `injectMessage(sessionId, role, text, respond)` | `role` is ignored — there is no conversation item list and no way to speak *as* the participant, so the admin "inject as user" control now steers the model instead of impersonating them. `respond` is ignored. |
| `tryInject(…, respond)` | Same: `respond` is accepted for signature compatibility and ignored. GPT-Live decides for itself when to speak. |
| `updateSession(updates)` | Routed to the **backend** config. GPT-Live freezes the startup fields (model, the voice model's own instructions, audio, input) and rejects them as updates; the only mutable surface is `session.delegation.responses`. An `instructions` update therefore lands on the backend prompt — which is where the clinical content lives anyway. |
| `createResponse(response?)` | Per-response overrides are not supported and are warned-and-dropped. `response.create` creates or continues work on the session's **configured** backend; a Responses request body, a model override, or a `delegation_id` are all forbidden. |
| `interrupt()` | Advisory only (above). |

---

## 10. Configuration knobs

| Key | Type | Meaning |
|---|---|---|
| `system_config.ai_model` | `{ "model": "gpt-live-1" }` | The **voice** model. `isLiveModel()` is the only switch between the Live and Realtime paths: a `gpt-live-*` id routes to Live. Anything else is rejected by `POST /api/live/session` with a loud server-side error and a `409 live_not_active` to the client, rather than being forwarded to OpenAI as an opaque 400 mid-handshake. `gpt-live-transcribe` is deliberately excluded — it is a transcription model, not a full-duplex voice model. |
| `system_config.live_backend_model` | `"gpt-5.6-terra"` | The delegated reasoning backend. This — not `ai_model` — determines clinical response quality. Admin-editable so the study team can pin it without a redeploy. Falls back to `LIVE_DEFAULT_BACKEND_MODEL`. |
| `system_config.voices` | `{ voices: [...], default_voice }` | What the participant picker shows. Validated against the TypeScript registry server-side. |
| `system_config.features.phase_guidance_enabled` | boolean | Wall-clock consolidation / wind-down nudges. Default on. |
| `system_config.features.regrounding_enabled` | boolean | Mid-session re-grounding. Default **off**. |
| `system_config.features.regrounding_interval_minutes` | number | Default 5. |
| `system_config.session_limits` | object | `max_duration_minutes` drives both the phase nudges and auto-termination. |
| `SIDEBAND_ENABLED` (env) | `'false'` disables | Records the session id only; no server-side tools, transcripts, usage or crisis steering. Diagnostic use only. |

`store: false` is hard-coded in the session config. Storage is what enables
forking and recording download, neither of which we use, and the Phase 1 consent
does not cover OpenAI-side retention of session audio.

---

## 11. Auto-termination

Unchanged in behaviour, extracted to `src/server/utils/sessionAutoTerminate.ts`
so the steering mechanism is injected as a callback and the two voice paths
cannot drift apart on something safety- and data-relevant.

- **T-60 s:** a pacing nudge, so the model learns about the time before the hard
  limit and can land its closing.
- **At the limit (phase 1):** the model is asked to give a brief warm closing and
  call `end_session` itself. This reaches the client over the WebRTC data channel
  (reliable) and closes things through the normal user path with the recording
  intact.
- **+75 s (phase 2):** hard server-side end as a backstop — status update,
  sideband teardown, redaction, recorder finalize, insights, auto-eval.

The two-phase design exists because the participant's Socket.io channel is
unreliable through the tunnel: a purely server-side end is invisible to them,
their WebRTC conversation keeps going, and the recording ends up covering only
the first N minutes of a much longer conversation.
