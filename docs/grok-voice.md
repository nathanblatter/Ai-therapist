# Grok Voice backend (xAI, `grok-voice-latest`)

A second voice backend that runs **alongside** GPT-Live (`docs/gpt-live.md`).
Nothing is removed; the study picks one per deployment with a single admin
setting, and every new session follows the current value:

| `system_config.ai_model` | Backend | Transport |
|---|---|---|
| `gpt-live-1` (any `gpt-live-*`) | OpenAI GPT-Live | browser WebRTC to OpenAI + server sideband attach |
| `grok-voice-latest` (any `grok-voice-*`) | xAI Grok Voice | browser WebSocket to **our server**, server WebSocket to xAI |

Set it from Admin → System Config → AI Model (both presets are listed) or
directly in `system_config`. Roll back by setting it back. No redeploy. The
server needs `XAI_API_KEY` in `.env` before the switch; without it, starts
fail with a loud 409 rather than opening an unauthenticated socket.

Source of truth:

| Concern | File |
|---|---|
| Model switch, voice roster, session config, opening line | `src/server/utils/grokVoiceConfig.ts` |
| Session creation route (gates, DB rows, pending registration) | `src/server/routes/public/grokSession.routes.ts` |
| WebSocket upgrade auth on `/api/grok/voice/:id` | `src/server/utils/grokVoiceUpgrade.ts` |
| Proxy: audio relay, transcripts, crisis join point, tools, usage, steering | `src/server/services/grokVoiceManager.service.ts` |
| Delegation from the GPT-Live sideband's control surface | `src/server/services/sidebandManager.service.ts` (`VoiceSidebandDelegate`) |
| Browser ↔ server wire protocol | `src/shared/grokVoiceProtocol.ts` |
| Browser audio (worklet capture, scheduled playback) | `src/client/main/lib/grokVoiceClient.ts` |
| Client integration (`startGrokSession` / `stopGrokSession`) | `src/client/main/components/App.tsx` |
| Per-minute billing | `src/server/db/liveUsage.queries.ts` |
| Shared phase-guidance schedule | `src/server/utils/phaseGuidance.ts` |

---

## 1. Why a proxy

xAI's Voice Agent API is an OpenAI-Realtime-compatible **WebSocket only**:
`wss://api.x.ai/v1/realtime?model=…`. There is no WebRTC leg for the browser
to own and, crucially, no "attach" endpoint through which a server could
observe a browser-owned session — the thing GPT-Live gave us and that the
whole safety architecture depends on. A browser connecting to xAI directly
(xAI does offer ephemeral client secrets) would produce a voice session the
server never sees: no transcript persistence, no crisis scoring, no steering,
no server-side tools.

So the server sits in the middle:

```
browser ──PCM16 frames + JSON──▶ our server ──xAI realtime events──▶ api.x.ai
        ◀──PCM16 frames + JSON──            ◀──────────────────────
```

Every participant utterance and every model event passes through
`GrokVoiceManager`, which is what makes the path monitorable. Latency cost is
one extra hop through the app server; bandwidth is ~48 KB/s of PCM each way per
session.

Two consequences worth knowing:

- **The browser cannot steer the model.** The client → server protocol has no
  "inject" message at all. Every steer — the opening line, crisis guidance,
  phase nudges, admin messages, tool outcomes — is authored and delivered
  server-side. This closes the open item GPT-Live leaves open, where the
  browser owns a data channel that accepts `session.instructions.append`. The
  client's `sendInvisiblePrompt` is a documented no-op under Grok.
- **Typed text** during a voice session goes to `POST /api/grok/session/:id/text`,
  which injects it as a participant (user-role) turn and forces a reply. It is
  the one client → server message that reaches the model, and it can only ever
  speak AS the participant, never instruct.
- **No credential reaches the browser.** The session route returns a session
  id and the proxy path; the API key lives in the process only.

## 2. One model, not two

