// Seed a THROWAWAY database with the accounts the mobile screenshot script
// (scripts/mobile-audit/screenshots.ts) logs in as. No LLM calls: the therapist
// caseload comes from the deterministic sandbox seeder via the real
// /join-sandbox flow, everything else is plain SQL.
//
// Usage (dev server already running against the same database):
//   DATABASE_URL=postgresql://postgres@localhost:5432/rt_mobile_xxxx \
//   BASE_URL=http://127.0.0.1:3791 npx tsx scripts/mobile-audit/seed.ts
//
// Refuses any database whose name does not start with rt_ so it can never
// touch stage or prod. Idempotent enough to re-run on the same scratch DB.
import bcrypt from 'bcrypt';
import pg from 'pg';
import { MOBILE_AUDIT_ACCOUNTS } from './accounts';

async function main() {
  const url = process.env.DATABASE_URL;
  const base = process.env.BASE_URL || 'http://127.0.0.1:3791';
  if (!url) throw new Error('DATABASE_URL is required');
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.startsWith('rt_')) throw new Error(`refusing to seed '${dbName}': scratch databases must start with rt_`);

  const pool = new pg.Pool({ connectionString: url });
  const A = MOBILE_AUDIT_ACCOUNTS;
  try {
    const org = await pool.query(`SELECT org_id FROM organizations WHERE slug = 'irb-study'`);
    const orgId: number = org.rows[0].org_id;
    const hash = await bcrypt.hash(A.researcher.password, 10);
    for (const [username, role] of [
      [A.researcher.username, 'researcher'],
      [A.newcomer.username, 'participant'],
      [A.demo.username, 'demo'],
    ] as const) {
      await pool.query(
        `INSERT INTO users (username, password, role, organization_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password`,
        [username, hash, role, orgId],
      );
    }

    const existing = await pool.query(`SELECT 1 FROM users WHERE username = $1`, [A.therapist.username]);
    if (existing.rowCount === 0) {
      // Researcher session -> mint one therapist sandbox invite -> join it.
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: A.researcher.username, password: A.researcher.password }),
      });
      const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
      if (!login.ok || !cookie) throw new Error(`researcher login failed: ${login.status}`);
      const mint = await fetch(`${base}/admin/api/sandbox/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ count: 1, role: 'therapist', label: 'mobile audit' }),
      });
      const minted = (await mint.json()) as { links?: { link: string }[] };
      const link = minted.links?.[0]?.link;
      if (!link) throw new Error(`sandbox invite mint failed: ${mint.status}`);
      const join = await fetch(`${base}${link}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: A.therapist.username, password: A.therapist.password }),
      });
      if (!join.ok) throw new Error(`join-sandbox failed: ${join.status} ${await join.text()}`);
    }

    // Re-key the sandbox client with the most sessions as the participant login.
    const pHash = await bcrypt.hash(A.participant.password, 10);
    const already = await pool.query(`SELECT 1 FROM users WHERE username = $1`, [A.participant.username]);
    if (already.rowCount === 0) {
      const pick = await pool.query(
        `SELECT u.userid FROM users u
           JOIN users owner ON owner.username = $1 AND owner.organization_id = u.organization_id
           LEFT JOIN therapy_sessions s ON s.user_id = u.userid
          WHERE u.role = 'participant'
          GROUP BY u.userid ORDER BY count(s.*) DESC LIMIT 1`,
        [A.therapist.username],
      );
      if (pick.rowCount === 0) throw new Error('no sandbox client found to re-key');
      await pool.query(`UPDATE users SET username = $1, password = $2 WHERE userid = $3`, [
        A.participant.username,
        pHash,
        pick.rows[0].userid,
      ]);
    }
    console.log(
      'mobile audit accounts seeded:',
      Object.values(A)
        .map((a) => a.username)
        .join(', '),
    );
  } finally {
    await pool.end();
  }
}

await main();
