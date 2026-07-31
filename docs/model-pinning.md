# Model pinning for research reproducibility (ai-therapist-61)

## Problem

The realtime and transcription models are configured as **floating aliases**
(`gpt-realtime-2.1` / `gpt-realtime-2.1-mini`, `gpt-4o-transcribe` /
`gpt-4o-mini-transcribe`). OpenAI can move the snapshot behind an alias at any
time, so two sessions run a week apart under the "same" configuration may have
been produced by different model weights — a confound for any study analysis.

## What the system records

- **Per session** (`session_configurations.ai_model`,
  `session_configurations.transcription_model`, migration 033): the exact model
  strings the session was created with. If OpenAI's `client_secrets` response
  reports a resolved model different from the requested alias, the resolved
  value is stored (and logged: `[Token] OpenAI resolved model ...`).
  `NULL` means unknown (row predates migration 033, or the session row was
  lazily created by `/logs/batch`).
- **Globally** (`system_config.ai_model` / `system_config.transcription_model`):
  whatever the admin selected — alias or pinned snapshot.

## Recommendation

**Pin a dated snapshot for the duration of any data-collection period.**
In Admin → System Config → AI Model Selection / Transcription Model, choose
"Pinned snapshot" and enter the exact dated model string (e.g.
`gpt-realtime-2025-08-28`). Any string is accepted (the server does not
validate it against a list), so upgrades become a deliberate, dated config
change instead of silently following the alias. Record the change date in the
study log; per-session stamps make the boundary verifiable afterwards.

Between study periods it is fine to move back to the alias to pick up
improvements; the per-session stamps keep the record straight either way.

## Analysis note

To group sessions by actual model:

```sql
SELECT ai_model, COUNT(*) FROM session_configurations GROUP BY ai_model;
```

The eval harness (see `docs/eval-system.md`) stores its own judge model +
prompt version per eval row, so therapist-model comparisons across snapshots
can be scored consistently.
