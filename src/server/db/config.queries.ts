// Data-access for system configuration.
// Part of the db/ layer: this is the only place the system_config table is read.
import { pool } from '../config/db.js';

export interface SystemConfigRow {
  config_key: string;
  config_value: unknown;
}

// The voices/languages config blob shapes live in src/shared/systemConfig.ts
// (single source of truth for server + UIs); re-exported here so existing
// importers of config.queries / the db barrel keep working.
export type { VoiceOption, VoicesConfig, LanguageOption, LanguagesConfig } from '../../shared/systemConfig.js';

/** Fetch every row from the system_config key/value table. */
export async function fetchSystemConfigRows(): Promise<SystemConfigRow[]> {
  const result = await pool.query<SystemConfigRow>('SELECT config_key, config_value FROM system_config');
  return result.rows;
}

// A full system_config row, including the audit columns the admin UI displays.
export interface SystemConfigFullRow {
  config_key: string;
  config_value: unknown;
  description: string | null;
  updated_at: Date | string | null;
  updated_by: string | null;
}

/** Every config row with its audit metadata, ordered by key (admin view). */
export async function getAllSystemConfig(): Promise<SystemConfigFullRow[]> {
  const result = await pool.query<SystemConfigFullRow>('SELECT * FROM system_config ORDER BY config_key');
  return result.rows;
}

/** A single config row by key, or null if it doesn't exist. */
export async function getSystemConfigByKey(key: string): Promise<SystemConfigFullRow | null> {
  const result = await pool.query<SystemConfigFullRow>('SELECT * FROM system_config WHERE config_key = $1', [key]);
  return result.rows[0] ?? null;
}

/** Overwrite a config value (stamping updated_at/by); null if the key is absent. */
export async function updateSystemConfig(
  key: string,
  value: unknown,
  updatedBy: string | undefined,
): Promise<SystemConfigFullRow | null> {
  const result = await pool.query<SystemConfigFullRow>(
    `UPDATE system_config
     SET config_value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
     WHERE config_key = $3
     RETURNING *`,
    [JSON.stringify(value), updatedBy, key],
  );
  return result.rows[0] ?? null;
}

/**
 * Write a config value, creating the row when it does not exist yet
 * (ai-therapist-275). On insert the row takes `description`; on update the
 * existing description is kept so a seeded explanation is never overwritten
 * by an admin save. Callers decide which keys may be created: the admin PUT
 * gates this behind its allowlist and keeps updateSystemConfig for the rest.
 */
export async function upsertSystemConfig(
  key: string,
  value: unknown,
  updatedBy: string | undefined,
  description: string | null = null,
): Promise<SystemConfigFullRow> {
  const result = await pool.query<SystemConfigFullRow>(
    `INSERT INTO system_config (config_key, config_value, description, updated_at, updated_by)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
     ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value,
           updated_at = CURRENT_TIMESTAMP,
           updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [key, JSON.stringify(value), description, updatedBy],
  );
  return result.rows[0];
}

/** system_config.features flag that moves the admin assistant onto the OpenAI
 *  Agents API backend (docs/agents-api-evaluation.md). Guarded: see below. */
export const ASSISTANT_AGENTS_API_FLAG = 'assistant_agents_api_enabled';

/**
 * Flags inside `features` that a save of the whole `features` object can never
 * change. The admin screen saves that object as it was when the tab loaded, so
 * without this a tab opened while a flag was on would switch it back on with
 * its next unrelated save. A guarded flag changes only through
 * setGuardedFeatureFlagAudited, which records who changed it.
 */
export const GUARDED_FEATURE_FLAGS: readonly string[] = [ASSISTANT_AGENTS_API_FLAG];

/**
 * Save the `features` object, keeping every guarded flag exactly as stored
 * (absent stays absent), whatever the incoming object says about it. One
 * statement, so a guarded flag changed a moment earlier cannot be overwritten
 * by a save that read the row before the change.
 */
export async function upsertFeaturesKeepingGuardedFlags(
  value: Record<string, unknown>,
  updatedBy: string | undefined,
  description: string | null = null,
): Promise<SystemConfigFullRow> {
  const result = await pool.query<SystemConfigFullRow>(
    `INSERT INTO system_config (config_key, config_value, description, updated_at, updated_by)
     VALUES ('features', $1::jsonb - $4::text[], $2, CURRENT_TIMESTAMP, $3)
     ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value || COALESCE(
             (SELECT jsonb_object_agg(g.flag, system_config.config_value -> g.flag)
                FROM unnest($4::text[]) AS g(flag)
               WHERE system_config.config_value ? g.flag),
             '{}'::jsonb),
           updated_at = CURRENT_TIMESTAMP,
           updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [JSON.stringify(value), description, updatedBy, GUARDED_FEATURE_FLAGS],
  );
  return result.rows[0];
}

export interface GuardedFlagChange {
  row: SystemConfigFullRow;
  /** The stored value before this call (null when the flag was absent). */
  previous: unknown;
  /** False when the flag already had the requested value: nothing was written. */
  changed: boolean;
}

/**
 * Turn one guarded `features` flag on or off and, in the same transaction,
 * append the audit row: who, when (the row's created_at), and the old and new
 * value. The row goes to data_access_log (action 'config_flag_change'), the
 * existing append-only log the Data access audit screen and the IRB packet
 * read, because these flags decide where staff questions and study data are
 * sent. If the audit row cannot be written the flag does not change.
 *
 * system_config has no organisation column: the flag, and so this change,
 * applies to every organisation on the server. The audit detail says so.
 */
export async function setGuardedFeatureFlagAudited(
  flag: string,
  enabled: boolean,
  actor: { userId: number | null; username: string | null; role: string | null },
  description: string | null = null,
): Promise<GuardedFlagChange> {
  if (!GUARDED_FEATURE_FLAGS.includes(flag)) throw new Error(`${flag} is not a guarded feature flag`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query<SystemConfigFullRow & { previous: unknown }>(
      `SELECT *, config_value -> $1 AS previous FROM system_config WHERE config_key = 'features' FOR UPDATE`,
      [flag],
    );
    const previous = before.rows[0]?.previous ?? null;
    if (before.rows[0] && previous === enabled) {
      await client.query('COMMIT');
      return { row: before.rows[0], previous, changed: false };
    }
    const updated = await client.query<SystemConfigFullRow>(
      `INSERT INTO system_config (config_key, config_value, description, updated_at, updated_by)
       VALUES ('features', jsonb_build_object($1::text, $2::boolean), $3, CURRENT_TIMESTAMP, $4)
       ON CONFLICT (config_key) DO UPDATE
         SET config_value = system_config.config_value || jsonb_build_object($1::text, $2::boolean),
             updated_at = CURRENT_TIMESTAMP,
             updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [flag, enabled, description, actor.username],
    );
    await client.query(
      `INSERT INTO data_access_log (accessed_by, role, action, detail)
       VALUES ($1, $2, 'config_flag_change', $3)`,
      [
        actor.userId,
        actor.role,
        JSON.stringify({
          key: `features.${flag}`,
          old: previous,
          new: enabled,
          actor_username: actor.username,
          scope: 'all organisations',
        }),
      ],
    );
    await client.query('COMMIT');
    return { row: updated.rows[0], previous, changed: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
