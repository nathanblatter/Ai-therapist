import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('Running migration 033: per-session exact model recording (ai_model / transcription_model)...');
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/033_add_model_to_session_config.sql'), 'utf8');
    await client.query(sql);
    console.log('Migration 033 completed.');
  } catch (err) {
    console.error('Migration 033 failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(console.error);
