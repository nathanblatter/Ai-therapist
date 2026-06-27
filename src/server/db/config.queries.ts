// Data-access for system configuration.
// Part of the db/ layer: this is the only place the system_config table is read.
import { pool } from '../config/db.js';

interface SystemConfigRow {
  config_key: string;
  config_value: unknown;
}

/** Fetch every row from the system_config key/value table. */
export async function fetchSystemConfigRows(): Promise<SystemConfigRow[]> {
  const result = await pool.query<SystemConfigRow>(
    'SELECT config_key, config_value FROM system_config'
  );
  return result.rows;
}
