// rollbackMigration011.js
// Script to rollback database migration 011 - Crisis Management System

import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollbackMigration() {
  const client = await pool.connect();

  try {
    console.log('\n🔄 Rolling back database migration 011 - Crisis Management System...\n');

    // Read and execute the rollback SQL
    const rollbackPath = path.join(__dirname, '../migrations', '011_add_crisis_management_rollback.sql');
    const rollbackSQL = fs.readFileSync(rollbackPath, 'utf8');

    console.log('Executing rollback script...');
    await client.query(rollbackSQL);

    console.log('\nRollback completed successfully!\n');
    console.log('Tables dropped:');
    console.log('  - risk_score_history');
    console.log('  - clinical_reviews');
    console.log('  - human_handoffs');
    console.log('  - intervention_actions');
    console.log('  - crisis_events\n');

    console.log('Columns removed from therapy_sessions:');
    console.log('  - crisis_flagged');
    console.log('  - crisis_severity');
    console.log('  - crisis_risk_score');
    console.log('  - crisis_flagged_at');
    console.log('  - crisis_flagged_by');
    console.log('  - crisis_unflagged_at');
    console.log('  - crisis_unflagged_by');
    console.log('  - monitoring_frequency\n');

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
