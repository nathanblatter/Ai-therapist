// rollbackMigration.js
// Script to rollback database migrations

import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }))
}

async function rollbackMigration() {
  console.log('\n⚠️  WARNING: This will delete all data in the new tables!\n');
  console.log('The following tables will be dropped:');
  console.log('  - therapy_sessions');
  console.log('  - session_configurations');
  console.log('  - messages');
  console.log('  - user_sessions\n');
  console.log('Note: The conversation_logs table will NOT be affected.\n');

  const answer = await askQuestion('Are you sure you want to rollback? (yes/no): ');

  if (answer.toLowerCase() !== 'yes') {
    console.log('\n❌ Rollback cancelled.\n');
    process.exit(0);
  }

  const client = await pool.connect();

  try {
    console.log('\n🔄 Starting rollback...\n');

    // Read and execute the rollback SQL
    const rollbackPath = path.join(__dirname, '../migrations', '003_normalize_schema_rollback.sql');
    const rollbackSQL = fs.readFileSync(rollbackPath, 'utf8');

    console.log('📝 Executing rollback script...');
    await client.query(rollbackSQL);

    console.log('\n✅ Rollback completed successfully!\n');
    console.log('Tables removed:');
    console.log('  - therapy_sessions');
    console.log('  - session_configurations');
    console.log('  - messages');
    console.log('  - user_sessions\n');

    console.log('The database has been reverted to the previous state.\n');

  } catch (error) {
    console.error('\n❌ Rollback failed:', error.message);
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
