# RAG knowledge-base approval review (ai-therapist-77)

**Status as of this review (verified against the live app DB, 2026-07-30): there is nothing pending.**
All 82 rows in `knowledge_chunks` — 40 psychoeducation, 27 technique, 15 worksheet —
are `active = true`. `npx tsx src/database/scripts/approveKnowledge.js` (read-only,
no flags) confirms this:

```
Knowledge base status (active / pending):
  psychoeducation: 40 active, 0 pending
  technique: 27 active, 0 pending
  worksheet: 15 active, 0 pending

Nothing pending.
```

**This is the headline finding, and it needs Nathan's attention before anything
else in this doc.** The flightdeck task describes "50 pending RAG chunks
(active:false) awaiting human/IRB signoff." The `*_expansion.seed.json` files
that `ingestKnowledge.js` marks `defaultActive: false` (see
`src/database/scripts/ingestKnowledge.js`) total exactly 61 chunks
(19 + 11 psychoeducation-expansion, 20 technique-expansion, 11
worksheet-expansion) — matching the gap between the 4 baseline seed files
(10 + 4 + 7 = 21 chunks) and the current 82 active rows. **The numbers line up
perfectly with "someone ran `approveKnowledge.js --all`"** (or every chunk was
individually approved) at some point — every expansion chunk is now live and
retrievable by `retrieve_psychoeducation`, `find_worksheet`, and
`suggest_modality_technique` in production sessions.

There is no per-chunk approval timestamp or approver identity in the schema
(`knowledge_chunks` has no `approved_at`/`approved_by` column — see migration
031/032), and every row shares one `created_at` (2026-07-22), so there's no way
to reconstruct from the DB alone whether this was a deliberate bulk sign-off or
an accidental `--all` run during testing/ingest. **Per my instructions I did
not approve or modify anything** — this doc is a retroactive per-topic
provenance + clinical-safety pass over what's already live, so Nathan can
either (a) confirm the bulk approval was intentional and this doc closes the
loop, or (b) treat specific groups below as needing a real look and manually
flip them back with `UPDATE knowledge_chunks SET active = false WHERE ...`
(there's no "set inactive" helper in `approveKnowledge.js` today — see the UX
note at the bottom).

## Method

- Read `docs/psychoeducation-sources.md` (the vetting checklist + declared
  sources) and the seed files (`src/database/seeds/*.seed.json`).
