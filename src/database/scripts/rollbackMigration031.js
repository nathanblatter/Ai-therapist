import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollbackMigration() {
  const client = await pool.connect();

  try {
    console.log('Rolling back migration 031: drop knowledge_chunks...');

    const sql = fs.readFileSync(
      path.join(__dirname, '../migrations/031_knowledge_base_rollback.sql'),
      'utf8'
    );

    await client.query(sql);

    console.log('Migration 031 rolled back.');
  } catch (err) {
    console.error('Migration 031 rollback failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

rollbackMigration().catch(console.error);
