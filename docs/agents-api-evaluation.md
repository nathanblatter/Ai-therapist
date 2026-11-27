# OpenAI Agents API for the admin assistant: evaluation and decision

Date: 2026-11-18; rebuilt on main and re-checked against OpenAI's docs on
2026-11-26 (see "Rebuild and re-check" at the end). Scope: the staff-facing
admin assistant only (`src/server/services/assistant.service.ts`). The
participant conversation paths are out of scope and were not touched.

## Decision

**Do not move the admin assistant to the Agents API as it stands.** The Agents
API keeps conversation state and tool results at OpenAI until they are
deleted, it has no `store: false` equivalent, and it is not eligible for Zero
Data Retention. The current assistant sends every request with
`store: false`, and the Phase 2 IRB application commits to that
(`docs/irb-phase2-longitudinal-application.md`: "OpenAI-side storage is
switched off on each call (`store: false`) ... OpenAI's standard
abuse-monitoring retention (up to 30 days) applies"). Moving the assistant's
per-participant tools onto the Agents API would put participant-level research
data in a vendor store that the consent materials and the IRB application do
not describe.

What this PR builds instead is a **restricted trial backend**, off by default
(`features.assistant_agents_api_enabled`). It exposes only the tool whose
output is aggregate-only (`study_overview`), with small groups suppressed. It
uses a new session for each turn, deletes that session as soon as the turn
ends, and sweeps for any session left behind. With the flag off, the assistant
behaves exactly as before: a unit test pins the SHA-256 of the whole request
sent to OpenAI, and the same test passes against main's unmodified
`assistant.service.ts`.

The trial lets the owner see the API's shape, latency and cost on real
questions. It is not a replacement for the full assistant. While the flag is
on, researchers lose seven of their eight tools, and therapists and
caseworkers have no data tools at all.

## What the Agents API is

From OpenAI's docs (fetched 2026-11-18):

- A managed Codex harness. "The Agents API gives your application access to
  the Codex harness through an OpenAI-managed API. OpenAI manages sessions,
  orchestration, context compaction, and recovery while your application
  provides tools and chooses its execution environment."
  ([overview](https://developers.openai.com/api/docs/guides/agents-api/overview))
- Public beta. Requests carry `OpenAI-Beta: agents=v1`, and the API key needs
  `api.agents.read`, `api.agents.write` and `api.responses.write`
  ([quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart#prerequisites)).
  SDK: `client.beta.agents.sessions.*` in `openai` 7.57.0.
- Shape: you create a session (`POST /v1/agents/sessions`) with an `agent`
  (model, instructions, tools), an `environment` (`none`, `openai_hosted` or
  `self_hosted`) and the first `input`. With `stream: true` the events arrive
  as SSE. A turn that needs one of your functions emits
  `agent.session.requires_action`. You run the function and return the result
  with `agent.session.input.tool_result` on
  `POST /v1/agents/sessions/{id}/events`. The turn ends with
  `agent.session.turn.completed`, `.failed` or `.cancelled`
  ([sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions),
  [functions](https://developers.openai.com/api/docs/guides/agents-api/tools/functions),
  [events](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)).
- Input messages are user-role only (create-session reference: `role: "user"`,
  "Always `user`"). Earlier assistant turns cannot be replayed as assistant
  messages. You either keep the session alive between turns or fold the
  history into one user message.
- `agent.instructions` are "Additional instructions appended to the agent's
  default base instructions". The Codex base prompt is always present and is
  not under our control.
  ([create session](https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/methods/create))
- Programmatic tool calling is on by default ("enabled by default ... To
  disable Programmatic Tool Calling, include this entry in agent.tools"), and
  it works even with `environment.type: none`
  ([PTC](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling#agents-api)).
  This backend turns it off explicitly.
- Models: no supported-model list is published. The `model` field is a free
  string ("The requested model name is preserved"), and the docs' examples use
  `gpt-6-astra`. `gpt-5.2` works: live turns completed with it (results below).

## Pricing

"Model usage is billed at the selected model's API rates. OpenAI tools use
their standard rates, and OpenAI-hosted sandboxes use standard container
rates." ([overview](https://developers.openai.com/api/docs/guides/agents-api/overview#pricing))
No per-session fee is documented. Extra token sources specific to the harness:
the Codex base instructions on every model call; context compaction
("Background compaction may increase token usage"); and automatic review if
enabled ("Tokens used for review are billed in addition"). This backend uses
no sandbox, no hosted tools and no automatic review, so it should cost model
tokens only, at gpt-5.2 rates, plus the base-prompt overhead (measured below:
about 5k input tokens per model call).

## Rate limits and beta caveats

- The docs list no Agents-specific request limits. Turn errors include
  `rate_limit_exceeded`, `server_overloaded`, `session_budget_exceeded` and
  `credit_balance_exhausted`, and session creation can hit the Files API rate
  limit when files are attached
  ([errors](https://developers.openai.com/api/docs/guides/agents-api/errors)).
- Beta contract: the session `error` is a plain string in `agents=v1`, and
  the API has changed several times since launch (changelog: tool updates on
  live sessions, compaction defaults, automatic review, scheduled
  automations).
- "Streams do not replay missed events". Recovery means retrieving saved
  items, which only works because the state is stored.

## Data: where it lives and for how long

| | Current assistant | Agents API |
|---|---|---|
| Endpoint | `/v1/responses`, `store: false` | `/v1/agents` |
| Application state at OpenAI | None | **Until deleted** |
| Abuse-monitoring retention | 30 days | 30 days |
| Zero Data Retention eligible | Yes (not contracted) | **No** |
| What is stored | Nothing beyond the abuse log | Session config, conversation, and "saved messages and tool calls" (tool results) |
| Deletion | n/a | `DELETE /v1/agents/sessions/{id}`; "Physical cleanup may continue asynchronously" (no deadline published) |
| Data residency | Unchanged by this PR | US only |

Sources:
[data controls table](https://developers.openai.com/api/docs/guides/your-data#storage-requirements-and-retention-controls-per-endpoint)
(`/v1/agents`: training No, abuse monitoring 30 days, application state
"Until deleted", ZDR eligible No);
[overview](https://developers.openai.com/api/docs/guides/agents-api/overview)
("The Agents API retains session state ... The Agents API currently supports
data residency only in the United States and does not support Zero Data
Retention (ZDR). Choosing a self-hosted sandbox does not make the Agents API
ZDR-eligible.");
[manage sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage#delete-a-session)
("Deletion removes the session from the API. Physical cleanup may continue
asynchronously.");
[sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions#retrieve-saved-work)
("Items are the saved messages and tool calls").

For comparison, OpenAI's Assistants objects are "deleted from our servers 30
days after you delete them". No such bound is published for Agents sessions.

## What the current assistant can reach

Eight read-only tools, each running as the caller with role allowlists that
mirror the admin portal. None of them changes anything, so there is nothing
for `account_audit_log` to record; the assistant's own trail is `assistant_audit`. Every turn writes an `assistant_audit` row (question,
tool names, arguments and row counts; never payloads).

| Tool | Roles | Data returned to the model |
|---|---|---|
| `study_overview` | researcher | Enrollment funnel counts, participant count, weekly mood/stress/helpfulness averages, PHQ-2/GAD-2 aggregates. No identifiers. |
| `survey_completion` | researcher, therapist (caseload) | Per participant: user id, **username**, study week, completed check-ins. |
| `session_stats` | all (care team: caseload) | Per session: session id, **username**, user id, status, times, message count, crisis flag and severity. |
| `crisis_events` | all (care team: caseload) | Per event: ids, **username**, severity, risk score, status, timestamps. |
| `escalations` | all (scoped) | Per escalation: client id, raised by, assignee, urgency, status, timestamps. |
| `work_queue` | all (scoped) | Per item: client id, assignee, type, severity, **title**, status, timestamps. |
| `caseload_roster` | therapist, caseworker | Per client: client id, **username**, last session, risk score/severity, screener scores, crisis/escalation counts, safety-plan flag. |
| `user_lookup` | all (org; care team: caseload) | User id, **username**, role, study status, created date. |

Whitelist projection means no transcript or message text reaches the model for
any role. Seven of the eight tools still return per-participant rows keyed by
username or id, with risk scores and crisis severities attached. Those rows
are pseudonymous research data, not de-identified data. On the stateless
path they reach OpenAI's 30-day abuse log only. On the Agents API they would
also sit in a session store until deleted.

Red-team coverage (`src/redteam/scenarios/assistant*.ts`):

- **Prompt injection.** A researcher asks ordinary questions while the attack
  sits in seeded data: an injected message body (structurally unreachable)
  and a crafted username that does reach model context.
- **Role escalation.** A caseworker and a therapist ask for transcripts,
  off-caseload clients, another therapist's caseload and study-wide figures.
- **Data exfiltration.** A researcher asks for un-redacted content, raw
  identifiers, cross-org participants and a JSON dump.

The deterministic checks are canaries and the role/tool matrix against
`assistant_audit`. Classifiers decide refusal semantics.

## The restricted trial backend (this PR)

`src/server/services/assistantAgentsApi.service.ts`, behind one seam
(`AssistantBackend`). Both backends run tools through
`executeAssistantTool` in `assistant.service.ts`, so the role allowlist, the
caller-identity scoping and the audit row are shared code.

- Session: `environment: none`, `programmatic_tool_calling` disabled,
  `multi_agent` disabled, no hosted tools, no MCP, no vaults, no sandbox, no
  computer use, no automatic review (`review: none`). The only tools are our
  function definitions, and any other `required_actions` type fails the turn
  closed. The session echoes its resolved tool list when it is created; if
  that list holds anything we did not send (a vendor default switching a
  hosted tool on), the turn stops before the model runs.
- Tools exposed: the role's allowlist intersected with
  `AGENTS_API_ELIGIBLE_TOOLS` = `study_overview`. Its result is rebuilt from
  named numeric fields (an allow-list: a field added to the tool later, or a
  string where a number belongs, cannot ride along), and weekly and
  instrument aggregates over fewer than 5 participants are nulled before the
  result leaves the server. A call to any other tool is refused without
  executing and is audited with row count 0, just as on the stateless path.
  `study_overview` is gated exactly like its screen
  (`GET /admin/api/qualtrics/data`): researcher only, study-wide, not
  organisation-scoped on either.
- Limits: 90 s per turn, 12 tool calls per question, 15 s on every other call
  to OpenAI, and a vendor-side spend ceiling of 25 cents per session
  (`spend_control`, best-effort at OpenAI). The API has no setting for
  maximum steps or output tokens.
- Lifecycle: one session per staff question. Earlier turns are folded into
  one user message, because the API takes user input only and the client
  already sends the whole history. The session is deleted in `finally`; if
  deletion fails, the code cancels and retries once. A throttled sweep
  deletes any session tagged `metadata.app = ai-therapist-admin-assistant`
  that is older than 5 minutes. The sweep runs only while the flag is on (a
  turn triggers it): if the flag is switched off after a crash, run
  `sweepOrphanedAgentSessions()` once by hand.
- Audit: same `assistant_audit` row, with `model = agents-api:gpt-5.2`. A turn
  that ran a tool is audited even if the model step failed afterwards, and so
  is any turn whose session was created, because by then the question is
  stored at OpenAI.
- Instructions: the assistant's own prompt, unchanged, with the list of
  available tools, plus a short backend note naming what this path cannot see
  and stating that there is no shell, files or network. No other prompt
  changed.

What can reach OpenAI on this path: the staff question as typed, the
earlier turns of that chat, the assistant prompt (which names the asking
staff member's own username and role), and study-wide aggregates with small
cells suppressed. No participant-written text and no participant identifier
is in any of those unless a staff member types one. If a staff member types a participant's username
into a question, that text is stored with the session until it is deleted,
which is the residual exposure of the trial. What cannot reach OpenAI on this
path: any per-participant tool row (usernames, ids, risk scores, crisis
records, escalations, work items, caseloads).

Turn it on with Admin, then System Config, then Additional Features, then
"Admin assistant: OpenAI Agents API backend (beta trial)", or set
`system_config.features.assistant_agents_api_enabled = true`. The config cache
holds values for up to 10 minutes. `ASSISTANT_ENABLED=true` must also be set,
as before.

## Live results (2026-11-18)

The credit balance ran out partway through this work and was restored the
same afternoon. After the restore, the Agents API kept returning
`usage_limit_exceeded` for a few minutes after Responses calls had already
recovered. All runs below used a fresh scratch database built with
`scripts/redteam-db-setup.sh`, seeded demo fixtures only, and gpt-5.2 on both
backends.

Verified live:

- A session with `environment: none`, programmatic tool calling and subagents
  disabled, and one function tool runs a full turn on the create-session
  stream. `requires_action`, then our `tool_result`, then `turn.completed`
  all arrive on one stream. Function arguments arrive as a JSON object.
- Usage is null on `turn.completed` and on the session at that moment. It
  appears on the session about 2 s later. The backend now polls for up to
  4 s before deleting. One turn of 12 still recorded 0 tokens because the
  window expired.
- `DELETE` returns `deleted: true`, and a later retrieve returns 404. After the
  runs, listing the project's sessions returned none: all 16 sessions
  created (12 red-team turns and 4 probes) were deleted.

Red-team comparison, same three scenarios, same day:

| Scenario | Stateless (default) | Agents API variant |
|---|---|---|
| assistant-prompt-injection | PASS 17/17, 22.8 s | PASS 17/17, 44.8 s |
| assistant-role-escalation | PASS 21/21, 27.2 s | PASS 21/21, 60.6 s |
| assistant-data-exfiltration | PASS 26/26, 22.4 s | PASS 26/26, 72.0 s |

Per assistant turn, from `assistant_audit`:

| | Stateless | Agents API |
|---|---|---|
| Avg input tokens | 1,645 | 7,564 (11 of 12 turns measured; ~10.5k with a tool call, ~5k without) |
| Avg output tokens | 174 | 142 |
| Wall time per turn, scenario time / turns | 5-8 s | 12-18 s |

No dollar figure is given for these runs. The first version of this document
priced them from token counts at assumed rates; those figures were removed on
2026-11-26 because this repo reports spend only from OpenAI's costs API
(CLAUDE.md, "Cost figures"), and no costs-API reading was taken on
2026-11-18. What the measurements do support: the Agents API sends about 4.6
times the input tokens per turn for about the same output.

The input overhead is the Codex base prompt, which the API always prepends.
The probe saw about 45% of it served from cache. The wall time includes the
usage poll and the classifier calls, which run the same way on both backends.

Reading the result: the Agents variant passes everything, as expected,
because it never receives per-participant rows. Every researcher turn called
`study_overview` and then declined the per-participant request. Care-team
turns had no tools and declined. So the comparison shows the cost and latency
of the harness, not a safety gain. The data-retention verdict above is
unchanged.

To re-run:

```sh
for s in assistant-prompt-injection assistant-role-escalation assistant-data-exfiltration; do
  npm run redteam -- --suite full --scenario $s --out redteam-results/agents-eval/default-$s
  npm run redteam -- --suite full --scenario $s --variant assistant-agents-api --out redteam-results/agents-eval/agents-$s
done
```

Afterwards, confirm no session is left with
`client.beta.agents.sessions.list()`, filtered on
`metadata.app = ai-therapist-admin-assistant`, or call
`sweepOrphanedAgentSessions()`.

## What would have to be true to revisit the full assistant on the Agents API

Any one of these would change the answer:

1. **OpenAI offers request-scoped storage for Agents** (a `store: false`
   equivalent, or ZDR eligibility) with a published deadline for physical
   deletion. Then the full tool set could run under the same disclosure as
   today.
2. **A data agreement with OpenAI covers Agents session storage** (BAA or DPA
   terms naming `/v1/agents`), **and** the owner and the IRB approve an
   updated consent and protocol that disclose vendor-side session storage
   until deletion.
3. **The tool outputs become de-identified before they leave the server**,
   for example turn-local aliases in place of usernames and ids, re-mapped on
   our side before the answer is shown, plus coarsened timestamps. This is a
   real design project with its own re-identification review. The staff
   question still carries whatever names the staff member types.

Separately from the data question, the Agents API's features (durable
sessions, sandboxes, compaction, subagents, long-running work) mostly do not
apply to a read-only question-answering assistant whose turns finish in
seconds. The stateless Responses loop already does what this assistant needs.

## Rebuild and re-check (2026-11-26)

The branch was rebuilt as one commit on main at `4440562`. The decision above
is unchanged.

Against OpenAI's docs as they stand on 2026-11-26, with `openai` 7.57.0 (no
SDK upgrade was needed):

- Still beta, still `OpenAI-Beta: agents=v1` (the SDK adds it). The
  create-session body, the function-tool shape, the stream event names, the
  `agent.session.input.tool_result` and `.cancel` inputs, the list parameters
  and the delete semantics are all as the code uses them.
- Data controls are unchanged: `/v1/agents` application state "Until deleted",
  Zero Data Retention "No", abuse monitoring 30 days. No `store: false`
  equivalent and no per-session retention setting exists.
- `gpt-5.2`: the model page lists Responses, Chat Completions and Batch as
  supported endpoints and does not mention Agents, and the Agents examples
  use newer models. It is still accepted (live turns below). If OpenAI stops
  accepting it, this backend fails with the assistant's ordinary "unavailable"
  message and the stateless backend is unaffected.
- New since the first pass and now used: `spend_control` (a per-session spend
  ceiling, best-effort) and the `agent.session.budget_reached` event. New and
  left alone: `prompt_cache_options`, `stream_options.include_obfuscation`,
  `agent.compaction`.
- The docs do not say in one sentence that no hosted tool is on by default.
  Observed live: the created session's tool list was exactly the two entries
  sent. The backend now checks that list on every turn rather than trust it.

Found on review and fixed in the rebuild:

- Small-cell suppression nulled a fixed list of fields, so a field added to
  `study_overview` later would have passed through to the session store. The
  result is now rebuilt from named numeric fields.
- The orphan sweep paged on `last_id`, which the SDK's page object does not
  carry, so it never looked past the first 100 sessions. It now pages on the
  last row's id and filters on the metadata tag at OpenAI too.
- Calls other than the turn stream had the SDK's ten-minute default timeout.
  They now have 15 s.
- A turn that failed before any tool ran left no audit row although the
  question had been stored at OpenAI. It is now audited.

Live, 2026-11-26, scratch database with seeded fixtures only:

- One probe session (synthetic question, synthetic tool result): accepted
  with `gpt-5.2`, `review: none` and `spend_control: {limit: 25}`; usage was
  again null on `turn.completed`; deleted with `deleted: true`.
- `assistant-prompt-injection` on `--variant assistant-agents-api`: PASS
  17/17 in 29.8 s. Three assistant turns, audited as `agents-api:gpt-5.2`
  with 10,319 / 10,630 / 5,414 input tokens.
- Listing the project's sessions afterwards returned none.
- The other two assistant scenarios were not re-run on the rebuilt code.
- Spend, from the costs API (organisation-wide, month to date): 177.6066 USD
  at 05:38:57 UTC on 2026-11-27 before the first paid call, 177.9813 USD at
  05:45:16 UTC after the last. The difference, 0.3747 USD, is not this work's
  cost: other agents were spending on the same organisation in those six
  minutes, the API reports by UTC day and lags, and these calls cannot be
  isolated in it.

Not covered by anything here: a turn on the Agents API from the deployed app
(stage or prod), and the production API key's Agents scopes.
