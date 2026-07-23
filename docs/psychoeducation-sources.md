# Psychoeducation knowledge base — sources & vetting

The `retrieve_psychoeducation` tool grounds the model in a curated corpus
(`knowledge_chunks`, loaded from `src/database/seeds/psychoeducation.seed.json`).
**Every passage must be vetted before ingest.** Retrieval does not make content
true — it makes the model quote it confidently. For a therapy research study,
corpus quality is a clinical-accuracy, IRB, and liability matter, not just a
quality-of-answer one.

## Vetting checklist (per passage)
- [ ] Source is reputable and evidence-based (gov health body, peer-reviewed, or established clinical org).
- [ ] Licensing permits storage + reuse (public domain, CC, or explicit permission).
- [ ] Content is accurate and current; no dosing/medical directives beyond general education.
- [ ] `source` + `source_url` are correct so the model can attribute.
- [ ] No content that could substitute for individualized clinical judgment.

## Currently seeded (safe to use)
- **National Institute of Mental Health (NIMH)** — U.S. government, **public domain**
  ("may be reused or copied without permission"). Seed passages on depression,
  generalized anxiety disorder, and self-care/coping are adapted from:
  - https://www.nimh.nih.gov/health/publications/depression
  - https://www.nimh.nih.gov/health/publications/generalized-anxiety-disorder-gad
  - https://www.nimh.nih.gov/health/topics/caring-for-your-mental-health

## Candidate sources to vet & add (not yet ingested)
Reputable, but confirm licensing before copying text into the seed file. Prefer
linking + short excerpts over wholesale copying for anything not public-domain/CC.
- **SAMHSA** (samhsa.gov) — U.S. gov, public domain. Crisis, substance use, coping.
- **NICE guidelines** (nice.org.uk) — UK; evidence-based, but check reuse terms.
- **Cochrane plain-language summaries** (cochranelibrary.com) — peer-reviewed
  syntheses; many summaries are CC-BY-NC. Excellent "does X work?" grounding.
- **Centre for Clinical Interventions (CCI)** (cci.health.wa.gov.au) — free,
  widely used CBT psychoeducation modules; confirm their reuse terms.
- **Open-access peer-reviewed articles** (PMC / open-access journals) — cite the
  DOI; only excerpt what the license allows.

## Worksheets & techniques corpora (also vet)
Two more seed files feed the `find_worksheet` and `suggest_modality_technique`
tools and follow the same table + vetting rules:
- `worksheets.seed.json` (`kind='worksheet'`) — exercise scaffolds that map to an
  on-screen render tool via `metadata.render_tool` (`start_thought_record` or
  `show_journaling_prompt`). These are standard clinical exercise *descriptions*,
  not copied copyrighted worksheets.
- `techniques.seed.json` (`kind='technique'`, `modality` = cbt/act/mi/null) —
  brief descriptions of standard techniques, tagged to a therapeutic approach.
  CBT/ACT sourced from NIMH public-domain material; MI attributed to Miller &
  Rollnick as the standard approach (description only). Vet clinical accuracy +
  attribution before relying on them.

## Approval workflow (per-chunk gating)
Every chunk has an `active` flag. Retrieval only returns `active = true` chunks,
so content can sit embedded-but-gated until it clears review — approve as much as
gets signed off, leave the rest pending.

- The **baseline** seed files (`psychoeducation/worksheets/techniques.seed.json`)
  ingest as **active**.
- The **`*_expansion.seed.json`** files ingest as **pending** (`active:false`).
- Re-running ingest never un-approves a chunk you've already approved.

Check status / approve:
```
npx tsx src/database/scripts/approveKnowledge.js                 # list active vs pending
npx tsx src/database/scripts/approveKnowledge.js --topic ptsd    # approve one topic
npx tsx src/database/scripts/approveKnowledge.js --kind worksheet
npx tsx src/database/scripts/approveKnowledge.js --all           # approve everything pending
```

## How to add content
1. Add objects to a seed file (`{ topic, title, content, source, source_url,
   license, kind?, modality?, metadata?, active? }`). New/unreviewed content goes
   in a `*_expansion.seed.json` file so it defaults to pending.
2. Run migrations 031 + 032 if not already applied.
3. `npx tsx src/database/scripts/ingestKnowledge.js` (idempotent by content hash).
4. Vet, then approve with `approveKnowledge.js`. Leave the four RAG tools enabled;
   the `active` flag — not the kill switch — is what gates individual content.
