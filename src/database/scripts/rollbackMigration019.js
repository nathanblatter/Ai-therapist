import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../../server/config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollbackMigration() {
  const client = await pool.connect();

  try {
    console.log('Rolling back migration 019: Remove System Prompts Configuration...');

    // Read the rollback SQL file
    const rollbackSQL = fs.readFileSync(
      path.join(__dirname, '../migrations/019_add_system_prompts_rollback.sql'),
      'utf8'
    );

    // Execute the rollback
    await client.query('BEGIN');
    await client.query(rollbackSQL);
    await client.query('COMMIT');

    console.log('✅ Migration 019 rolled back successfully!');
    console.log('System prompts configuration removed from system_config table');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Rollback of migration 019 failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

rollbackMigration();
