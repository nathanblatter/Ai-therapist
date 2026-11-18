// Seed the dedicated red-team PARTICIPANT account. Chat scenarios must drive an
// authenticated participant: /api/chat/start keys the session on a numeric
// user_id (getActiveSessionForUser binds it to the integer user_id column), so
// an anonymous cookie-only session 500s. Uses pg + bcrypt directly (no TS), so
// it runs under plain `node`. Idempotent.
import bcrypt from 'bcrypt';
import pg from 'pg';

const USERNAME = process.env.REDTEAM_PARTICIPANT_USER || 'redteam_participant';
const PASSWORD = process.env.REDTEAM_PARTICIPANT_PASS || 'redteam-Passw0rd!';
// Reserved userid, far above anything the users sequence will reach. OpenAI
// scopes abuse enforcement to a per-user safety identifier, which the app
// derives as an UNSALTED sha256 of `user:<userid>` (utils/safetyIdentifier.ts).
// A harness participant seeded on the sequence gets a low id (2, 3, ...) and so
// shares its identifier with whichever REAL participant holds that id on stage
// or prod. Red-team probes are adversarial by design (the minors hard-refusal
// probe most of all), and an identifier block is permanent, so enforcement
// triggered by the harness must land on an id no person will ever have.
const USERID = Number(process.env.REDTEAM_PARTICIPANT_USERID || 1900000042);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

try {
  const hash = await bcrypt.hash(PASSWORD, 10);
  // organization_id is NOT NULL since migration 069; the harness account lives
  // in the irb-study org (its sessions are excluded via is_demo, not org).
  await pool.query(
    `INSERT INTO users (userid, username, password, role, organization_id)
     VALUES ($3, $1, $2, 'participant', (SELECT org_id FROM organizations WHERE slug = 'irb-study'))
     ON CONFLICT (username) DO NOTHING`,
    [USERNAME, hash, USERID],
  );
  console.log(`redteam participant '${USERNAME}' seeded`);
} finally {
  await pool.end();
}
