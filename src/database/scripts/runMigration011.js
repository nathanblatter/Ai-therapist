// runMigration011.js
// Script to run database migration 011 - Add crisis management system

import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('\n🔄 Starting database migration 011 - Crisis Management System...\n');

    // Read and execute the migration SQL
    const migrationPath = path.join(__dirname, '../migrations', '011_add_crisis_management.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    console.log('Executing migration script...');
    await client.query(migrationSQL);

    console.log('\nMigration completed successfully!\n');
    console.log('Tables created:');
    console.log('  - crisis_events (audit trail)');
    console.log('  - intervention_actions (intervention logs)');
    console.log('  - human_handoffs (handoff tracking)');
    console.log('  - clinical_reviews (post-incident reviews)');
    console.log('  - risk_score_history (trajectory tracking)\n');

    console.log('Columns added to therapy_sessions:');
    console.log('  - crisis_flagged');
    console.log('  - crisis_severity');
    console.log('  - crisis_risk_score');
    console.log('  - crisis_flagged_at');
    console.log('  - crisis_flagged_by');
    console.log('  - crisis_unflagged_at');
    console.log('  - crisis_unflagged_by');
    console.log('  - monitoring_frequency\n');

    // Verify tables were created
    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('crisis_events', 'intervention_actions', 'human_handoffs', 'clinical_reviews', 'risk_score_history')
      ORDER BY table_name
    `);

    console.log('Verified tables:');
    tablesResult.rows.forEach(row => {
      console.log(`  ${row.table_name}`);
    });
    console.log();

    // Verify columns were created
    const columnsResult = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'therapy_sessions'
        AND column_name IN ('crisis_flagged', 'crisis_severity', 'crisis_risk_score', 'crisis_flagged_at', 'crisis_flagged_by', 'crisis_unflagged_at', 'crisis_unflagged_by', 'monitoring_frequency')
      ORDER BY column_name
    `);

    console.log('Verified crisis columns in therapy_sessions:');
    columnsResult.rows.forEach(row => {
      console.log(`  ${row.column_name} (${row.data_type})`);
    });
    console.log();

    // Verify indexes were created
    const indexesResult = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'therapy_sessions'
        AND indexname LIKE 'idx_sessions_crisis%'
      ORDER BY indexname
    `);

    console.log('Verified crisis indexes:');
    indexesResult.rows.forEach(row => {
      console.log(`  ${row.indexname}`);
    });
    console.log();

  } catch (error) {
    console.error('\nMigration failed:', error.message);
    console.error('\nYou can rollback using: node src/database/scripts/rollbackMigration011.js\n');
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
