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

## How to add content
1. Add vetted objects to `psychoeducation.seed.json`
   (`{ topic, title, content, source, source_url, license }`).
2. Run migration 031 if not already applied.
3. `npx tsx src/database/scripts/ingestKnowledge.js` (idempotent by content hash).
4. Keep `retrieve_psychoeducation` in the admin **disabled_tools** kill switch
   until the corpus is vetted + ingested; enable it from System Config after.
