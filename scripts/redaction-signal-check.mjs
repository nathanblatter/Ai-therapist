// Redaction signal-retention check (Phase 2 pre-launch sanity pass).
//
// Long-term research NLP runs on content_redacted only (raw content wipes
// after the retention window). Before Phase 2 data starts accruing, this
// script quantifies how much affective/clinical signal redaction preserves,
// using messages whose RAW content is still inside the wipe window:
//   (a) embedding cosine similarity raw <-> redacted (semantic retention)
//   (b) affect-lexicon term retention (did feeling-words survive redaction?)
//
// Reads real rows but writes NO participant text to the report — only
// aggregate numbers and flagged message IDs. Needs DATABASE_URL and
// OPENAI_API_KEY. TypeScript imports, so run through tsx:
//   DATABASE_URL=... OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/redaction-signal-check.mjs
import fs from 'node:fs';
import { pool } from '../src/server/config/db.js';
import { embedTextBatch } from '../src/server/services/embeddings.service.js';

const SAMPLE_LIMIT = Number(process.env.SIGNAL_CHECK_LIMIT || 200);

// Small affect lexicon — not a validated instrument, just a canary: these
// words carry the clinical signal analyses depend on and should essentially
// never be redacted (they are not PHI).
const AFFECT_TERMS = [
  'anxious', 'anxiety', 'sad', 'sadness', 'depressed', 'depression', 'stress',
  'stressed', 'worried', 'worry', 'afraid', 'fear', 'scared', 'angry', 'anger',
  'lonely', 'alone', 'hopeless', 'hopeful', 'hope', 'tired', 'exhausted',
  'overwhelmed', 'panic', 'calm', 'better', 'worse', 'happy', 'grateful',
  'cry', 'crying', 'sleep', 'hurt', 'pain', 'guilt', 'ashamed', 'shame',
];

function affectTerms(text) {
  const lower = ` ${text.toLowerCase()} `;
  return AFFECT_TERMS.filter(t => lower.includes(` ${t}`));
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const { rows } = await pool.query(
  `SELECT m.message_id, m.role, m.content, m.content_redacted
     FROM messages m
     JOIN therapy_sessions ts ON ts.session_id = m.session_id
     LEFT JOIN users u ON u.userid = ts.user_id
    WHERE m.content IS NOT NULL
      AND m.content_redacted IS NOT NULL
      AND length(trim(m.content)) > 20
      AND m.role IN ('user', 'assistant')
      AND u.is_sandbox IS NOT TRUE
      AND ts.is_demo IS NOT TRUE
    ORDER BY m.created_at DESC
    LIMIT $1`,
  [SAMPLE_LIMIT]
);

if (rows.length === 0) {
  console.log('No messages with both raw and redacted content in the window — run again after fresh (non-demo) sessions.');
  process.exit(0);
}

console.log(`Comparing ${rows.length} raw/redacted pairs...`);
const rawVecs = await embedTextBatch(rows.map(r => r.content));
const redVecs = await embedTextBatch(rows.map(r => r.content_redacted));

const results = rows.map((r, i) => {
  const sim = cosine(rawVecs[i], redVecs[i]);
  const rawTerms = affectTerms(r.content);
  const kept = rawTerms.filter(t => affectTerms(r.content_redacted).includes(t));
  return {
    id: r.message_id,
    role: r.role,
    sim,
    nAffectRaw: rawTerms.length,
    nAffectKept: kept.length,
    lengthRatio: r.content_redacted.length / r.content.length,
  };
});

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sims = results.map(r => r.sim).sort((a, b) => a - b);
const pct = p => sims[Math.min(sims.length - 1, Math.floor(p * sims.length))];
const withAffect = results.filter(r => r.nAffectRaw > 0);
const affectRetention = withAffect.length
  ? mean(withAffect.map(r => r.nAffectKept / r.nAffectRaw))
  : null;
const lowSim = results.filter(r => r.sim < 0.85);

const date = new Date().toISOString().slice(0, 10);
const report = `# Redaction signal-retention check — ${date}

Sample: ${results.length} recent user/assistant messages with raw content still
inside the retention window (non-demo, non-sandbox). No message text appears in
this report.

## Semantic retention (embedding cosine similarity, raw vs redacted)
- mean: ${mean(sims).toFixed(4)}
- p10: ${pct(0.10).toFixed(4)}  median: ${pct(0.5).toFixed(4)}  p90: ${pct(0.90).toFixed(4)}
- pairs below 0.85: ${lowSim.length} (${((lowSim.length / results.length) * 100).toFixed(1)}%)

## Affect-lexicon retention
- messages containing affect terms: ${withAffect.length}
- mean fraction of affect terms surviving redaction: ${affectRetention == null ? 'n/a' : (affectRetention * 100).toFixed(1) + '%'}

## Length ratio (redacted/raw)
- mean: ${mean(results.map(r => r.lengthRatio)).toFixed(3)}

## Flagged (similarity < 0.85 — inspect in admin transcript view while raw text survives)
${lowSim.length === 0 ? '- none' : lowSim.map(r => `- ${r.id} (role=${r.role}, sim=${r.sim.toFixed(3)}, affect kept ${r.nAffectKept}/${r.nAffectRaw})`).join('\n')}

Interpretation guide: redaction replaces PHI spans only, so cosine similarity
should sit near 1.0 and affect retention near 100%. If either drops materially,
tune the redaction prompt (never the retention policy) before Phase 2 launch.
`;

const outPath = `docs/redaction-signal-check-${date}.md`;
fs.writeFileSync(outPath, report);
console.log(report);
console.log(`Written to ${outPath}`);
await pool.end();
