# Model pinning for research reproducibility (ai-therapist-61)

## Problem

Models are configured as **floating aliases**. OpenAI can move the snapshot
behind an alias at any time, so two sessions run a week apart under the "same"
configuration may have been produced by different model weights — a confound for
any study analysis.

> **GPT-Live migration (2026-09, `docs/gpt-live.md`):** a voice session now runs
> **two** pinned models, not one. The voice model (`system_config.ai_model`,
> `gpt-live-1`) handles the spoken conversation; the delegated Responses backend
> (`system_config.live_backend_model`, `gpt-5.6-terra`) does the clinical
> reasoning and calls the tools. **The backend model is the one that determines
> clinical response quality**, so an analysis that pins only `ai_model` has not
> actually pinned the therapist.
>
> Transcription is no longer a pinned model at all: GPT-Live transcribes both
> sides internally. `transcription_model` / `transcription_context` in
> `system_config` are inert (marked `_deprecated` by migration 099), and
> `src/server/utils/transcriptionConfig.ts` was deleted. The historical
> `gpt-transcribe` migration note below applies only to sessions recorded
> **before** the GPT-Live cutover.

> **Historical — transcription migration (2026-09-09, ai-therapist-166):**
> OpenAI shuts down `whisper-1` and the whole
> `gpt-4o(-mini)-transcribe(-diarize)` family on **2027-02-26**. Migration 097
> moved the default to `gpt-transcribe`. This affected Realtime-era sessions
> only; GPT-Live sessions have no transcription model.

## What the system records

- **Per session** (`session_configurations`, migration 033):
  - `ai_model` — the **voice** model string the session was created with
    (`gpt-live-1`, or a `gpt-realtime-*` id for pre-migration sessions).
  - `transcription_model` — **`NULL` for every GPT-Live voice session**, written
    explicitly rather than left to default, so an analyst is not misled into
    thinking a transcription model was in play. Populated for pre-migration
    Realtime sessions.
  - `turn_detection` — likewise `NULL` for GPT-Live sessions: the model owns
    turn-taking and exposes no VAD configuration.
  - `instructions` — the assembled clinical prompt. Note this is the string that
    is sent to the **delegated backend** under GPT-Live, not to the voice model.
  - `NULL` on any of these can also mean unknown (row predates migration 033, or
    the session row was lazily created by `/logs/batch`).
- **Not recorded per session: the backend model.** `live_backend_model` is read
  from `system_config` at session creation and passed to OpenAI, but there is no
  `session_configurations` column holding it. Until there is, the backend model
  for a given session has to be reconstructed from
  `session_llm_usage.model` where `purpose = 'live_delegation'`, which records
  the model string OpenAI reported on each delegated response. That is a
  reliable per-session record as long as the session made at least one delegated
  call.
- **Globally** (`system_config.ai_model`, `system_config.live_backend_model`):
  whatever the admin selected — alias or pinned snapshot.

## Recommendation

**Pin a dated snapshot for BOTH models for the duration of any data-collection
period.** In Admin → System Config, set AI Model Selection (voice) and the Live
backend model to exact dated model strings. Any string is accepted (the server
does not validate against a list — it only checks that `ai_model` starts with
`gpt-live`), so upgrades become a deliberate, dated config change instead of
silently following an alias. Record both change dates in the study log;
per-session stamps make the boundary verifiable afterwards.

Between study periods it is fine to move back to the alias to pick up
improvements; the per-session stamps keep the record straight either way.

## Analysis note

To group sessions by actual model:

```sql
-- Voice model
SELECT ai_model, COUNT(*) FROM session_configurations GROUP BY ai_model;

-- Delegated backend model, reconstructed from usage rows
SELECT model, COUNT(DISTINCT session_id)
  FROM session_llm_usage
 WHERE purpose = 'live_delegation'
 GROUP BY model;
```

The eval harness (see `docs/eval-system.md`) stores its own judge model +
prompt version per eval row, so therapist-model comparisons across snapshots
can be scored consistently.
