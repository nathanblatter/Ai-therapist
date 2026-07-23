import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollbackMigration() {
  const client = await pool.connect();

  try {
    console.log('Rolling back migration 030: restore prior models...');

    const sql = fs.readFileSync(
      path.join(__dirname, '../migrations/030_bump_models_rollback.sql'),
      'utf8'
    );

    await client.query(sql);

    console.log('Migration 030 rolled back successfully!');
  } catch (err) {
    console.error('Migration 030 rollback failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

rollbackMigration().catch(console.error);
