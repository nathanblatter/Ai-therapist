import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../../server/config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollbackMigration() {
  const client = await pool.connect();

  try {
    console.log('Starting rollback of migration 017: Revert Voice and Language Configuration...');

    // Read the rollback SQL file
    const rollbackSQL = fs.readFileSync(
      path.join(__dirname, '../migrations/017_update_voice_language_config_rollback.sql'),
      'utf8'
    );

    // Execute the rollback
    await client.query('BEGIN');
    await client.query(rollbackSQL);
    await client.query('COMMIT');

    console.log('✅ Migration 017 rolled back successfully!');
    console.log('Voice and language configurations reverted to simple array structure');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Rollback of migration 017 failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

rollbackMigration();
