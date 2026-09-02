// Safe Harbor redaction evidence generator (ai-therapist-150 follow-up).
// Runs a fixed battery of synthetic messages seeded with each of the 18 HIPAA
// Safe Harbor identifier categories through the ACTUAL production batch
// redactor (redactPHIBatch — the anchored, retry+fallback version), then
// checks that (a) every planted identifier is gone from the output and (b) the
// batch shape is preserved 1:1. Produces docs/redaction-evidence-<date>.md as
// fresh IRB evidence that the pipeline works after the batch-mismatch fix.
//
// No DB, no participant data — purely synthetic strings. Needs OPENAI_API_KEY.
// The service is TypeScript, so run through tsx:
//   OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/redaction-evidence.mjs
import { redactPHIBatch } from '../src/server/services/redaction.service.js';

// Each case: a message, the planted PHI substrings that MUST NOT survive, and
// the Safe Harbor category it exercises. Synthetic — no real person.
const CASES = [
  { cat: '1. Names', text: 'Hi, my name is Jonathan Reyes and my sister is Maria Reyes.', phi: ['Jonathan Reyes', 'Maria Reyes'] },
  { cat: '2. Geographic', text: 'I live at 448 Oak Street, Provo, Utah 84604.', phi: ['448 Oak Street', 'Provo', '84604'] },
  { cat: '3. Dates', text: 'I was born on March 14, 1998 and admitted on 06/02/2026.', phi: ['March 14, 1998', '06/02/2026'] },
  { cat: '4. Telephone', text: 'You can call me at (801) 555-0148 any time.', phi: ['801) 555-0148'] },
  { cat: '5. Fax', text: 'Send the form to our fax at 801-555-0199.', phi: ['801-555-0199'] },
  { cat: '6. Email', text: 'My email is jon.reyes47@gmail.com if you need it.', phi: ['jon.reyes47@gmail.com'] },
  { cat: '7. SSN', text: 'My social security number is 528-19-4471.', phi: ['528-19-4471'] },
  { cat: '8. Medical record #', text: 'The clinic listed my MRN as 00847213 on the chart.', phi: ['00847213'] },
  { cat: '9. Health plan #', text: 'My insurance member ID is HPX9928374.', phi: ['HPX9928374'] },
  { cat: '10. Account #', text: 'The billing account number is 4471-2205-8890.', phi: ['4471-2205-8890'] },
  { cat: '11. License #', text: 'My driver license number is D19284756.', phi: ['D19284756'] },
  { cat: '12. Vehicle', text: 'My car plate is 7XKR221 here in Utah.', phi: ['7XKR221'] },
  { cat: '13. Device ID', text: 'My CPAP serial number is SN-4483-DEV-1190.', phi: ['SN-4483-DEV-1190'] },
  { cat: '14. URL', text: 'My blog is at https://jonreyeswellness.com/journal.', phi: ['jonreyeswellness.com'] },
  { cat: '15. IP address', text: 'The app logged my IP as 172.58.203.14 last night.', phi: ['172.58.203.14'] },
  { cat: '16-18. Other unique ID', text: 'My student ID at BYU is 09-338-2214 and everyone calls me by it.', phi: ['09-338-2214'] },
  // control: no PHI — the sentinel phrase must SURVIVE (over-redaction check)
  { cat: 'Control (no PHI)', text: 'I felt really anxious before my exam this week and could not sleep.', phi: [], mustKeep: 'anxious before my exam' },
];

function stamp() {
  // No Date.now in workflow scripts, but this is a plain node script — fine.
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const items = CASES.map((c, i) => ({ id: i, content: c.text }));
  const redactedMap = await redactPHIBatch(items);

  let leaks = 0;
  const rows = CASES.map((c, i) => {
    const out = redactedMap.get(i) ?? '';
    const survived = c.phi.filter((p) => out.includes(p));
    if (survived.length) leaks += survived.length;
    const keptOk = c.mustKeep ? out.includes(c.mustKeep) : true;
    return { ...c, out, survived, ok: survived.length === 0 && keptOk, keptOk };
  });

  const shapeOk = redactedMap.size === CASES.length;
  const planted = CASES.reduce((n, c) => n + c.phi.length, 0);
  const passed = rows.filter((r) => r.ok).length;

  const md = [
    `# Redaction Pipeline — Safe Harbor Evidence`,
    ``,
    `**Generated:** ${stamp()}  `,
    `**Redactor:** \`redactPHIBatch\` (src/server/services/redaction.service.ts) — the`,
    `production per-session batch redactor, dual-pass, index-anchored with retry`,
    `and per-item fallback (ai-therapist-150 fix).  `,
    `**Method:** ${CASES.length} synthetic messages (no real participant data), each`,
    `seeded with substrings from the HIPAA Safe Harbor identifier categories`,
    `(categories 16 biometric and 17 photographic are not expressible as text`,
    `substrings and are exercised only via the category-18 catch-all), run`,
    `through the redactor in one batch. Pass criterion: none of the planted`,
    `identifier substrings appear VERBATIM in the output (a substring check —`,
    `it cannot detect a paraphrased leak; the verbatim outputs below are`,
    `included so a human reviewer can confirm none occurred), and the no-PHI`,
    `control sentence survives un-redacted (over-redaction check).`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Result |`,
    `| --- | --- |`,
    `| Categories exercised | ${CASES.length - 1} identifier cases + 1 control |`,
    `| Planted identifiers | ${planted} |`,
    `| Identifiers still present after redaction | ${leaks} |`,
    `| Cases fully redacted | ${passed} / ${CASES.length} |`,
    `| Batch shape preserved (items in = items out) | ${shapeOk ? 'yes' : 'NO'} |`,
    ``,
    `## Per-category results`,
    ``,
    `| Category | Planted | Survived | Result |`,
    `| --- | --- | --- | --- |`,
    ...rows.map(
      (r) =>
        `| ${r.cat} | ${r.phi.length} | ${r.survived.length ? r.survived.join('; ') : '—'} | ${r.ok ? 'redacted' : 'LEAK'} |`
    ),
    ``,
    `## Redacted output (verbatim)`,
    ``,
    `Synthetic inputs and their redacted forms, to show placeholder behavior and`,
    `that non-PHI clinical content is preserved:`,
    ``,
    ...rows.flatMap((r) => [
      `**${r.cat}**  `,
      `- in:  ${r.text}  `,
      `- out: ${r.out}`,
      ``,
    ]),
    `---`,
    `Reproduce: \`OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/redaction-evidence.mjs\``,
    ``,
  ].join('\n');

  const outPath = `docs/redaction-evidence-${stamp()}.md`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outPath, md);
  console.log(`\nPlanted ${planted}, survived ${leaks}, cases passed ${passed}/${CASES.length}, shape ${shapeOk ? 'ok' : 'BROKEN'}`);
  console.log(`wrote ${outPath}`);
  if (leaks > 0 || !shapeOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error('redaction-evidence failed:', err);
  process.exit(1);
});
