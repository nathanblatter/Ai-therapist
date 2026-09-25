// Participant simulation — phase 3b: run the explicit eval + embedding paths the
// chat /end route skips, so evals.csv and semantic_metrics.csv populate for the
// export. Auto-eval is env-gated (EVALS_ENABLED) and never called from /end;
// evaluateSession() is the explicit path that works everywhere. Embeddings are
// populated by the sweep. Run AFTER sessions finish (order vs backdate doesn't
// matter — these write eval/embedding rows, backdate re-times them).
import 'dotenv/config';
process.env.NODE_ENV = 'test';

async function main() {
  const { pool } = await import('../../src/server/config/db.js');
  const { evaluateSession } = await import('../../src/server/services/sessionEval.service.js');
  const { sweepMessageEmbeddings } = await import('../../src/server/services/messageEmbedding.service.js');

  const uid = (await pool.query("SELECT userid FROM users WHERE username='sim_participant'")).rows[0].userid;
  const sessions = (await pool.query(
    'SELECT session_id FROM therapy_sessions WHERE user_id=$1 ORDER BY created_at', [uid])).rows;

  console.log(`Evaluating ${sessions.length} sessions (LLM judge)...`);
  for (const [i, s] of sessions.entries()) {
    try {
      const r = await evaluateSession(s.session_id);
      console.log(`  [${i + 1}/${sessions.length}] ${s.session_id.slice(0, 22)} -> ${r ? 'eval ok' : 'no eval'}`);
    } catch (err) {
      console.log(`  [${i + 1}/${sessions.length}] ${s.session_id.slice(0, 22)} -> EVAL ERROR: ${(err as Error).message}`);
    }
  }

  console.log('\nSweeping message embeddings...');
  let total = 0;
  for (;;) {
    const { embedded } = await sweepMessageEmbeddings(200);
    total += embedded;
    if (embedded === 0) break;
    console.log(`  embedded ${total} so far...`);
  }
  console.log(`Embeddings done (${total} turns).`);

  const evals = (await pool.query('SELECT count(*) FROM session_evals')).rows[0].count;
  console.log(`\nsession_evals rows: ${evals}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
