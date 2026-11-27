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
reasoning tokens): about $3.20 at gpt-5 flex rates (an estimate from token
counts, written before the rule that cost figures come from the billing API;
the costs API shows $17.40 for the UTC day of 2026-11-26 in total). If flex capacity was
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
included), all served on flex: about $0.21 at gpt-5 flex rates (a token-count
estimate, not a billing figure). Leak check:
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

# Addendum 2 (2026-11-26, evening): a capitalised-word signal beside the leak check

No wording, model or threshold changed. The leak check gained a second,
deterministic reason to flag a redacted message for review: a word that is
still capitalised like a name in the middle of a sentence
(`src/shared/leftoverNames.ts`; weekdays, months, clinical abbreviations,
crisis-line names, medicines, states and everyday emphasis words are not
counted). It changes no stored text. A flagged message goes to the top of
the researcher review queue and stays out of researcher semantic search
until someone has looked at it, exactly as a model-flagged one does.

Measured offline on outputs already on hand (no new model calls):

| Material | Model check alone | Capitalised-word signal | Either |
| --- | --- | --- | --- |
| Place/organisation eval above: 95 stored outputs with the name left in | 62 flagged | 95 flagged | 95 |
| Same eval: 55 clean outputs | 12 falsely flagged | 1 falsely flagged ("Relief Society") | 13 |
| Crisis shape eval: 4 stored outputs with a leak | not run | 4 flagged | |
| Crisis shape eval: 120 clean outputs | not run | 0 flagged | |
| Stage's fake transcripts: 1,182 redacted participant messages | 0 flagged | 15 flagged (1.3%) | |
| Stage's fake transcripts: 1,324 redacted assistant messages | 4 flagged | 40 flagged (3.0%) | |

Read these with care:

- The rule was written after looking at the place/organisation outputs, so 95
  of 95 is an in-sample number. The rule itself is general (any mid-sentence
  capital that is not on a short ordinary-word list), but an independent
  fixture has not been run.
- On stage the flagged participant messages include real leftovers the model
  check had passed: first names (four different ones), a shop, a city and an
  airport code. The rest are harmless proper nouns (a country, a programming
  language, a landmark). Nobody has labelled the 2,506 stage messages, so
  there is no recall number for them.
- Known blind spots: a name that opens a sentence, a name typed in lower
  case, and anything not in English.
- It raises reviewer workload: about 1 to 3 in 100 messages on this sample,
  most of them harmless.

This is a net for the reviewer, not a fix: the names are still in the stored
text until someone edits them out. Whether the redaction wording should ask
for organisation names is still the PI's question (item 1 above).

# Addendum 3 (2026-11-26, evening): two candidate wordings, measured, not shipped

Nothing in the product changed. The wording production sends is still the
one in `src/server/services/redaction.service.ts`; changing it needs the PI's
sign-off and a regenerated IRB prompts attachment. This addendum gives the PI
before-and-after numbers for two candidate additions.

## The candidates

Both are edits to the numbered identifier list, applied to the request only
inside the eval runners (`--wording <file>`, `scripts/redaction-eval-wording.mjs`).

- **A, organisations** (`evals/candidates/redaction-wording-orgs.json`). Item
  18 gains: "This includes the proper name of a specific organization or
  facility connected to the individual: a school, college or university (and
  its named buildings, dorms and teams), an employer or business, a hospital
  or clinic, a church, ward or congregation, an apartment complex, a sports
  team or club. Replace each with "[REDACTED: ORGANIZATION]". A generic
  reference without a proper name ("my school", "the hospital", "work", "my
  ward") is not an identifier and must be left as written".
- **B, organisations and time words**
  (`evals/candidates/redaction-wording-orgs-time.json`). A, plus item 3
  gains: "Relative or general time expressions ("tonight", "last night",
  "today", "this week", "twenty minutes ago", a weekday, a time of day) are
  not dates and must be left as written".

## Place and organisation fixture (50 messages, 3 runs, batches of 10)

| Wording | Names left in (of 105) | Listed identifiers removed (of 33) | Rejected | Nothing-to-redact messages changed (of 12) | Clean outputs the leak check flagged |
| --- | --- | --- | --- | --- | --- |
| Production (addendum 1) | 95 | 33 | 0 | 0 | 12 of 55 |
| A | 0 | 33 | 0 | 0 | 15 of 150 |
| B | 0 | 33 | 0 | 0 | 14 of 150 |

Under both candidates every one of the 105 names became an ORGANIZATION (or
LOCATION) placeholder and nothing else in those messages was touched, with
two exceptions: "Relief Society" (a generic office, not a named congregation)
was redacted as an organisation in 3 of the 6 runs (2 of 3 under A, 1 of 3
under B), and under A "two in the morning" became a TIME placeholder in 1 of
3 runs. The leak check's false flags
are still all on placeholders.

