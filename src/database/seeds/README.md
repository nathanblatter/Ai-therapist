# src/database/seeds

Seed corpora for the retrieval-augmented knowledge base (`knowledge_chunks`,
migrations 031 + 032). Each file is a JSON array of chunks; nothing in this
folder is read at runtime. The only consumer is the ingest script:

```sh
npx tsx src/database/scripts/ingestKnowledge.js     # needs DATABASE_URL + OPENAI_API_KEY
```

`ingestKnowledge.js` holds the file list (`SEED_FILES`) and, for each file,
the chunk `kind` and the default approval state. Verify with
`grep -n "seed.json" src/database/scripts/ingestKnowledge.js` before relying
on this table; the loader is the source of truth.

| File | kind | Ingested as |
|---|---|---|
| `psychoeducation.seed.json` | psychoeducation | active (live immediately) |
| `worksheets.seed.json` | worksheet | active |
| `techniques.seed.json` | technique | active |
| `psychoeducation_expansion.seed.json` | psychoeducation | pending (`active: false`) |
| `psychoeducation_expansion2.seed.json` | psychoeducation | pending |
| `worksheets_expansion.seed.json` | worksheet | pending |
| `techniques_expansion.seed.json` | technique | pending |

## How the `*_expansion*` files get in

1. Add or edit chunks in the expansion file. Each chunk needs `content` and
   `source`; optional `topic`, `title`, `source_url`, `license`, and per-chunk
   `kind` / `active` overrides.
2. Run `ingestKnowledge.js`. It embeds every chunk with
   `text-embedding-3-small` and upserts by `content_hash`, so re-running is
   safe: unchanged passages are updated in place, edited passages are
   re-embedded, and an already-approved chunk is never flipped back to
   pending.
3. Expansion chunks land as pending and are invisible to retrieval until a
   reviewer approves them:

   ```sh
   npx tsx src/database/scripts/approveKnowledge.js                   # status + pending list
   npx tsx src/database/scripts/approveKnowledge.js --all --dry-run   # preview
   npx tsx src/database/scripts/approveKnowledge.js --all --by <name> --note "batch 3"
   ```

   The review criteria and audit expectations are in
   `docs/rag-approval-review.md`; source provenance for the psychoeducation
   material is in `docs/psychoeducation-sources.md`.

Adding a new seed file means adding it to `SEED_FILES` in the loader as well;
a file that is not listed there is never ingested.