- Queried the live app DB (`ai_therapist`, via the running `ai-therapist-app`
  container's `DATABASE_URL`) for the actual ingested rows, grouped by
  `kind`/`topic`/`source`/`source_url`.
- Spot-checked full `content` text for a sample of higher-sensitivity topics
  (PTSD, bipolar, OCD/ERP, exposure hierarchy) rather than trusting titles alone.
- Did **not** run `ingestKnowledge.js` or any write path, and did not call
  `approveKnowledgeChunks()`.

## Provenance summary (all 82 active chunks)

| Source | Kind(s) | Count | License basis |
|---|---|---|---|
| National Institute of Mental Health (NIMH), nimh.nih.gov | psychoeducation, technique, worksheet | ~55 | U.S. government work — explicitly public domain, reuse permitted without permission (per NIMH's own site policy, cited in `docs/psychoeducation-sources.md`) |
| "Standard clinical technique/exercise" (CBT, DBT, ACT, MI, mindfulness, self-compassion, positive psychology — generic, no `source_url`) | technique, worksheet | ~27 | Not copied from a specific copyrighted work — these are original short descriptions of well-established, named clinical modalities/techniques (e.g. "Dialectical behavior therapy — pros and cons," "Cognitive behavioral therapy — thought record"), the same way a textbook glossary would describe them. Attribution is to the modality/originators (e.g. "Motivational interviewing (Miller & Rollnick)"), not to a scraped source. |

**No content from SAMHSA, NICE, Cochrane, CCI, or PMC/open-access journals is in
the live DB** — the "candidate sources to vet" section of
`docs/psychoeducation-sources.md` was never acted on. All ingested content
matches the "currently seeded (safe to use)" NIMH sourcing the doc already
signs off on, plus the generic technique/worksheet descriptions the doc
pre-approves in its "Worksheets & techniques corpora" section. **This is the
best-case outcome given the bulk approval** — nothing higher-risk slipped in
alongside it.

## Per-group review

### psychoeducation (40 chunks, 13 topics — all NIMH-sourced)

| Topic | Chunks | Source URL | Provenance | Clinical-safety notes | Recommendation |
|---|---|---|---|---|---|
| depression | 4 | nimh.nih.gov/health/publications/depression | Public domain (NIMH) | Descriptive, non-diagnostic, no dosing. Matches the doc's pre-approved baseline. | **Approve** (already matches originally-vetted source) |
| generalized anxiety (GAD) | 3 | .../generalized-anxiety-disorder-gad | Public domain (NIMH) | Same as above; baseline-vetted source. | **Approve** |
| stress / self-care | 3 | .../so-stressed-out-fact-sheet | Public domain (NIMH) | Coping-oriented, no clinical claims beyond NIMH's own fact sheet. | **Approve** |
| anxiety (general) | 3 | .../caring-for-your-mental-health | Public domain (NIMH) | General wellness framing. | **Approve** |
| PTSD | 4 | .../post-traumatic-stress-disorder-ptsd | Public domain (NIMH) | Spot-checked full text: describes symptom clusters (re-experiencing, avoidance, arousal/mood) and treatment (trauma-focused psychotherapy, SSRIs) in NIMH's own plain language. Appropriately descriptive, not directive; correctly notes SSRIs are FDA-approved rather than recommending a specific drug/dose. No content that could be mistaken for a crisis-response script (that's handled separately by `get_crisis_resources`/`show_resource_card`). | **Approve** — but see "Cross-cutting note on sensitive topics" below |
| OCD | 3 | .../obsessive-compulsive-disorder-when-unwanted-thoughts-take-over | Public domain (NIMH) | Spot-checked ERP description: correctly frames ERP as a *specific, well-supported form of CBT* administered in treatment, not a self-help instruction to "just expose yourself." Good — avoids the failure mode of an AI coaching someone through unsupervised exposure using this passage alone. | **Approve** |
| panic disorder | 3 | .../panic-disorder-when-fear-overwhelms | Public domain (NIMH) | Descriptive only. | **Approve** |
| social anxiety | 3 | .../social-anxiety-disorder-more-than-just-shyness | Public domain (NIMH) | Descriptive only. | **Approve** |
| bipolar disorder | 3 | .../bipolar-disorder | Public domain (NIMH) | Spot-checked: mentions lithium/valproate as *examples* of mood stabilizers in a treatment-overview sentence, not as a dosing directive. Low risk, but this is the one place in the corpus that names specific medications — worth Nathan's eyes given IRB scrutiny tends to focus on medication content. | **Approve, flag for IRB eyes** — no directive language, but it's the one chunk naming drug classes by name |
| BPD | 3 | .../borderline-personality-disorder | Public domain (NIMH) | Descriptive; no stigmatizing language beyond NIMH's own (which is written to reduce stigma). | **Approve** |
| ADHD | 3 | .../attention-deficit-hyperactivity-disorder-adhd | Public domain (NIMH) | Descriptive only. | **Approve** |
| substance use | 3 | .../substance-use-and-mental-health | Public domain (NIMH) | Frames co-occurring conditions; no dosing/harm-reduction directives (which would need more careful review). | **Approve** |
| eating disorders | 2 | .../eating-disorders | Public domain (NIMH) | Only 2 chunks (thinnest topic in the corpus) — descriptive only, no numeric targets (weight/BMI/calorie language), which is the main failure mode to watch for in this topic. | **Approve** |

### technique (27 chunks — grounds `suggest_modality_technique`)

Grouped by modality tag rather than individual chunk (titles are self-descriptive):

| Group | Chunks | Modality | Provenance | Notes | Recommendation |
|---|---|---|---|---|---|
| CBT techniques (thought record, cognitive distortions, etc.) | ~8 | cbt | NIMH + generic descriptions | Standard, descriptive. | **Approve** |
| DBT skills (distress tolerance, pros/cons, etc.) | 6 | dbt (untagged `modality`, since DEFAULT_MODALITY_PRESETS only has supportive/cbt/act/mi — see `sessionHelpers.ts`) | Generic clinical description | DBT skills are safe to *describe*; the risk would be prescribing them as a substitute for DBT's structural supports (diary cards, phone coaching) for someone in crisis — the tool's returned `guidance` string already tells the model to offer in "warm, plain language," not as a clinical protocol. | **Approve** |
| ACT techniques (defusion, values work) | 3 | act | NIMH + generic | Standard. | **Approve** |
| MI (motivational interviewing) | 4 | mi | Attributed to Miller & Rollnick, generic description | Correctly attributed as the originators of MI rather than copying their book text. | **Approve** |
| Mindfulness / self-compassion / positive psychology | ~6 | none/general | Generic + 1 NIMH-linked | Standard wellness techniques. | **Approve** |

### worksheet (15 chunks — grounds `find_worksheet`, hands off to `start_thought_record`/`show_journaling_prompt`)

| Group | Chunks | Provenance | Notes | Recommendation |
|---|---|---|---|---|
| CBT worksheets (thought record, cognitive distortions, worry management, exposure hierarchy, stimulus control) | 6 | NIMH-linked + generic | The exposure-hierarchy worksheet ("Fear ladder") is a *scaffold description* (list situations, rank by anxiety), not a therapist-led exposure protocol — matches the existing `start_fear_ladder` tool's own guardrails (only offers the *lowest* rung, only if the participant is willing). Consistent, low risk. | **Approve** |
| DBT (pros and cons) | 1 | Generic | Standard. | **Approve** |
| ACT (values clarification) | 1 | NIMH-linked | Standard. | **Approve** |
| Behavioral activation | 1 | NIMH-linked (depression) | Standard depression-treatment exercise description. | **Approve** |
| Self-compassion, expressive writing (×2), positive psychology (three good things), sleep hygiene, general coping | 6 | Generic + NIMH-linked | Standard wellness exercises. | **Approve** |

## Cross-cutting note on sensitive topics (PTSD, BPD, substance use, bipolar)

None of the spot-checked content instructs the *model* to do anything beyond
"summarize these passages... do NOT add clinical claims beyond what's shown"
(see the `retrieve_psychoeducation` tool's returned `guidance` string in
`src/server/services/toolRegistry.service.ts`) — the grounding/no-fabrication
guardrail is doing real work here regardless of which passages are active.
That's a structural mitigation, not a reason to skip per-passage review, but it
does mean the blast radius of any one questionable passage is bounded by that
guardrail plus the two-stage crisis-keyword/LLM pipeline running independently
on the participant's own words.

## Recommendation summary

Every group above reviews as **approve** on provenance (NIMH public-domain or
generic modality description, no unvetted third-party sources) and clinical-
safety grounds (descriptive, non-diagnostic, no dosing directives, no numeric
eating-disorder targets, exposure content correctly framed as gradual/
participant-led). **The one item that needs an actual decision from Nathan is
process, not content**: confirm whether the bulk approval that already
happened was intentional, and if IRB signoff is a hard requirement before
content goes live, consider adding the `approved_by`/`approved_at` audit
columns this table currently lacks so future approvals (and any future
`*_expansion` batches) leave a real trail instead of being indistinguishable
from an accidental `--all`.

## `approveKnowledge.js` UX

Added `--dry-run` (works with `--all`, `--kind`, `--topic`): prints what would
be approved without writing, so a reviewer can preview `--all`'s scope before
committing to it. Usage unchanged for everything else; see the script's header
comment.
