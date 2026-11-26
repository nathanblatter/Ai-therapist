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

---

# Addendum (2026-11-26, later the same night): place and organisation names

**Status: measurement only. No prompt, model, tier, threshold, validation or
product code changed. Needs a PI and owner decision (end of this section).**

## Question

The eval above found one school name ("Timpview High School") left in 12 of 15
stored outputs. That was one fixture item. How often does redaction leave an
identifying place or organisation name in an ordinary message, and does the
leak check that runs after redaction flag the ones it leaves?

## What the two prompts ask for

The redaction prompt (`redaction.service.ts`, unchanged) lists the 18 Safe
Harbor identifiers. Of the classes measured here:

| Class | In the redaction prompt's list? |
| --- | --- |
| Person names, phone, email, street address, date of birth (controls) | Named explicitly (items 1, 2, 3, 4, 6) |
| Small towns | Named explicitly: item 2, "city" |
| Neighbourhoods | Covered by item 2's wording ("all geographic subdivisions smaller than state"), not named as such |
| High schools, universities, campus buildings and dorms | Not named |
| Employers and small businesses | Not named |
| Churches, wards and congregations | Not named |
| Hospitals and clinics | Not named |
| Named apartment complexes | Not named |
| Sports teams and clubs | Not named |

The classes marked "not named" can only be reached through item 18 ("any
other characteristic that could uniquely identify the individual") or by
reading the name as a location. The same prompt also says "Do not redact any
information unless it exactly matches a Safe Harbor identifier" and "Be
strict", which points the other way. A name left in from one of those classes
is therefore the model following the wording it was given, not the model
failing; whether the wording should ask for them is a question for the PI.

The leak check's question (`redactionVerifier.service.ts`, unchanged) names
person names, a street address or city, dates, phone, email, account or
record numbers, URLs and "any other number or string that identifies a
specific person". It does not name organisations either, and it says generic
references such as "the university" are not identifiers.

## Method

- Fixture: `evals/goldens/redaction-place-org.jsonl`, 50 INVENTED ordinary,
  non-crisis messages (no participant data; place names are invented or are
  generic public ones). 40 carry exactly one place or organisation name, 5 in
  each of 8 classes; 6 controls carry one clearly listed identifier (2 full
  names, phone, email, street address, date of birth); 4 have nothing to
  redact. Each row lists the strings that must not survive.
- Runner: `scripts/redaction-place-org-eval.mjs` (opt-in, never in CI).
  Redaction is the production `redactPHIBatch`: gpt-5, flex tier, reasoning
  effort low, double pass, same validation and call caps, legacy wording
  (`REDACTION_PROMPT_VERSION` unset). The 50 messages go through in 5 batches
  of 10, shuffled per run so every batch mixes classes; 3 runs, so 15 batches
  and 30 model calls.
- Leak check: the production `askLeakCheck` on every stored output, with the
  code default config that migration 110 seeds (backend auto, threshold 0.5).
  All 150 checks were answered by the Decisions API (gpt-6-luna); none
  errored. No database was used, so a deployment's own `system_config`
  threshold, if it differs, was not what ran.
- Outcome per message and run: `removed` (stored; none of the listed strings
  left), `survived` (stored; a listed string still there), `rejected` (failed
  validation; not stored).

## Results

### Redaction

| Class | In the prompt's list | n | Removed | Survived | Rejected |
| --- | --- | --- | --- | --- | --- |
| High schools | no | 15 | 0 | 15 | 0 |
| Universities, campus buildings, dorms | no | 15 | 3 | 12 | 0 |
| Employers and small businesses | no | 15 | 0 | 15 | 0 |
| Churches, wards, congregations | no | 15 | 2 | 13 | 0 |
| Hospitals and clinics | no | 15 | 0 | 15 | 0 |
| Named apartment complexes | no | 15 | 5 | 10 | 0 |
| Sports teams and clubs | no | 15 | 0 | 15 | 0 |
| **All classes not in the list** | | **105** | **10** | **95** | **0** |
| Small towns and neighbourhoods | yes | 15 | 15 | 0 | 0 |
| Controls: name, phone, email, street address, date of birth | yes | 18 | 18 | 0 | 0 |
| Nothing to redact | n/a | 12 | 12 (unchanged) | 0 | 0 |

- **Every identifier the prompt lists was removed every time** (33 of 33:
  towns, neighbourhoods and the controls). Clearly covered identifiers were
  never missed.
- **Place and organisation names the prompt does not list were left in 95 of
  105 times (90%).** Every one of the 35 messages kept its name in at least
  one run; 27 kept it in all three. The 10 removals were a dorm (2 of 3
  runs), a campus building, a ward, a church (1 run each), and four of the
  five apartment complexes (1 or 2 runs each), all replaced by a LOCATION or
  NAME placeholder. A survivor was always the message returned word for
  word: no partial redactions.
- No output was rejected by validation, and no message with nothing to redact
  came back changed (0 of 12).

### Leak check on the stored outputs

The leak check gave the same probability every time it saw the same text, and
the same text recurs across runs, so the honest unit is the distinct output
text. Both counts are shown.

| | Flagged, by output | Flagged, by distinct text |
| --- | --- | --- |
| Outputs where the name survived (should be flagged) | 62 of 95 (65%) | 23 of 35 (66%) |
| Clean outputs (should not be flagged) | 12 of 55 (22%) | 6 of 25 (24%) |

Catch rate on survivors by class (distinct texts): high schools 4 of 5,
universities and campus 2 of 5, employers 3 of 5, congregations 4 of 5,
hospitals and clinics 4 of 5, apartment complexes 4 of 5, teams and clubs 2
of 5.

- **The leak check missed about a third of the surviving names.** The 12
  messages it passed, with the probability it gave: BYU (0.01), the
  Cougarettes (0.14), Helaman Halls (0.27), Monarch Flats (0.29), Ridgeline
  United (0.31), Utah Valley University (0.32), Skyridge (0.32), Cornerstone
  Baptist (0.33), Wasatch Peak Solar (0.34), Bluebird Bakery (0.43), the
  Bonneville Chess Club (0.46), Primary Children's Hospital (0.49). Most sit
  between 0.3 and 0.5, just under the 0.5 threshold.
- **Every false flag was on a placeholder, not on leftover text.** The 12
  falsely flagged outputs were correctly redacted messages: "call me back at
  [REDACTED: TELEPHONE NUMBER]" (0.53, 3 runs), "send the worksheet to
  [REDACTED: EMAIL ADDRESS]" (0.68, 3 runs), "I live at [REDACTED:
  LOCATION]" for the street address (0.60, or 0.85 when the label was
  ADDRESS; 3 runs), and the redacted dorm and church sentences (0.67 twice,
  0.86 once). Of the 43 clean outputs that contained a placeholder 12 were
  flagged; of the 12 with no placeholder none were. So the phone, email and
  street-address controls were flagged on every run although nothing had
  leaked, despite the question saying placeholders are not identifiers.

