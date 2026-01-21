import { pool } from '../../server/config/db.js';

async function addClientLoggingConfig() {
  try {
    console.log('Adding client_logging config to system_config...');

    await pool.query(
      `INSERT INTO system_config (config_key, config_value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (config_key) DO NOTHING`,
      ['client_logging', JSON.stringify({ enabled: false }), 'Enable client-side console logging for debugging']
    );

    console.log('Client logging config added successfully');
    console.log('Default value: enabled = false');

    process.exit(0);
  } catch (error) {
    console.error('Failed to add client logging config:', error);
    process.exit(1);
  }
}

addClientLoggingConfig();
