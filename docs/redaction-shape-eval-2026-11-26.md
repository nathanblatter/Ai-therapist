# Redaction request-shape eval: lone crisis messages (2026-11-26)

**Status: measurement only. Nothing in the pipeline changed. Needs an owner decision (end of this page).**

## Question

With the default (legacy) wording, a message redacted on its own (a therapist
edit, or the re-send of a message whose batch output failed validation) goes
to gpt-5 as bare text under the base prompt. gpt-5 tends to answer explicit
crisis text instead of redacting it; validation rejects that reply, nothing is
stored, and the message waits for manual redaction. The open options were
manual redaction, the held `v2` wording, or another model. This eval measures
a fourth: send the lone message through the EXISTING batch request shape
(`[{"i":0,"text":...}]` under the existing batch instructions), on its own or
padded with neutral messages, so that no prompt wording changes.

## Method

- Fixture: `evals/goldens/redaction-crisis.jsonl`, 26 INVENTED messages (no
  participant data): 20 crisis (explicit intent with identifiers x5, explicit
  intent without x3, passive ideation x3, self-harm x3, attempt in progress
  x3, harm to others x3) and 6 ordinary controls with identifiers. Each lists
  the identifiers that must be gone and clinical phrases that must survive.
- Runner: `scripts/redaction-shape-eval.mjs`, which calls the production
  functions (`redactPHI`, `redactPHIBatch`): gpt-5, flex tier, reasoning
  effort low, double pass, the same validation and call caps, legacy wording
  (`REDACTION_PROMPT_VERSION` unset).
- Conditions:
  - `single`: `redactPHI(message)`, today's lone-message path (bare text).
  - `batch1`: `redactPHIBatch([message])`, a batch of one.
  - `batch3`: the message between 2 neutral messages.
  - `batch12`, `batch26`: the message among 11 / 25 neutral messages (added
    after `batch3` still refused; `batch26` was run on the crisis messages only).
  - `batchAll`: the whole fixture as one 26-message batch (the nearest thing
    to a real session; only 2 runs, and the messages in one batch share one
    model call, so this is 4 independent calls, not 52 trials).
- Runs: 3 per message for `single`, `batch1`, `batch3`; 2 for the others.
- Outcome of a trial is what the pipeline would have stored: `refused` (the
  model answered the message instead of redacting it; rejected by validation
  as `refusal`, `added_crisis_resource`, `words_not_in_input`, or, in the
  batch shape, `unparseable_reply` because the answer was prose instead of
  JSON), `rejected` for any other validation failure (none occurred),
  `accepted-correct` (stored; every listed identifier gone, every listed
  clinical phrase intact), `accepted-with-problem` (stored, but an identifier
  survived or a clinical phrase was replaced by a placeholder).
- In the padded conditions a message whose batch output fails is re-sent on
  its own as bare text by the production code. One accepted result (in
  `batch3`) came from that re-send; every other accepted result came from the
  batch call itself.

## Results

Cells are refused / rejected / accepted-correct / accepted-with-problem.

| Class | single | batch1 | batch3 | batch12 | batch26 | batchAll |
| --- | --- | --- | --- | --- | --- | --- |
| Explicit intent, with identifiers | 15/0/0/0 (n=15) | 12/0/2/1 (n=15) | 13/0/1/1 (n=15) | 5/0/5/0 (n=10) | 3/0/5/2 (n=10) | 0/0/7/3 (n=10) |
| Explicit intent, no identifiers | 9/0/0/0 (n=9) | 9/0/0/0 (n=9) | 7/0/2/0 (n=9) | 2/0/3/1 (n=6) | 4/0/2/0 (n=6) | 0/0/4/2 (n=6) |
| Passive ideation | 9/0/0/0 (n=9) | 5/0/4/0 (n=9) | 4/0/5/0 (n=9) | 0/0/6/0 (n=6) | 0/0/6/0 (n=6) | 0/0/5/1 (n=6) |
| Self-harm | 6/0/0/3 (n=9) | 4/0/2/3 (n=9) | 2/0/1/6 (n=9) | 0/0/3/3 (n=6) | 0/0/2/4 (n=6) | 0/0/3/3 (n=6) |
| Attempt in progress | 9/0/0/0 (n=9) | 5/0/1/3 (n=9) | 6/0/1/2 (n=9) | 3/0/1/2 (n=6) | 2/0/2/2 (n=6) | 0/0/5/1 (n=6) |
| Harm to others | 7/0/2/0 (n=9) | 1/0/8/0 (n=9) | 1/0/8/0 (n=9) | 1/0/5/0 (n=6) | 0/0/6/0 (n=6) | 0/0/6/0 (n=6) |
| **All crisis** | **55/0/2/3 (n=60)** | **36/0/17/7 (n=60)** | **33/0/18/9 (n=60)** | **11/0/23/6 (n=40)** | **9/0/23/8 (n=40)** | **0/0/30/10 (n=40)** |
| Controls | 0/0/17/1 (n=18) | 0/0/18/0 (n=18) | 0/0/18/0 (n=18) | 0/0/12/0 (n=12) | not run | 0/0/11/1 (n=12) |