## What was and was not measured

Measured: the legacy wording, gpt-5 on flex, the batch path, batches of 10
mixed messages, one identifier per message, 3 runs on one night; the leak
check on the Decisions backend at the default 0.5 threshold.

Not measured, and not to be read into these numbers:

- Real transcripts. The messages are invented, short, and each states its
  identifier plainly; real sessions are longer, and a name may appear with
  other identifiers or be alluded to.
- How identifying each name is. "BYU" in a study recruited at BYU identifies
  nobody; "resident manager at the Sycamore Lofts" or "Relief Society
  president in the Edgemont 14th Ward" nearly does. The fixture mixes both on
  purpose and the table does not weigh them. Whether a class should be
  redacted is a judgement about re-identification risk that this eval does
  not make.
- Independence. Messages in a batch share one model call, and 3 runs of 5
  items is a small sample: the per-class figures separate "almost always
  left in" from "always removed", not 80% from 90%.
- The single-message path, the `v2` wording, any other model, the Responses
  fallback of the leak check, and any other threshold.
- Whether the leak check's false flags on placeholders also occur at this
  rate in stored study data. That can be counted from
  `metadata.redaction_check` without any model call; it was not looked at
  here because this eval reads no stage or prod data.

## Cost

Redaction: 30 calls, 40,177 input and 36,330 output tokens (reasoning
included), all served on flex: about $0.21 at gpt-5 flex rates. Leak check:
150 Decisions API calls, 41,938 input tokens on gpt-6-luna, on top of that
(rate not assumed here). The $3 budget was not approached.

## Decision needed

1. **PI: should the redaction wording ask for organisation and facility
   names** (schools, employers, congregations, clinics, housing complexes,
   teams) when they point at a person? As written it does not, and the model
   leaves them in about 9 times in 10. This is a wording and protocol
   question (what the IRB materials promise is removed), and any new wording
   needs this fixture and the crisis fixture run against it before it ships,
   because broader redaction can also remove clinical content.
2. **Owner: the leak check is not a backstop for this class today.** It
   passes about a third of the surviving names and flags about a fifth of
   correctly redacted messages because of their placeholders. Decide whether
   its question should name organisations and be tested against placeholder
   text, in step with whatever the PI decides for item 1, so the two prompts
   ask for the same thing.

## Reproduce

```
OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/redaction-place-org-eval.mjs \
  --out /somewhere/outside/the/repo/redaction-place-org.jsonl --runs 3
```

The output file quotes the synthetic messages and the model's outputs; keep
it out of the repo.
