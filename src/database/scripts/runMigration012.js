// runMigration012.js
// Script to run database migration 012 - Add sideband connections

import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('\n🔄 Starting database migration 012 - Add sideband connection tracking...\n');

    // Read and execute the migration SQL
    const migrationPath = path.join(__dirname, '../migrations', '012_add_sideband_connections.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    console.log('Executing migration script...');
    await client.query(migrationSQL);

    console.log('\nMigration completed successfully!\n');
    console.log('Columns added to therapy_sessions:');
    console.log('  - openai_call_id');
    console.log('  - sideband_connected');
    console.log('  - sideband_connected_at');
    console.log('  - sideband_disconnected_at');
    console.log('  - sideband_error\n');

    // Verify columns were created
    const columnsResult = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'therapy_sessions'
        AND column_name IN ('openai_call_id', 'sideband_connected', 'sideband_connected_at', 'sideband_disconnected_at', 'sideband_error')
      ORDER BY column_name
    `);

    console.log('Verified columns:');
    columnsResult.rows.forEach(row => {
      console.log(`  ${row.column_name} (${row.data_type})`);
    });
    console.log();

    // Verify indexes were created
    const indexesResult = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'therapy_sessions'
        AND indexname IN ('idx_sessions_call_id', 'idx_sessions_sideband_connected')
      ORDER BY indexname
    `);

    console.log('Verified indexes:');
    indexesResult.rows.forEach(row => {
      console.log(`  ${row.indexname}`);
    });
    console.log();

  } catch (error) {
    console.error('\nMigration failed:', error.message);
    console.error('\nYou can rollback using: node src/database/scripts/rollbackMigration012.js\n');
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
