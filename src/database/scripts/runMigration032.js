import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('Running migration 032: RAG tools (worksheet/technique kinds + user-memory embeddings)...');
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/032_rag_tools.sql'), 'utf8');
    await client.query(sql);
    console.log('Migration 032 completed. Re-run ingestKnowledge.js to load worksheet + technique corpora.');
  } catch (err) {
    console.error('Migration 032 failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(console.error);