GPT-Live splits the work between a voice model and a delegated reasoning
backend. Grok Voice is a single speech-to-speech model with native function
calling, so the session gets the **whole clinical prompt** and the **tool
schemas** directly, the way the pre-GPT-Live Realtime path did:

```jsonc
// session.update, built by buildGrokSessionConfig()
{
  instructions: <voice header> + <clinical prompt>,   // same clinical string GPT-Live's backend runs
  voice: 'eve',
  turn_detection: { type: 'server_vad' },
  audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { language_hint } },
           output: { format: { type: 'audio/pcm', rate: 24000 } } },
  tools: toRealtimeTools(registry),                    // flat OpenAI Realtime shape
  tool_choice: 'auto',
}
```

The clinical prompt (`getSystemPrompt` + tool guidance + memory + check-in) is
assembled by the exact same code the GPT-Live route uses, so the two backends
stay clinically identical as study conditions. `session_configurations.
live_backend_model` is NULL for Grok sessions — there is no second model to pin.

The voice header is short and covers only speaking behaviour plus one line
telling the model that mid-conversation system messages are trusted guidance
it must follow but never read aloud.

## 3. Session lifecycle

```
POST /api/grok/session            gates → DB rows → registerPending() → 201 { session_id, ws_path }
WS   /api/grok/voice/<session_id> cookie auth + ownership → attachClient()
                                  → dial xAI → session.update → session.created/updated
                                  → 'ready' to browser → opening line → audio flows
```

1. **Create.** `POST /api/grok/session` runs the same gates in the same order
   as the GPT-Live route (consent, quiet hours, study status, rate limits,
   one-active-session), creates the therapy session and config rows, and
   registers the assembled session config with the manager as *pending*.
   Session ids are `grok_<uuid>` — a namespace distinct from OpenAI's
   `live_…`, so the sideband re-attach sweep never confuses them.
   **Nothing is dialled yet.** A start that dies client-side (mic permission,
   closed tab) never opens a billable upstream session; the pending entry
   expires after 45 s and the session row is ended.
2. **Attach.** The browser opens the WebSocket. `grokVoiceUpgrade.ts` loads
   the express-session from the cookie (same middleware instance as HTTP and
   Socket.io) and applies `canAccessSession` — cookie `ownedSessions` for
   anonymous participants, `user_id` for logged-in ones. Only then does the
   manager dial xAI, send `session.update`, and wait for `session.updated`.
3. **Ready.** The browser gets `{ type: 'ready', model }`; the resolved model
   id from `session.created` (e.g. `grok-voice-think-fast-2.0` for the
   `grok-voice-latest` alias) is pinned to `session_configurations.ai_model`
   (ai-therapist-61). The server injects the opening line as a system item
   plus `response.create`, so the assistant speaks first exactly as it does
   on GPT-Live. `therapy_sessions.sideband_connected` is set: a ready Grok
   session is by construction a monitored one.
4. **End.** The participant's End button sends `{ type: 'end' }` (upstream
   closes immediately, billing stops) and then the normal `POST
   /api/sessions/:id/end`, which calls `sidebandManager.disconnect()` → the
   delegate → `GrokVoiceManager.disconnect()`. Auto-termination, the
   `end_session` tool backstop, admin end and the abandoned-session sweeper all
   arrive through that same call.

### Failure modes

| What | Behaviour |
|---|---|
| Browser never attaches | pending expires (45 s) → `serverEndSession(reason: client_never_connected)` |
| Browser socket drops without `end` | upstream closed at once (stop billing); session ended after 15 s unless `POST /end` lands first |
| xAI closes the socket (non-1000) | usage finalised as `connection_lost`; browser told `closed: upstream_lost`; `serverEndSession` with a participant-facing message. Fails **closed**: no upstream means no monitoring |
| xAI `error` event | logged to `sideband_error`, relayed to the browser and the admin room; not treated as terminal |
| Second browser for the same session | refused (4409). One participant, one socket |

