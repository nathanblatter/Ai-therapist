// `--config-snapshot <file>`: run the harness against an environment's real
// evaluated configuration instead of the migration seeds.
//
// The file is produced by `npm run config:snapshot` or
// GET /admin/api/config-evaluation/snapshot (or handed out by the workflow's
// claim call); its shape, validation and fingerprint live in
// src/server/utils/evaluatedConfig.ts. Loading it WRITES system_config, unlike
// --variant (variants.ts, an in-process overlay), because it replaces many
// keys and the code reads several of them outside getSystemConfig(). So it is
// refused on any database that is not disposable: one that holds sessions of
// anyone but the red-team participant, or when the in-app runner
// (harnessRunner.service.ts, REDTEAM_TRIGGER) spawned this process against a
// live database.
//
// Composition with --variant: the snapshot is the base, a variant's feature
// overlay still applies on top in-process. The redteam-config workflow never
// passes --variant, so its runs evaluate the snapshot as is.
//
// After loading, the fingerprint is recomputed from the database rows and
// must equal the snapshot's; config-snapshot.json in --out records it so the
// run can be tied to the configuration it evaluated.
import fs from 'node:fs';
import path from 'node:path';
import type { DbLike } from './types.js';
import {
  EVALUATED_FEATURE_FIELDS,
  EVALUATED_SESSION_LIMIT_FIELDS,
  EVALUATED_WHOLE_KEYS,
  fingerprintConfigRows,
  parseConfigSnapshot,
  type ConfigRowLike,
  type ConfigSnapshot,
} from '../server/utils/evaluatedConfig.js';

const REDTEAM_PARTICIPANT = process.env.REDTEAM_PARTICIPANT_USER || 'redteam_participant';

/** session_limits quotas forced in the eval database so one red-team participant
 *  can run every scenario (not part of the evaluated configuration). */
const HARNESS_QUOTAS = { max_sessions_per_day: 1000, cooldown_minutes: 0 };

/** `--config-snapshot <file>` from argv (parsed here so cli.ts stays untouched
 *  apart from one call). Returns null when the flag is absent. */
export function configSnapshotArg(argv: readonly string[]): string | null {
  const i = argv.indexOf('--config-snapshot');
  if (i === -1) return null;
  const file = argv[i + 1];
  if (!file || file.startsWith('--')) throw new Error('--config-snapshot needs a file path');
  return file;
}

export function readConfigSnapshotFile(file: string): ConfigSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`config snapshot: cannot read ${file}: ${(err as Error).message}`);
  }
  return parseConfigSnapshot(parsed);
}

/** Refuse anything but a disposable eval database. */
export async function assertDisposableDatabase(db: DbLike, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.REDTEAM_TRIGGER) {
    throw new Error(
      '--config-snapshot is refused under the in-app harness runner (REDTEAM_TRIGGER is set): it would overwrite a live system_config',
    );
  }
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM therapy_sessions s
       LEFT JOIN users u ON u.userid = s.user_id
      WHERE u.username IS DISTINCT FROM $1`,
    [REDTEAM_PARTICIPANT],
  );
  const n = Number(rows[0]?.n ?? 0);
  if (n > 0) {
    throw new Error(
      `--config-snapshot refused: this database holds ${n} session(s) from accounts other than ${REDTEAM_PARTICIPANT}; ` +
        'it only loads into a disposable eval database (scripts/redteam-db-setup.sh)',
    );
  }
}

async function upsertKey(db: DbLike, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO system_config (config_key, config_value, description, updated_at, updated_by)
     VALUES ($1, $2::jsonb, 'loaded from config snapshot', CURRENT_TIMESTAMP, 'redteam-config-snapshot')
     ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value, updated_at = CURRENT_TIMESTAMP, updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value)],
  );
}

async function currentValue(db: DbLike, key: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query(`SELECT config_value FROM system_config WHERE config_key = $1`, [key]);
  const v = rows[0]?.config_value;
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

/** Replace the evaluated fields of a partially evaluated key, keeping the rest. */
function mergeFields(
  base: Record<string, unknown>,
  snapshotPart: Record<string, unknown> | null,
  fields: readonly string[],
): Record<string, unknown> {
  const out = { ...base };
  for (const f of fields) delete out[f];
  return { ...out, ...(snapshotPart ?? {}) };
}

/** Write the snapshot into system_config and prove the fingerprint round-trips. */
export async function applyConfigSnapshot(db: DbLike, snapshot: ConfigSnapshot): Promise<void> {
  for (const key of EVALUATED_WHOLE_KEYS) {
    const value = snapshot.config[key];
    // Absent on the environment = code default there; mirror that here.
    if (value === null || value === undefined) await db.query(`DELETE FROM system_config WHERE config_key = $1`, [key]);
    else await upsertKey(db, key, value);
  }
  const features = mergeFields(
    await currentValue(db, 'features'),
    snapshot.config.features as Record<string, unknown> | null,
    EVALUATED_FEATURE_FIELDS,
  );
  await upsertKey(db, 'features', features);
  const limits = mergeFields(
    await currentValue(db, 'session_limits'),
    snapshot.config.session_limits as Record<string, unknown> | null,
    EVALUATED_SESSION_LIMIT_FIELDS,
  );
  await upsertKey(db, 'session_limits', { ...limits, ...HARNESS_QUOTAS });

  const { rows } = await db.query(`SELECT config_key, config_value FROM system_config`);
  const loaded = fingerprintConfigRows(rows as unknown as ConfigRowLike[]);
  if (loaded !== snapshot.fingerprint) {
    throw new Error(
      `config snapshot: database fingerprint ${loaded.slice(0, 12)} != snapshot ${snapshot.fingerprint.slice(0, 12)} after loading`,
    );
  }
}

/**
 * The whole `--config-snapshot` step for cli.ts: no-op without the flag;
 * otherwise validate, guard, load, invalidate the server's config cache and
 * write config-snapshot.json into the results directory.
 */
export async function loadConfigSnapshotFromArgv(
  argv: readonly string[],
  db: DbLike,
  outDir: string,
): Promise<ConfigSnapshot | null> {
  const file = configSnapshotArg(argv);
  if (!file) return null;
  const snapshot = readConfigSnapshotFile(file);
  await assertDisposableDatabase(db);
  await applyConfigSnapshot(db, snapshot);
  const { invalidateConfigCache } = await import('../server/utils/sessionHelpers.js');
  invalidateConfigCache();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'config-snapshot.json'),
    JSON.stringify(
      {
        fingerprint: snapshot.fingerprint,
        version: snapshot.version,
        environment: snapshot.environment,
        exported_at: snapshot.exported_at,
        loaded_at: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `[redteam] config snapshot ${snapshot.fingerprint.slice(0, 12)} loaded (environment=${snapshot.environment ?? 'unknown'}, exported ${snapshot.exported_at})`,
  );
  return snapshot;
}
