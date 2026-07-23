import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('Running migration 030: Bump to latest realtime + transcription models...');

    const sql = fs.readFileSync(
      path.join(__dirname, '../migrations/030_bump_models.sql'),
      'utf8'
    );

    await client.query(sql);

    const { rows } = await client.query(
      `SELECT config_key, config_value FROM system_config WHERE config_key IN ('ai_model', 'transcription_model') ORDER BY config_key`
    );
    rows.forEach(r => console.log(`  ${r.config_key}: ${JSON.stringify(r.config_value)}`));

    console.log('Migration 030 completed successfully!');
  } catch (err) {
    console.error('Migration 030 failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(console.error);