xAI offers a server-side `resumption` cache (30 min) that could survive a
network blip without losing the conversation. Not wired yet — see §9.

## 4. Transcripts and the crisis join point

This is materially simpler than GPT-Live. Verified against the live API:

- Participant speech arrives **whole**, as
  `conversation.item.input_audio_transcription.completed` with an `item_id`
  and the full utterance. There is no fragment assembly, no gap timer, and no
  risk of scoring half a sentence. (xAI's cumulative
  `…transcription.updated` extension, when present, is relayed to the browser
  as a live caption only.)
- Assistant speech streams as `response.output_audio_transcript.delta` and
  finishes with `.done` carrying the full transcript. Barge-in
  (`input_audio_buffer.speech_started`) closes a half-spoken turn with
  whatever was said, so the record reflects what the participant actually
  heard.

Each completed participant turn is inserted as `message_type='voice'`
(metadata `channel: 'grok'`) and then passed to `runCrisisPipeline(turn,
'realtime')` — the same function, same channel, as the GPT-Live sideband.
Detection, flagging, paging, minor safeguard and steering delivery are reused
unchanged. As on GPT-Live, the pipeline runs even when the DB insert fails.

Admin Live Monitoring needs no changes: the proxy emits the same
`sideband:transcript` / `sideband:tool-call` / `sideband:connected` /
`session:activity` events with the same shapes.

## 5. Steering: how the control surface reaches Grok

Every existing call site — `crisisIntervention`, `crisisPipeline`,
`sessionLifecycle`, `toolRegistry`'s adaptive prompt, `sessionAutoTerminate`,
the admin sideband routes, `index.ts` — imports `sidebandManager`. Rather than
rewrite ~20 call sites and their test mocks, `SidebandManager` gained a
delegate registry: `GrokVoiceManager` registers itself at startup and each
public control method forwards to it for the sessions it `owns()`. In unit
tests nothing registers and GPT-Live behaviour is exactly as before.

| Call | GPT-Live | Grok |
|---|---|---|
| `tryInject` / `injectMessage(role, text, respond)` | `session.instructions.append` (role ignored) | `conversation.item.create` with that **role**, plus `response.create` when `respond` |
| `updateSession({ instructions })` | routed to the delegated backend prompt | `session.update` on the live prompt — Grok accepts it mid-session |
| `interrupt()` | advisory "stop speaking" append | real `response.cancel` + `clear_audio` to the browser |
| `createResponse(overrides)` | overrides ignored | `response.create` with per-response `instructions` etc. |
| `triggerTool(name, args)` | pin backend `tool_choice`, timer reset | pin `tool_choice`, nudge, restored to `auto` on the next `response.done` |
| `disconnect()` | `session.close`, await `session.closed` | close both sockets, finalise usage |

Note the admin "inject as user" control is honest again on Grok: a user-role
item really does speak as the participant, which GPT-Live could not do.

## 6. Tools

`response.function_call_arguments.done` carries name, call id and arguments.
The manager executes the tool through `toolRegistry.executeTool(name, args,
{ sessionId, channel: 'realtime' })` — the same handlers, so `end_session`'s
server-side backstop, scale administration, memory, RAG and the rest all
work — and returns a `function_call_output` item followed by one
`response.create`, only once no calls are outstanding (xAI is explicit about
that ordering). Tool call/response rows and `tool_invocations` are recorded
as on GPT-Live.

The browser receives a UI-only `{ type: 'tool_call', callId, name, args }` so
it can open the matching overlay (worksheet, scale, resources…). It never
submits a result; the model gets exactly one per call.

## 7. Usage and billing

Every `response.done` carries per-response token counts **and** a cumulative
`usage.billable_audio_seconds` for the session (observed 7 → 9 → 14 → 16
across four responses in the probe). Two rules follow:

