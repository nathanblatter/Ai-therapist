// runMigration005.js
// Script to add language column to session_configurations

import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('\n🔄 Starting migration 005: Add language to session_configurations...\n');

    // Read and execute the migration SQL
    const migrationPath = path.join(__dirname, '../migrations', '005_add_language_to_session_config.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    console.log('📝 Executing migration script...');
    await client.query(migrationSQL);

    console.log('\n✅ Migration completed successfully!\n');
    console.log('Changes applied:');
    console.log('  - Added language column to session_configurations');
    console.log('  - Default value: "en" (English)');
    console.log('  - Enables tracking language preferences for sessions\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error('\nYou can rollback using: node migrations/rollbackMigration005.js\n');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migration
runMigration()
  .then(() => {
    console.log('Migration process completed.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration process failed:', error);
    process.exit(1);
  });
