import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../../server/config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('Starting migration 017: Update Voice and Language Configuration...');

    // Read the migration SQL file
    const migrationSQL = fs.readFileSync(
      path.join(__dirname, '../migrations/017_update_voice_language_config.sql'),
      'utf8'
    );

    // Execute the migration
    await client.query('BEGIN');
    await client.query(migrationSQL);
    await client.query('COMMIT');

    console.log('✅ Migration 017 completed successfully!');
    console.log('Voice and language configurations updated to use rich metadata');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 017 failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