- `billable_audio_seconds` is **assigned**, never summed, into `live_usage`
  (one row per session, latest snapshot wins, `finalized` on close). The cost
  dashboard's per-minute pricing picks it up through `LIVE_RATES_PER_MINUTE`
  — $0.08/min as published 2026-09, keyed by both the alias and the resolved
  release id.
- Token counts go to `session_llm_usage` with `purpose='grok_voice'` for the
  research record and are priced at **zero** there (`estimateCostUsd`), so the
  session is not double-counted. Migration 104 adds the value to the column's
  CHECK constraint; without it the inserts fail silently (SQLSTATE 23514).

xAI spend does not appear in the OpenAI organisation-costs feed the admin
cost dashboard treats as ground truth; for Grok the `live_usage` estimate is
the only figure. Invoices at console.x.ai are the source of truth.

## 7a. Turn-taking feel, and the knobs

Grok Voice is a **turn-based** model: it listens, detects the end of speech,
then replies. It cannot overlap or backchannel the way GPT-Live's full-duplex
model does, so a Grok conversation always has a walkie-talkie cadence to some
degree. What can be tuned is how small the gap feels. Admin → System Config →
"Grok Voice Turn-Taking" (stored as `system_config.grok_voice`, read fresh at
every session start, no cache):

| Knob | Default | Effect |
|---|---|---|
| `vad.silence_duration_ms` | 500 | Silence that ends a turn. Lower = snappier; too low splits pauses into separate turns (the duplicated-turn artefact) |
| `vad.threshold` | 0.85 | Speech sensitivity, 0.1–0.9 |
| `vad.prefix_padding_ms` | 333 | Audio kept from before speech was detected |
| `reasoning_effort` | `none` | `none` = fastest first word; `high` = xAI default, slower |
| `speed` | 1.0 | Playback speed, 0.7–1.5 |

Barge-in: on `input_audio_buffer.speech_started` the proxy tells the browser
to flush playback **and** sends `response.cancel` upstream when a reply is in
flight, so the assistant stops rather than finishing over the participant.

Every participant turn's latency is measured (end of speech → first audio
byte, and → `response.done`) into `turn_latency` with `channel='realtime'`,
the same table the earlier voice paths used, so backends and knob settings
can be compared with numbers rather than impressions.

## 7b. Refusal loops (xAI moderation)

xAI moderates on its side. When it trips, the model answers with a canned
`I can't help with that request` and then answers *everything* that way — in
the stage session of 2026-09-23 a participant got five identical refusals in a
row, including to "so is the session just over?". The string is not ours, so
no amount of clinical prompt ("Declining gracefully") can override it: the
session is bricked unless the proxy notices and breaks the loop.

`utils/grokRefusalGuard.ts` holds the detector (pure, unit-tested); the
manager owns delivery. A completed assistant turn counts toward a streak when
it is **short** (≤ `maxChars`) and either matches a configured refusal pattern
or repeats the previous short turn near verbatim; any real reply resets the
streak, so a single boundary is never treated as a loop. Turns cut short by
barge-in do not count.

| Streak | What happens |
|---|---|
| `steerAfter` (2) | A system item is injected — acknowledge, one-sentence boundary, redirect to how the participant is feeling, name resources — with `response.create`, so the participant is not left in silence |
| `recoverAfter` (4) | A **server-authored** line goes out on the transcript channel (there is no server-side TTS on this socket), is persisted as an assistant row with `server_authored: true`, logs an `intervention_actions` row of type `voice_refusal_recovery`, and re-steers without forcing speech. The counter resets, so a longer loop escalates again from the steer rather than repeating our line every turn |

Settings live in `system_config.grok_refusal_guard` (`enabled`, `patterns`,
`maxChars`, `steerAfter`, `recoverAfter`), read fresh at session start like
the turn-taking knobs. It is a separate key because the admin turn-taking form
PUTs `grok_voice` whole. Patterns are normalized (lowercase, apostrophes and
punctuation dropped) on both sides, so they can be typed naturally.

