import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('Running migration 034: session_evals (LLM-judge quality scores)...');
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/034_session_evals.sql'), 'utf8');
    await client.query(sql);
    console.log('Migration 034 completed.');
  } catch (err) {
    console.error('Migration 034 failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(console.error);
