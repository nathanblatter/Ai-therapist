import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../../server/config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('Starting migration 016: Add MFA Support...');

    // Read the migration SQL file
    const migrationSQL = fs.readFileSync(
      path.join(__dirname, '../migrations/016_add_mfa_support.sql'),
      'utf8'
    );

    // Execute the migration
    await client.query('BEGIN');
    await client.query(migrationSQL);
    await client.query('COMMIT');

    console.log('✅ Migration 016 completed successfully!');
    console.log('MFA columns added to users table');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 016 failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
