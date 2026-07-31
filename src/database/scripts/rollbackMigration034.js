import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollback() {
  const client = await pool.connect();
  try {
    console.log('Rolling back migration 034...');
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/034_session_evals_rollback.sql'), 'utf8');
    await client.query(sql);
    console.log('Rollback 034 completed.');
  } catch (err) {
    console.error('Rollback 034 failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

rollback().catch(console.error);
