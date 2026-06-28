import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('Running migration 022: Add session recording metadata...');

    const sql = fs.readFileSync(
      path.join(__dirname, '../migrations/022_add_session_recording.sql'),
      'utf8'
    );

    await client.query(sql);

    console.log('Migration 022 completed successfully!');
  } catch (err) {
    console.error('Migration 022 failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(console.error);
