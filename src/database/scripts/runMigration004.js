// runMigration004.js
// Script to change session_id from UUID to TEXT

import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('\n🔄 Starting migration 004: Change session_id to TEXT...\n');

    // Read and execute the migration SQL
    const migrationPath = path.join(__dirname, '../migrations', '004_change_session_id_to_text.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    console.log('📝 Executing migration script...');
    await client.query(migrationSQL);

    console.log('\n✅ Migration completed successfully!\n');
    console.log('Changes applied:');
    console.log('  - session_id column changed from UUID to TEXT');
    console.log('  - Foreign key constraints recreated');
    console.log('  - Now supports external session IDs (e.g., GPT realtime)\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error('\nYou can rollback using a custom rollback script if needed.\n');
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
