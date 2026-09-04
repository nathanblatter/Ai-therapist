# Redaction signal-retention check — 2026-09-04

Sample: 46 recent user/assistant messages with raw content still
inside the retention window (non-demo, non-sandbox). No message text appears in
this report.

## Semantic retention (embedding cosine similarity, raw vs redacted)
- mean: 1.0000
- p10: 1.0000  median: 1.0000  p90: 1.0000
- pairs below 0.85: 0 (0.0%)

## Affect-lexicon retention
- messages containing affect terms: 21
- mean fraction of affect terms surviving redaction: 100.0%

## Length ratio (redacted/raw)
- mean: 1.000

## Flagged (similarity < 0.85 — inspect in admin transcript view while raw text survives)
- none

Interpretation guide: redaction replaces PHI spans only, so cosine similarity
should sit near 1.0 and affect retention near 100%. If either drops materially,
tune the redaction prompt (never the retention policy) before Phase 2 launch.
