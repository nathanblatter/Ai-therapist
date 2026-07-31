// Approve pending knowledge-base content (make it retrievable). New content is
// ingested as pending (active:false); this flips chunks to active as they clear
// review. Run from the app container (or host with a localhost DATABASE_URL):
//
//   npx tsx src/database/scripts/approveKnowledge.js                 # show status + list pending (read-only, no DB write)
//   npx tsx src/database/scripts/approveKnowledge.js --kind worksheet
//   npx tsx src/database/scripts/approveKnowledge.js --topic ptsd
//   npx tsx src/database/scripts/approveKnowledge.js --all           # approve everything pending
//   npx tsx src/database/scripts/approveKnowledge.js --all --dry-run # preview what --all/--kind/--topic would approve, no write
import { pool } from '../../server/config/db.js';
import {
  approveKnowledgeChunks,
  getKnowledgeStatusCounts,
  previewPendingKnowledgeChunks,
} from '../../server/db/knowledge.queries.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? true) : undefined;
}

async function main() {
  const all = process.argv.includes('--all');
  const dryRun = process.argv.includes('--dry-run');
  const kind = arg('--kind');
  const topic = arg('--topic');

  if (!all && !kind && !topic) {
    // Status only (always read-only, regardless of --dry-run)
    const counts = await getKnowledgeStatusCounts();
    console.log('Knowledge base status (active / pending):');
    counts.forEach(c => console.log(`  ${c.kind}: ${c.active} active, ${c.pending} pending`));
    const pending = (await pool.query(
      `SELECT kind, topic, title FROM knowledge_chunks WHERE active IS NOT TRUE ORDER BY kind, topic, title`
    )).rows;
    if (pending.length) {
      console.log(`\nPending (${pending.length}):`);
      pending.forEach(p => console.log(`  [${p.kind}/${p.topic ?? '-'}] ${p.title}`));
      console.log('\nApprove with: --all | --kind <kind> | --topic <topic> (add --dry-run to preview first)');
    } else {
      console.log('\nNothing pending.');
    }
    return;
  }

  const filter = {
    kind: typeof kind === 'string' ? kind : null,
    topic: typeof topic === 'string' ? topic : null,
  };

  if (dryRun) {
    const rows = await previewPendingKnowledgeChunks(filter);
    if (rows.length === 0) {
      console.log(`[dry run] Nothing matches${kind ? ` kind=${kind}` : ''}${topic ? ` topic=${topic}` : ''} — 0 chunks would be approved.`);
      return;
    }
    console.log(`[dry run] Would approve ${rows.length} chunk(s)${kind ? ` kind=${kind}` : ''}${topic ? ` topic=${topic}` : ''}:`);
    rows.forEach(r => console.log(`  [${r.kind}/${r.topic ?? '-'}] ${r.title}`));
    console.log('\nNo changes written. Re-run without --dry-run to approve.');
    return;
  }

  const n = await approveKnowledgeChunks(filter);
  console.log(`Approved ${n} chunk(s)${kind ? ` kind=${kind}` : ''}${topic ? ` topic=${topic}` : ''}.`);
}

main().then(() => pool.end()).catch(e => { console.error(e); pool.end(); process.exit(1); });
