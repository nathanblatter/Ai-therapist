// Migration script to insert initial researcher user
// Run this after creating the users table
// Usage: node migrations/002_insert_initial_user.js

import bcrypt from 'bcrypt';
// The pool lives in the server config module (there is no src/database/db.js).
// Run this file with tsx so the .js specifier resolves to config/db.ts.
import { pool } from '../../server/config/db.js';

const SALT_ROUNDS = 10;

async function createInitialUser() {
  try {
    const username = 'nathan';
    const password = 'Utab2Kil';
    const role = 'researcher';

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Insert the user. organization_id is NOT NULL since 069; this script runs
    // AFTER the full migration range (see scripts/redteam-db-setup.sh), so the
    // irb-study org row always exists by now.
    await pool.query(
      `INSERT INTO users (username, password, role, organization_id)
       VALUES ($1, $2, $3, (SELECT org_id FROM organizations WHERE slug = 'irb-study'))
       ON CONFLICT (username) DO NOTHING`,
      [username, hashedPassword, role]
    );

    console.log('Initial researcher user created successfully');
    console.log(`   Username: ${username}`);
    console.log(`   Role: ${role}`);

    process.exit(0);
  } catch (error) {
    console.error('Failed to create initial user:', error);
    process.exit(1);
  }
}

createInitialUser();
