// One-time import of existing accounts and organisations into Squawk
// (auth-service-33). Run on the box that reaches the app database:
//
//   SQUAWK_ADMIN_TOKEN=$(cat ~/.config/auth-service/prod-admin-token) \
//   SQUAWK_ISSUER=https://squawk.nathanblatter.com SQUAWK_SERVICE_ID=svc_... \
//   SQUAWK_CREDENTIAL=... DATABASE_URL=postgresql://... \
//   npx tsx src/database/scripts/importToSquawk.ts [--dry-run]
//
// What it does, idempotently (rows that already carry a Squawk id are skipped):
//  1. Sets the service's scope catalog and roles to one role:<name> scope per
//     app role, so a user's Squawk role shows up in the token's scope.
//  2. Creates a PASSWORD account per user with the bcrypt hash copied as is
//     (owner path: POST /admin/services/{id}/users, admin bearer), role =
//     the app role, no email (pseudonymous participants), and stores
//     users.squawk_user_id.
//  3. Creates a Squawk org per organisation that has members (service token:
//     POST /v1/orgs with the first therapist/researcher as founding admin),
//     adds every member (therapists and researchers as org admins), and
//     stores organizations.squawk_org_id.
import pkg from 'pg';
import 'dotenv/config';

const { Pool } = pkg;

const ISSUER = (process.env.SQUAWK_ISSUER ?? '').replace(/\/+$/, '');
const SERVICE_ID = process.env.SQUAWK_SERVICE_ID ?? '';
const CREDENTIAL = process.env.SQUAWK_CREDENTIAL ?? '';
const ADMIN_TOKEN = (process.env.SQUAWK_ADMIN_TOKEN ?? '').trim();
const DRY_RUN = process.argv.includes('--dry-run');
const ROLES = ['therapist', 'researcher', 'participant', 'demo', 'caseworker'] as const;
const ORG_ADMIN_ROLES = new Set(['therapist', 'researcher']);

if (!ISSUER || !SERVICE_ID || !CREDENTIAL || !ADMIN_TOKEN || !process.env.DATABASE_URL) {
  console.error('need SQUAWK_ISSUER, SQUAWK_SERVICE_ID, SQUAWK_CREDENTIAL, SQUAWK_ADMIN_TOKEN and DATABASE_URL');
  process.exit(2);
}

type Json = Record<string, unknown>;

async function squawk(method: string, path: string, auth: string, body?: unknown): Promise<Json> {
  const resp = await fetch(`${ISSUER}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  const json = text ? (JSON.parse(text) as Json) : {};
  if (!resp.ok) throw new Error(`${method} ${path} → ${resp.status} ${JSON.stringify(json)}`);
  return json;
}

async function serviceToken(): Promise<string> {
  const resp = await fetch(`${ISSUER}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SERVICE_ID, client_secret: CREDENTIAL }).toString(),
  });
  const json = (await resp.json()) as Json;
  if (!resp.ok) throw new Error(`service token: ${resp.status} ${JSON.stringify(json)}`);
  return String(json.access_token);
}

interface UserRow { userid: number; username: string; password: string; role: string; organization_id: number; squawk_user_id: string | null }
interface OrgRow { org_id: number; slug: string; name: string; kind: string; squawk_org_id: string | null }

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false });
  const svcTok = await serviceToken();
  const svc = await squawk('GET', `/admin/services/${SERVICE_ID}`, ADMIN_TOKEN);
  console.log(`service ${svc.slug} (${SERVICE_ID}) at ${ISSUER}${DRY_RUN ? ' — DRY RUN' : ''}`);

  // 1. Scope catalog: one role:<name> scope per app role; each role bundles its own.
  const scopes = ROLES.map((r) => `role:${r}`);
  const roles = Object.fromEntries(ROLES.map((r) => [r, [`role:${r}`]]));
  if (!DRY_RUN) await squawk('PUT', `/admin/services/${SERVICE_ID}/permissions`, ADMIN_TOKEN, { scopes, roles });
  console.log(`permissions: ${scopes.join(' ')}`);

  // 2. Users.
  const users = (await pool.query<UserRow>('SELECT userid, username, password, role, organization_id, squawk_user_id FROM users ORDER BY userid')).rows;
  let created = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const u of users) {
    if (u.squawk_user_id) {
      skipped++;
      continue;
    }
    if (!(ROLES as readonly string[]).includes(u.role)) {
      failures.push(`${u.username}: unknown role ${u.role}`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`would create ${u.username} (${u.role})`);
      created++;
      continue;
    }
    try {
      const out = await squawk('POST', `/admin/services/${SERVICE_ID}/users`, ADMIN_TOKEN, {
        method: 'password', username: u.username, password_hash: u.password, roles: [u.role],
      });
      await pool.query('UPDATE users SET squawk_user_id = $1 WHERE userid = $2', [out.id, u.userid]);
      created++;
    } catch (err) {
      failures.push(`${u.username}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`users: ${created} created, ${skipped} already linked, ${failures.length} failed`);
  for (const f of failures) console.log(`  ${f}`);

  // 3. Organisations with members → Squawk orgs.
  const orgs = (await pool.query<OrgRow>('SELECT org_id, slug, name, kind, squawk_org_id FROM organizations ORDER BY org_id')).rows;
  const linked = (await pool.query<UserRow>('SELECT userid, username, password, role, organization_id, squawk_user_id FROM users WHERE squawk_user_id IS NOT NULL ORDER BY userid')).rows;
  for (const o of orgs) {
    const members = linked.filter((u) => u.organization_id === o.org_id);
    if (members.length === 0) {
      console.log(`org ${o.slug}: no linked members, skipped`);
      continue;
    }
    const founder = members.find((u) => ORG_ADMIN_ROLES.has(u.role)) ?? members[0];
    let orgId = o.squawk_org_id;
    if (!orgId) {
      if (DRY_RUN) {
        console.log(`would create org ${o.name} (founder ${founder.username}, ${members.length} members)`);
        continue;
      }
      const out = await squawk('POST', '/v1/orgs', svcTok, { name: o.name, admin_user_id: founder.squawk_user_id });
      orgId = String(out.id);
      await pool.query('UPDATE organizations SET squawk_org_id = $1 WHERE org_id = $2', [orgId, o.org_id]);
    }
    let added = 0;
    for (const m of members) {
      const role = ORG_ADMIN_ROLES.has(m.role) ? 'admin' : 'member';
      if (DRY_RUN) continue;
      await squawk('PUT', `/v1/orgs/${orgId}/members/${m.squawk_user_id}`, svcTok, { role });
      added++;
    }
    console.log(`org ${o.slug} → ${orgId}: ${added} memberships set`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
