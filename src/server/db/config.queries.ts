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
export type {
  VoiceOption,
  VoicesConfig,
  LanguageOption,
  LanguagesConfig,
} from '../../shared/systemConfig.js';

/** Fetch every row from the system_config key/value table. */
export async function fetchSystemConfigRows(): Promise<SystemConfigRow[]> {
  const result = await pool.query<SystemConfigRow>(
    'SELECT config_key, config_value FROM system_config'
  );
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
  const result = await pool.query<SystemConfigFullRow>(
    'SELECT * FROM system_config ORDER BY config_key'
  );
  return result.rows;
}

/** A single config row by key, or null if it doesn't exist. */
export async function getSystemConfigByKey(key: string): Promise<SystemConfigFullRow | null> {
  const result = await pool.query<SystemConfigFullRow>(
    'SELECT * FROM system_config WHERE config_key = $1',
    [key]
  );
  return result.rows[0] ?? null;
}

/** Overwrite a config value (stamping updated_at/by); null if the key is absent. */
export async function updateSystemConfig(
  key: string,
  value: unknown,
  updatedBy: string | undefined
): Promise<SystemConfigFullRow | null> {
  const result = await pool.query<SystemConfigFullRow>(
    `UPDATE system_config
     SET config_value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
     WHERE config_key = $3
     RETURNING *`,
    [JSON.stringify(value), updatedBy, key]
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
  description: string | null = null
): Promise<SystemConfigFullRow> {
  const result = await pool.query<SystemConfigFullRow>(
    `INSERT INTO system_config (config_key, config_value, description, updated_at, updated_by)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
     ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value,
           updated_at = CURRENT_TIMESTAMP,
           updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [key, JSON.stringify(value), description, updatedBy]
  );
  return result.rows[0];
}