## Crisis fixture (26 messages, 3 runs, whole-fixture batch and batch of 12)

156 message-runs per wording, production wording re-run the same evening.

| Wording | Stored | Refused | Rejected | Stored outputs with a "keep" phrase lost | Stored outputs with an identifier left in |
| --- | --- | --- | --- | --- | --- |
| Production | 142 | 14 | 0 | 17 | 4 (the school name) |
| A | 139 | 15 | 2 | 17 | 0 |
| B | 141 | 15 | 0 | 0 | 0 |

- Every lost "keep" phrase was a time expression ("tonight" 10 of the 17
  under production). B lost none in 141 stored outputs, and still redacted
  the calendar date in the fixture ("March 3rd") every time.
- The school name that survived under production was removed under A and B.
- Refusals did not move (14, 15, 15, all in the batch of 12; none in the
  whole-fixture batch under any wording). Neither candidate is a fix for
  refused lone crisis messages; that is the separate request-shape question
  in the first part of this document.

## Limits

- One evening, one model snapshot (gpt-5-2025-08-07, flex), invented
  messages, small counts. 0 of 105 does not mean never.
- The fixtures were written before the candidates, but the candidate lists
  the same classes the fixture tests, so this is the favourable case. Classes
  the wording does not name (a named gym, a support group, a military unit, a
  small online community) were not tested.
- Over-redaction was looked for only where the fixtures can show it: the
  nothing-to-redact messages, the "keep" phrases, and reading the 2-placeholder
  outputs. Whether A or B removes large, non-identifying organisation names a
  researcher would want kept (a national retailer, a streaming service) was
  not measured; the fixture has none.
- The prompt's own second example redacts a clock time ("10:45AM") as TIME.
  B's sentence and that example pull in different directions; a final wording
  should settle which it is.
- Volume of this addendum: 890 redaction calls, about 1.13M input and 0.56M
  output tokens on gpt-5 flex, plus 300 leak-check calls. Cost: see the
  billing reading under addendum 4; no per-addendum figure exists.

## For the PI