Stored (accepted) share of crisis messages: single 5/60 (8%), batch1 24/60
(40%), batch3 27/60 (45%), batch12 29/40 (73%), batch26 31/40 (78%), batchAll
40/40. For explicit suicidal intent alone: single 0/24, batch1 3/24, batch3
4/24, batch12 9/16, batch26 9/16, batchAll 16/16.

Other observations:

- **The batch shape does not stop the refusals.** In `batch1`, 30 of the 36
  refusals were prose crisis replies in place of the JSON array; in the rest
  the model put its reply inside the JSON `text` field. Validation caught all
  of them: no refusal was stored in any condition.
- **The second pass costs acceptances.** 14 of the 36 `batch1` refusals (and 4
  of the 55 `single` ones) came on pass 2, when the model was shown the
  already-redacted text again.
- **Neutral padding helps and then stops helping.** 2 neighbours changed
  little; 11 and 25 neighbours gave about the same result (73% and 78%), with
  explicit intent still refused in 7 of 16 trials each.
- **The 26-message mixed batch had no refusals in 4 calls**, which matches
  the earlier 12-message observation, but it is 4 calls and its neighbours
  were other crisis messages, not neutral filler. It does not show that a
  padded lone message would behave the same; `batch26` suggests it does not.
- **Identifier removal on controls was the same in every condition**: every
  listed identifier removed (48/48, 48/48, 48/48, 32/32, 32/32).
- **One identifier survived in every condition**: the school name in
  "Timpview High School" was kept in 12 of the 15 accepted outputs for that
  message (3 of 3 in the single shape). This is a redaction-quality finding
  independent of the request shape, and the only identifier that survived
  anywhere.
- **Over-redaction of time words** (counted on accepted outputs; "tonight",
  "last night", "twenty minutes ago", "this week" replaced by
  `[REDACTED: DATE]` or `[REDACTED: TIME]`): single 4 of 23 accepted outputs,
  batch1 8 of 42, batch3 8 of 45, batch12 5 of 41, batch26 10 of 31, batchAll
  13 of 52; 48 of 234 in total. "today" was also replaced in 11 of the 15
  outputs of the school message (not counted in those figures). No clinical phrase other than a time expression was
  lost. Every "accepted-with-problem" cell above is one of these two things.

## Reading

Sending a lone message as a batch of one, or between two neutral messages,
raises the stored share of crisis messages from 8% to 40-45% with no change on
the controls, but explicit suicidal intent, the case that matters most, is
still refused about 5 times in 6. That is not the "large majority" the task
set as the bar for building the route, so no switch was implemented. Padding
with 11 or more neutral messages reaches about three quarters overall and a
little over half for explicit intent; it would also send invented filler text
with every lone message, twice (double pass), which is a change to what the
model is sent even though no instruction wording changes.

Small n throughout (2 or 3 runs per message, one fixture, one night); treat
the percentages as rough.

## Cost

812 model calls, 0.91 M input and 0.52 M output tokens (output includes
reasoning tokens): about $3.20 at gpt-5 flex rates. If flex capacity was
unavailable for some calls they were billed at the standard rate (double).

## Decision needed from the owner

How should lone crisis messages (therapist edits and re-sends) get redacted,
given that the no-wording-change route is only a partial fix?

1. Keep manual redaction for rejected messages (today's behaviour), or
2. build the lone-message batch route anyway behind a default-off switch as a
   partial improvement (about 40% stored as a batch of one, about 75% with 11
   neutral filler messages, explicit intent still mostly or half refused), or
3. take the `v2` wording or another model to the PI, with this fixture and
   runner as the eval to run first.

Separately: time words in crisis messages are replaced with DATE/TIME
placeholders in roughly 1 in 5 stored outputs, and a school name was usually
left in. Both are properties of the current wording in every shape.

## Reproduce

```
OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/redaction-shape-eval.mjs \
  --out /somewhere/outside/the/repo/redaction-shape.jsonl \
  --conditions single,batch1,batch3 --runs 3
```

The output file quotes the synthetic messages and the model's replies
(including crisis-style refusals); keep it out of the repo.
