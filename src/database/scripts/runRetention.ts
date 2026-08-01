// Manual retention run CLI (ai-therapist-97). Thin wrapper over
// enforceRetention('manual', 'cli'); runs even when the scheduler is disabled.
//
//   npm run retention:run
import { pool } from '../../server/config/db.js';
import { enforceRetention } from '../../server/services/dataRetention.service.js';

async function main() {
  console.log('[Retention] manual run starting…');
  const result = await enforceRetention('manual', 'cli');
  console.log(
    `[Retention] run ${result.runId}: ${result.recordingsDeleted} aged-out, ` +
    `${result.graceDeleted} grace, ${result.failures} failures`
  );
  if (result.failures > 0) process.exitCode = 1;
}

main()
  .catch(err => {
    console.error('[Retention] fatal:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