1. Add organisation and facility names to the redaction wording (A)?
2. Add the sentence that keeps relative time expressions (B)?
3. If either: is "Relief Society president" (an office in a congregation,
   without the congregation's name) something to redact or to keep?

## Outcome (2026-11-26, same evening)

The study owner decided to adopt candidate B. It is now the wording in
`src/server/services/redaction.service.ts` (the same two sentences, word for
word), the IRB prompts attachment was regenerated from it, and the two
candidate files were removed because their edits no longer apply. The
`--wording` option on the runners stays for the next candidate. Open after
this change: "Relief Society"-style generic offices are sometimes redacted,
the prompt's second example still redacts a clock time, and refused lone
crisis messages are unchanged.

# Addendum 4 (2026-11-26, late): refused messages with nothing to redact, and a leak check per kind

Decided by the study owner the same evening; shipped in one change.

## 1. The leak check asks one question per kind of identifier

`src/server/services/identifierCheck.ts`: five yes/no questions in one
Decisions API request (a person's name, an organisation, a place, a date, a
contact detail or number). The probability of a leak is the largest of the
five, and the row records which kinds reached the threshold, so the review
screen says what is suspected. The single broad question it replaces did not
name organisations and flagged placeholders.

Measured on outputs already on hand (454 Decisions calls, no redaction calls):

| Material | Single question (addendum 1) | Five questions, threshold 0.5 |
| --- | --- | --- |
| 95 old-wording outputs with an organisation name left in | 62 flagged | 95 flagged, all as "organization" |
| 55 old-wording clean outputs | 12 falsely flagged | 3 falsely flagged |
| 150 new-wording clean outputs | 14 falsely flagged | 3 falsely flagged |
| 78 new-wording clean crisis outputs | not run | 0 flagged |

The remaining false flags are all the date question firing on a sentence
with a LOCATION or ORGANIZATION placeholder.

## 2. A refused message with nothing in it is stored as it stands

The redaction model answers a lone crisis message instead of redacting it.
Validation catches that every time, but the message then waits for a person,
and most such messages hold no identifier. Now, for a message whose only
failure is a refusal (or a prose reply where JSON was asked for), the same
five questions are asked of the message itself. The text is stored
unrewritten and marked `redaction_passthrough` only when all of these hold:

- no hard rule objects: the message has no digit, no "@" or web address, no
  word capitalised like a name, and is not typed wholly in capitals;
- every one of the five probabilities is under 0.1;
- the caller asked for it. Only the end-of-session job does (it marks the row
  and leak-checks it afterwards). Therapist edits and adverse-event drafts
  never do: a refused message there waits for a person as before;
- it is the original message. A message whose first pass succeeded and whose
  re-check was refused is rejected as before.

Otherwise the message is left for a person. The review screen shows "Stored
as written" on these rows. `REDACTION_REFUSAL_PASSTHROUGH=off` turns it off.

Why 0.1: asked of the raw fixture messages, all 62 that hold an identifier
scored 0.9 or more, and the 14 that hold none scored 0.07 or less except one
ordinary sentence at 0.41 (which would simply go to a person).

On the real code path as shipped (hard rules in, session-job shapes opted
in), crisis fixture, 3 runs, 60 crisis message-runs per request shape:

| Request shape | Stored before (first part of this document) | Stored now |
| --- | --- | --- |
| Batch of one | 24 of 60 (40%) | 37 of 60 |
| Batch of 12 | 44 of 60 (73%) | 48 of 60 |
| Single message, as a therapist edit sends it | 5 of 60 | 8 of 60 (unchanged on purpose: edits do not opt in) |

- Crisis messages with no identifier, in a batch: 23 of 30 stored in each
  shape, all 23 unrewritten. The other 7 were stopped by a hard rule or the
  classifier and wait for a person.
- No message the fixture lists an identifier for was stored unrewritten (0
  of 46 unrewritten rows). Across the 234 message-runs no identifier was left
  in and no "keep" phrase was lost.
- The gain is real but partial: what still waits for a person is every
  refused crisis message that DOES hold an identifier (the model refuses it,
  and the check correctly declines to store it unrewritten). That part is
  not solved.
- An earlier run of the first version of this change (before the hard rules,
  and with single messages opted in) stored 37 of 60 single messages and 49
  of 60 batches of one, and saw the whole-fixture batch refused outright in 1
  of 3 runs, which had not happened in earlier runs. Three runs cannot say
  whether that is chance or the prompt edits below.

## 3. Two prompt clean-ups

- The second example no longer redacts the clock time "10:45AM": it
  contradicted the sentence that says a time of day is not a date.
- Item 18 also says the name of a kind of group or office found in many
  places ("Relief Society", "student council", "PTA", "the bishopric"),
  without the specific organisation's name, is not an identifier.

Place and organisation fixture after these edits, 3 runs: 0 of 105 names left
in, 33 of 33 listed identifiers removed, 0 rejections, 0 of 12
nothing-to-redact messages changed, 3 of 150 clean outputs flagged by the
new leak check.

## The hard cases (added after an independent review of the change)

The first version leaned on the classifier alone for anything not
capitalised. `evals/goldens/redaction-passthrough-hard.jsonl` (40 invented
crisis messages) and `scripts/redaction-identifier-check-eval.mjs` test
exactly that, 3 runs:

| Class | Message-runs | Stopped by a hard rule | Stopped by the classifier (asked regardless) | Would be stored unrewritten |
| --- | --- | --- | --- | --- |
| Name typed in lower case | 12 | 0 | 12 | 0 |
| Organisation typed in lower case | 12 | 3 | 12 | 0 |
| Place typed in lower case | 9 | 3 | 9 | 0 |
| Name that opens a sentence | 12 | 0 | 12 | 0 |
| Phone, id, email, handle, date, plate | 18 | 18 | 18 | 0 |
| Name that is also an ordinary word (April, June, Amazon) | 15 | 0 | 15 | 0 |
| Typed in capitals | 6 | 6 | 6 | 0 |
| No identifier | 36 | 6 | 9 | 21 |

No message with an identifier would have been stored unrewritten (0 of 84);
the lowest classifier probability on one was 0.99. Lower-case names,
sentence-opening names and names that are ordinary words are held by the
classifier alone: the rules do not see them.

## Limits

- Small invented fixtures, one evening, one snapshot each of gpt-5 and
  gpt-6-luna. 62 of 62, 84 of 84 and 0 of 29 are not guarantees.
- The leak check that runs afterwards asks the same model the same questions
  about the same unrewritten text, so for these rows it is not an independent
  second opinion. The independent nets are the hard rules.
- The refused-message check sends the message text to the Decisions API,
  which has no per-request "do not store" setting; retention follows the
  OpenAI organisation's data controls. The redaction call itself sets
  `store: false`.
- Volume of this addendum: about 1,050 gpt-5 flex calls (about 1.5M input and
  0.57M output tokens) and about 1,300 Decisions calls (about 1M input
  tokens, no output tokens).
- Cost. OpenAI costs API, read 2026-11-27 05:34 UTC: $12.27 billed so far for the UTC day of 2026-11-27, which holds every paid run of this evening (addenda 3 and 4 and the unrelated crisis and voice runs made at the same time), and $17.40 for 2026-11-26. The API reports by UTC day and does not break spend out per run.
