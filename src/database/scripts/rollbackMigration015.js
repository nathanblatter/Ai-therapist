import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollbackMigration() {
  const client = await pool.connect();

  try {
    console.log('Rolling back migration 015: Remove user preferences...');

    const rollbackSQL = fs.readFileSync(
      path.join(__dirname, '../migrations/015_add_user_preferences_rollback.sql'),
      'utf8'
    );

    await client.query(rollbackSQL);

    console.log('Migration 015 rolled back successfully');
    console.log('  - Removed preferred_voice column from users table');
    console.log('  - Removed preferred_language column from users table');
    console.log('  - Dropped index on user preferences');

  } catch (error) {
    console.error('Rollback of migration 015 failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

rollbackMigration()
  .then(() => {
    console.log('Rollback script finished');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Rollback script failed:', err);
    process.exit(1);
  });
