// runMigration.js
// Script to run database migrations

import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('\n🔄 Starting database migration to 3NF schema...\n');

    // Read and execute the migration SQL
    const migrationPath = path.join(__dirname, '../migrations', '003_normalize_schema.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    console.log('Executing migration script...');
    await client.query(migrationSQL);

    console.log('\nMigration completed successfully!\n');
    console.log('New tables created:');
    console.log('  - therapy_sessions');
    console.log('  - session_configurations');
    console.log('  - messages');
    console.log('  - user_sessions\n');

    console.log('Note: The conversation_logs table remains unchanged for historical data.\n');

    // Verify tables were created
    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('therapy_sessions', 'session_configurations', 'messages', 'user_sessions')
      ORDER BY table_name
    `);

    console.log('Verified tables:');
    tablesResult.rows.forEach(row => {
      console.log(`  ${row.table_name}`);
    });
    console.log();

  } catch (error) {
    console.error('\nMigration failed:', error.message);
    console.error('\nYou can rollback using: node rollbackMigration.js\n');
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
