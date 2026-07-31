// Generic forward-migration runner: applies migrations NNN_*.sql in numeric
// order for an inclusive range. Skips *_rollback.sql. Each file runs in its
// own transaction.
//
//   node src/database/scripts/runMigrationRange.js 035 046
//   DATABASE_URL=postgresql://... node src/database/scripts/runMigrationRange.js 035 046
import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.join(__dirname, '../migrations');

const [from, to] = process.argv.slice(2).map(Number);
if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
  console.error('Usage: node runMigrationRange.js <from> <to>   e.g. 035 046');
  process.exit(1);
}

const files = fs.readdirSync(MIG_DIR)
  .filter(f => /^\d{3}_.*\.sql$/.test(f) && !f.includes('_rollback'))
  .filter(f => { const n = Number(f.slice(0, 3)); return n >= from && n <= to; })
  .sort();

async function main() {
  console.log(`Applying ${files.length} migration(s): ${files.join(', ')}`);
  const client = await pool.connect();
  try {
    for (const f of files) {
      const sql = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
      console.log(`--- ${f}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        console.log(`    OK`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`    FAILED: ${err.message}`);
        throw err;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(() => process.exit(1));
