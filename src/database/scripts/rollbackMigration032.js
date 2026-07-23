import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollbackMigration() {
  const client = await pool.connect();
  try {
    console.log('Rolling back migration 032...');
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/032_rag_tools_rollback.sql'), 'utf8');
    await client.query(sql);
    console.log('Migration 032 rolled back.');
  } catch (err) {
    console.error('Migration 032 rollback failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

rollbackMigration().catch(console.error);
