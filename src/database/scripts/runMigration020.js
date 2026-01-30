import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('Running migration 020: Add content retention...');

    const sql = fs.readFileSync(
      path.join(__dirname, '../migrations/020_add_content_retention.sql'),
      'utf8'
    );

    await client.query(sql);

    console.log('Migration 020 completed successfully!');
  } catch (err) {
    console.error('Migration 020 failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(console.error);
