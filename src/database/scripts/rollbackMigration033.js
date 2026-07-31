import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollback() {
  const client = await pool.connect();
  try {
    console.log('Rolling back migration 033...');
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/033_add_model_to_session_config_rollback.sql'), 'utf8');
    await client.query(sql);
    console.log('Rollback 033 completed.');
  } catch (err) {
    console.error('Rollback 033 failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

rollback().catch(console.error);
