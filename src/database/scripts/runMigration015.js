import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('Starting migration 015: Add user preferences...');

    const migrationSQL = fs.readFileSync(
      path.join(__dirname, '../migrations/015_add_user_preferences.sql'),
      'utf8'
    );

    await client.query(migrationSQL);

    console.log('Migration 015 completed successfully');
    console.log('  - Added preferred_voice column to users table');
    console.log('  - Added preferred_language column to users table');
    console.log('  - Created index on user preferences');

  } catch (error) {
    console.error('Migration 015 failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

runMigration()
  .then(() => {
    console.log('Migration script finished');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration script failed:', err);
    process.exit(1);
  });
