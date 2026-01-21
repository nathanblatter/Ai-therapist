// patchMigration011.js
// Patch script to add missing action types to intervention_actions table

import { pool } from '../../server/config/db.js';

async function patchMigration() {
  const client = await pool.connect();

  try {
    console.log('\n🔧 Applying patch to crisis management migration 011...\n');

    // Drop the existing constraint
    console.log('Dropping old constraint...');
    await client.query(`
      ALTER TABLE intervention_actions
      DROP CONSTRAINT IF EXISTS intervention_actions_action_type_check;
    `);

    // Add new constraint with additional action types
    console.log('Adding new constraint with auto_flag and manual_flag...');
    await client.query(`
      ALTER TABLE intervention_actions
      ADD CONSTRAINT intervention_actions_action_type_check
      CHECK (action_type IN (
        'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
        'supervisor_review', 'clinical_review', 'handoff_initiated',
        'monitoring_increased', 'external_api_called',
        'auto_flag', 'manual_flag'
      ));
    `);

    console.log('\nPatch applied successfully!\n');
    console.log('Added action types:');
    console.log('  - auto_flag (for automatic detection)');
    console.log('  - manual_flag (for manual admin flagging)\n');

  } catch (error) {
    console.error('\nPatch failed:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run patch
patchMigration()
  .then(() => {
    console.log('Patch process completed.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Patch process failed:', error);
    process.exit(1);
  });
