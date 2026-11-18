# OpenAI Agents API for the admin assistant: evaluation and decision

Date: 2026-11-18. Scope: the staff-facing admin assistant only
(`src/server/services/assistant.service.ts`). The participant conversation
paths are out of scope and were not touched.

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
behaves exactly as before (pinned by a unit test that also passes against the
pre-change code).

The trial lets the owner see the API's shape, latency and cost on real
questions. It is not a replacement for the full assistant. While the flag is
on, researchers lose six of their seven tools, and therapists and caseworkers
have no data tools at all.

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
  `gpt-6-astra`. A session created with `gpt-5.2` was accepted and reported
  `model: gpt-5.2` (probe below). Whether gpt-5.2 completes a turn has not
  been verified.

## Pricing

"Model usage is billed at the selected model's API rates. OpenAI tools use
their standard rates, and OpenAI-hosted sandboxes use standard container
rates." ([overview](https://developers.openai.com/api/docs/guides/agents-api/overview#pricing))
No per-session fee is documented. Extra token sources specific to the harness:
the Codex base instructions on every model call; context compaction
("Background compaction may increase token usage"); and automatic review if
enabled ("Tokens used for review are billed in addition"). This backend uses
no sandbox, no hosted tools and no automatic review, so it should cost model
tokens only, at gpt-5.2 rates, plus the base-prompt overhead. The overhead has
not been measured (see "Not verified").

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

Seven read-only tools, each running as the caller with role allowlists that
mirror the admin portal. Every turn writes an `assistant_audit` row (question,
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
any role. Six of the seven tools still return per-participant rows keyed by
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
  computer use, no automatic review. The only tools are our function
  definitions, and any other `required_actions` type fails the turn closed.
- Tools exposed: the role's allowlist intersected with
  `AGENTS_API_ELIGIBLE_TOOLS` = `study_overview`. Weekly and instrument
  aggregates over fewer than 5 participants are nulled before the result
  leaves the server. A call to any other tool is refused without executing
  and is audited with row count 0, just as on the stateless path.
- Lifecycle: one session per staff question. Earlier turns are folded into
  one user message, because the API takes user input only and the client
  already sends the whole history. The session is deleted in `finally`; if
  deletion fails, the code cancels and retries once. A throttled sweep
  deletes any session tagged `metadata.app = ai-therapist-admin-assistant`
  that is older than 5 minutes.
- Audit: same `assistant_audit` row, with `model = agents-api:gpt-5.2`. A turn
  that ran a tool is audited even if the model step failed afterwards.
- Instructions: the assistant's own prompt, unchanged, with the list of
  available tools, plus a short backend note naming what this path cannot see
  and stating that there is no shell, files or network. No other prompt
  changed.

What can reach OpenAI on this path: the staff question as typed, the
earlier turns of that chat, the assistant prompt, and study-wide aggregates
with small cells suppressed. If a staff member types a participant's username
into a question, that text is stored with the session until it is deleted,
which is the residual exposure of the trial. What cannot reach OpenAI on this
path: any per-participant tool row (usernames, ids, risk scores, crisis
records, escalations, work items, caseloads).

Turn it on with Admin, then System Config, then Additional Features, then
"Admin assistant: OpenAI Agents API backend (beta trial)", or set
`system_config.features.assistant_agents_api_enabled = true`. The config cache
holds values for up to 10 minutes. `ASSISTANT_ENABLED=true` must also be set,
as before.

## What has been verified, and what has not

The project's OpenAI credit balance ran out during this work (every call
returned 429 `credit_balance_exhausted`), so live runs stopped.

Verified live before then: a session was created with `model: gpt-5.2`,
`environment: none` and programmatic tool calling disabled, and the API
accepted the configuration. `DELETE` returned `deleted: true`, and a
subsequent retrieve returned 404. The first turn failed on billing
(`usage_limit_exceeded`) before any inference ran.

Not verified:

- that a function call round-trips on the create-session stream (that the
  same stream carries the turn after `requires_action` through to
  `turn.completed`, as the SDK's stream helper describes);
- the Codex base-prompt token overhead and the cost per turn;
- latency;
- the three red-team scenarios on either backend.

Unit tests cover the behaviour with mocks. To run the comparison once credits
are back, use a scratch database built with `scripts/redteam-db-setup.sh`,
then:

```sh
for s in assistant-prompt-injection assistant-role-escalation assistant-data-exfiltration; do
  npm run redteam -- --suite full --scenario $s --out redteam-results/agents-eval/default-$s
  npm run redteam -- --suite full --scenario $s --variant assistant-agents-api --out redteam-results/agents-eval/agents-$s
done
```

Compare `summary.json` pass/fail and cost in each output folder. Latency per
turn is in the console log, and token usage per turn is in
`assistant_audit.input_tokens` / `output_tokens`. Expect the Agents variant to
pass the canary checks trivially, because it never sees per-participant
rows. The interesting signals are the classifier checks (refusal wording
under the Codex base prompt), the base-prompt token overhead, and latency.
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
