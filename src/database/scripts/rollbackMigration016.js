import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../../server/config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollbackMigration() {
  const client = await pool.connect();

  try {
    console.log('Starting rollback of migration 016: Remove MFA Support...');

    // Read the rollback SQL file
    const rollbackSQL = fs.readFileSync(
      path.join(__dirname, '../migrations/016_add_mfa_support_rollback.sql'),
      'utf8'
    );

    // Execute the rollback
    await client.query('BEGIN');
    await client.query(rollbackSQL);
    await client.query('COMMIT');

    console.log('✅ Migration 016 rolled back successfully!');
    console.log('MFA columns removed from users table');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Rollback of migration 016 failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

rollbackMigration();
