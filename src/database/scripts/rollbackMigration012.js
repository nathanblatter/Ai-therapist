// rollbackMigration012.js
// Script to rollback database migration 012 - Remove sideband connections

import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollbackMigration() {
  const client = await pool.connect();

  try {
    console.log('\n⏪ Rolling back database migration 012 - Remove sideband connection tracking...\n');

    // Read and execute the rollback SQL
    const rollbackPath = path.join(__dirname, '../migrations', '012_add_sideband_connections_rollback.sql');
    const rollbackSQL = fs.readFileSync(rollbackPath, 'utf8');

    console.log('Executing rollback script...');
    await client.query(rollbackSQL);

    console.log('\nRollback completed successfully!\n');
    console.log('Removed columns from therapy_sessions:');
    console.log('  - openai_call_id');
    console.log('  - sideband_connected');
    console.log('  - sideband_connected_at');
    console.log('  - sideband_disconnected_at');
    console.log('  - sideband_error\n');

    // Verify columns were removed
    const columnsResult = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'therapy_sessions'
        AND column_name IN ('openai_call_id', 'sideband_connected', 'sideband_connected_at', 'sideband_disconnected_at', 'sideband_error')
    `);

    if (columnsResult.rows.length === 0) {
      console.log('All sideband columns successfully removed\n');
    } else {
      console.warn('Some columns still exist:');
      columnsResult.rows.forEach(row => {
        console.warn(`  - ${row.column_name}`);
      });
      console.log();
    }

  } catch (error) {
    console.error('\nRollback failed:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run rollback
rollbackMigration()
  .then(() => {
    console.log('Rollback process completed.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Rollback process failed:', error);
    process.exit(1);
  });