Crisis detection is untouched by any of this: participant transcripts still
run through `runCrisisPipeline` on every turn, refusal loop or not.

## 8. Browser audio

`GrokVoiceClient` runs an `AudioContext` at 24 kHz — the browser resamples
the microphone for us and plays the 24 kHz PCM buffers natively, so no
resampling code exists on either side.

- **Capture:** an `AudioWorklet` built from an inline module (no extra build
  artefact; CSP allows `blob:` workers) posts ~100 ms Int16 frames, sent as
  binary WebSocket frames. Frames are skipped while the mic track is
  disabled, so the existing mic toggle in `SessionControls` (which flips
  `track.enabled`) works unchanged, and the time-limit wrap-up also calls
  `muteMic()`. Older engines fall back to `ScriptProcessorNode`.
- **Playback:** each incoming chunk is scheduled back-to-back on the context
  clock (gapless, ~60 ms lead after a pause). `speech_started` and
  `clear_audio` flush the queue instantly, so barge-in feels immediate.
- **Orb and recording:** assistant audio is also routed into a
  `MediaStreamAudioDestinationNode`; that stream feeds `VoiceOrb` and the
  consent-gated recording tee (`startMixedTee` + HTTP uploader) exactly like
  the WebRTC remote track did. The recording path, participant track,
  acoustic features and the admin live-listen relay are all unchanged.

Proxying is more sensitive to the WebSocket path through reverse proxies than
WebRTC was. Caddy (`Caddyfile.prod`) proxies upgrades by default and Cloudflare
tunnels support them; the participant Socket.io flakiness noted in
`participantSocket.ts` (ai-therapist-18) is the thing to watch on the demo
box. The voice socket is same-origin, covered by CSP `connect-src 'self'`.

## 9. Voices

xAI's roster (`GET /v1/tts/voices`, 28 voices, all multilingual) lives in
`GROK_VOICES`. `/api/config/voices` serves it whenever `ai_model` is a Grok
model, and the GPT-Live catalogue in `system_config.voices` otherwise — so
the picker follows the same single switch. Every Grok voice has a bundled
preview clip in `assets/audio/voices/<voice>.mp3` (generated with xAI TTS,
64 kbps mono). A saved preference from the other backend (e.g. `marin`) falls
back to `eve` with a warning rather than failing the session.

## 10. Not done yet

- **Resumption.** xAI can cache the session for 30 min (`resumption.enabled`)
  so a client reconnect could continue the conversation. Today any socket
  loss ends the session (fail closed).
- **Red-team voice suite.** `src/redteam/voiceClient.ts` still speaks the
  OpenAI Realtime protocol directly and is not wired to either backend
  (`docs/redteam.md`). Pointing it at the proxy path would exercise Grok
  end-to-end.
- **Content-filter recovery.** The GPT-Live recovery flow (incident
  2026-09-11) is OpenAI-specific; no equivalent termination class has been
  observed on xAI, so the Grok path has no recovery start.
- **Multi-process.** The proxy is in-memory, like the sideband. During a
  blue-green window a Grok session lives on the container that accepted its
  socket; a container death ends the session (fail closed), it is not
  re-attached.

## 11. Verified against the live API (2026-09-20)

Probe transcript summary, run with a real key from a Node script:
`session.created` (resolved model reported) → `session.updated` echoing our
config → paced 24 kHz TTS audio through `input_audio_buffer.append` →
`speech_started` / `speech_stopped` / `committed` → `…transcription.completed`
with the exact utterance → streamed assistant transcript + 42 audio deltas →
`response.done` with tokens and cumulative billable seconds → a system-role
item + `response.create` made the model speak → a second utterance triggered
`find_worksheet` → `function_call_output` + `response.create` produced the
spoken result. Unit tests reproduce this sequence with fake sockets
(`grokVoiceManager.service.test.ts`).
