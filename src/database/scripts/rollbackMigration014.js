import { pool } from '../../server/config/db.js';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function rollbackMigration() {
  try {
    console.log('Rolling back migration 014: Remove AI model configuration...');

    const rollbackSQL = await fs.readFile(
      path.join(__dirname, '../migrations/014_add_ai_model_config_rollback.sql'),
      'utf8'
    );

    await pool.query(rollbackSQL);

    console.log('Migration 014 rolled back successfully');
    console.log('Removed ai_model configuration');
    process.exit(0);
  } catch (error) {
    console.error('Rollback 014 failed:', error);
    process.exit(1);
  }
}

rollbackMigration();
