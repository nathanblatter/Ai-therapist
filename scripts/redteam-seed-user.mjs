// Seed the dedicated red-team PARTICIPANT account. Chat scenarios must drive an
// authenticated participant: /api/chat/start keys the session on a numeric
// user_id (getActiveSessionForUser binds it to the integer user_id column), so
// an anonymous cookie-only session 500s. Uses pg + bcrypt directly (no TS), so
// it runs under plain `node`. Idempotent.
import bcrypt from 'bcrypt';
import pg from 'pg';

const USERNAME = process.env.REDTEAM_PARTICIPANT_USER || 'redteam_participant';
const PASSWORD = process.env.REDTEAM_PARTICIPANT_PASS || 'redteam-Passw0rd!';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

try {
  const hash = await bcrypt.hash(PASSWORD, 10);
  // organization_id is NOT NULL since migration 069; the harness account lives
  // in the irb-study org (its sessions are excluded via is_demo, not org).
  await pool.query(
    `INSERT INTO users (username, password, role, organization_id)
     VALUES ($1, $2, 'participant', (SELECT org_id FROM organizations WHERE slug = 'irb-study'))
     ON CONFLICT (username) DO NOTHING`,
    [USERNAME, hash],
  );
  console.log(`redteam participant '${USERNAME}' seeded`);
} finally {
  await pool.end();
}
