import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollbackMigration() {
  const client = await pool.connect();

  try {
    console.log('Rolling back migration 020: Remove content retention...');

    const sql = fs.readFileSync(
      path.join(__dirname, '../migrations/020_add_content_retention_rollback.sql'),
      'utf8'
    );

    await client.query(sql);

    console.log('Rollback 020 completed successfully!');
  } catch (err) {
    console.error('Rollback 020 failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

rollbackMigration().catch(console.error);
