import { pool } from '../../server/config/db.js';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  try {
    console.log('Running migration 014: Add AI model configuration...');

    const migrationSQL = await fs.readFile(
      path.join(__dirname, '../migrations/014_add_ai_model_config.sql'),
      'utf8'
    );

    await pool.query(migrationSQL);

    console.log('Migration 014 completed successfully');
    console.log('Added ai_model configuration with default value: gpt-realtime-mini');
    process.exit(0);
  } catch (error) {
    console.error('Migration 014 failed:', error);
    process.exit(1);
  }
}

runMigration();
