import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../../server/config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollbackMigration() {
  const client = await pool.connect();

  try {
    console.log('Rolling back migration 018: Remove Room Assignment System...');

    // Read the rollback SQL file
    const rollbackSQL = fs.readFileSync(
      path.join(__dirname, '../migrations/018_add_room_assignments_rollback.sql'),
      'utf8'
    );

    // Execute the rollback
    await client.query('BEGIN');
    await client.query(rollbackSQL);
    await client.query('COMMIT');

    console.log('✅ Migration 018 rolled back successfully!');
    console.log('Room assignments and queue tables removed');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Rollback of migration 018 failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

rollbackMigration();
