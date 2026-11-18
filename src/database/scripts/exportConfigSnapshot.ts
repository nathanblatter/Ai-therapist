// Export this database's evaluated configuration (the system_config subset
// in src/server/utils/evaluatedConfig.ts) as a snapshot file for
// `npm run redteam:full -- --config-snapshot <file>`.
//
// Usage:
//   npm run config:snapshot -- [--out <file>] [--environment <label>]
//
// Read-only: one SELECT on system_config. The snapshot contains configuration
// only (prompts, model ids, crisis settings, the prompt-affecting feature
// flags); no participant, session or account data. It does contain the full
// system prompts, so treat the file like the prompts themselves and do not
// commit it or attach it to a public CI run.
import fs from 'node:fs';
import { pool } from '../../server/config/db.js';
import { exportConfigSnapshot } from '../../server/services/configEvaluation.service.js';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const out = getArg('--out');
  const environment = getArg('--environment') ?? null;
  const snapshot = await exportConfigSnapshot(environment);
  const json = JSON.stringify(snapshot, null, 2) + '\n';
  if (out) {
    fs.writeFileSync(out, json, { mode: 0o600 });
    console.error(`[config-snapshot] wrote ${out} (fingerprint ${snapshot.fingerprint.slice(0, 12)})`);
  } else {
    process.stdout.write(json);
  }
}

main()
  .catch((err) => {
    console.error(`[config-snapshot] ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
