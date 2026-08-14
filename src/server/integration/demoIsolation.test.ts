// Demo-account isolation: the magic-link flow and the two walls around it.
// Wall 1 (demo.routes.ts): a 'demo' session must never reach a real admin
// handler — every /admin/api/* and /api/users request gets synthetic fixtures
// and no therapy_sessions query runs. Wall 2 (db queries): real admin queries
// must exclude is_demo sessions, so demo therapy activity never pollutes real
// dashboards, analytics, or exports.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import type { Express } from 'express';

process.env.OPENAI_API_KEY = 'sk-test-key';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.DEMO_MAGIC_TOKEN = 'test-demo-token';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

let app: Express;

// In-memory stand-in for connect-pg-simple's "session" table so login cookies
// survive across requests against the mocked pool. The store hands the sess
// value straight to pg (object in, object out), so it's kept as-is.
const sessionRows = new Map<string, unknown>();

let therapistPasswordHash: string;

beforeAll(async () => {
  therapistPasswordHash = await bcrypt.hash('correct-horse', 10);

  queryMock.mockImplementation((sql: unknown, params?: unknown[]) => {
    const text = typeof sql === 'string' ? sql : '';

    // --- express-session store (connect-pg-simple, tableName user_sessions) ---
    if (text.includes('"user_sessions"')) {
      if (/INSERT INTO/i.test(text)) {
        const [sess, , sid] = params as [unknown, number, string];
        sessionRows.set(sid, sess);
        return Promise.resolve({ rows: [{ sid }], rowCount: 1 });
      }
      if (/^UPDATE/i.test(text.trim())) {
        const sid = (params as unknown[]).find(
          p => typeof p === 'string' && sessionRows.has(p)
        ) as string | undefined;
        return Promise.resolve({ rows: sid ? [{ sid }] : [], rowCount: sid ? 1 : 0 });
      }
      if (/SELECT sess/i.test(text)) {
        const sid = (params as [string])[0];
        const sess = sessionRows.get(sid);
        const parsed = typeof sess === 'string' ? JSON.parse(sess) : sess;
        return Promise.resolve({ rows: sess ? [{ sess: parsed }] : [], rowCount: sess ? 1 : 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // --- login lookup ---
    if (text.includes('FROM users WHERE username')) {
      const username = (params as [string])[0];
      if (username === 'dr_real') {
        return Promise.resolve({
          rows: [{
            userid: 7, username: 'dr_real', password: therapistPasswordHash,
            role: 'therapist', mfa_enabled: false, mfa_secret: null, mfa_backup_codes: null,
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // --- magic-link demo provisioning ---
    if (text.includes('INSERT INTO users') && text.includes("'demo'")) {
      return Promise.resolve({
        rows: [{ userid: 4242, username: 'demo_cafe1234', role: 'demo' }],
        rowCount: 1,
      });
    }

    if (text.includes('system_config')) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  });

  app = (await import('../index.js')).app as Express;
});

/** Queries issued during a window, excluding express-session bookkeeping. */
function appQueriesSince(callIndex: number): string[] {
  return queryMock.mock.calls
    .slice(callIndex)
    .map(c => (typeof c[0] === 'string' ? c[0] : ''))
    .filter(t => !t.includes('"user_sessions"'));
}

async function demoAgent() {
  const agent = request.agent(app);
  const res = await agent.get('/demo/test-demo-token');
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/demo');
  return agent;
}

async function therapistAgent() {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .send({ username: 'dr_real', password: 'correct-horse' });
  expect(res.status).toBe(200);
  return agent;
}

describe('magic-link provisioning', () => {
  it('a wrong token falls through like an unknown route', async () => {
    const res = await request(app).get('/demo/not-the-token');
    expect(res.status).toBe(404);
  });

  it('the correct token provisions a demo account and redirects', async () => {
    await demoAgent(); // asserts 302 → /demo internally
  });
});

describe('wall 1: demo accounts only ever see synthetic admin data', () => {
  it('GET /admin/api/sessions/active returns fixtures without touching therapy_sessions', async () => {
    const agent = await demoAgent();
    const mark = queryMock.mock.calls.length;
    const res = await agent.get('/admin/api/sessions/active');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(appQueriesSince(mark)).toEqual([]);
  });

  it('GET /admin/api/analytics returns fixtures without touching the DB', async () => {
    const agent = await demoAgent();
    const mark = queryMock.mock.calls.length;
    const res = await agent.get('/admin/api/analytics');
    expect(res.status).toBe(200);
    expect(appQueriesSince(mark)).toEqual([]);
  });

  it('dashboard sub-panel endpoints return array-bearing fixtures, not the {} catch-all (ai-therapist-114)', async () => {
    // The Dashboard tab dereferences arrays from these payloads unguarded; the
    // catch-all's `{}` white-screened the whole demo admin portal.
    const agent = await demoAgent();
    const mark = queryMock.mock.calls.length;

    const tools = await agent.get('/admin/api/analytics/tools');
    expect(tools.status).toBe(200);
    expect(Array.isArray(tools.body.tool_stats)).toBe(true);
    expect(Array.isArray(tools.body.distinct_tools_per_session)).toBe(true);
    expect(Array.isArray(tools.body.dead_tools)).toBe(true);

    const cost = await agent.get('/admin/api/analytics/cost');
    expect(cost.status).toBe(200);
    expect(Array.isArray(cost.body.daily_spend)).toBe(true);
    expect(cost.body.totals).toBeTruthy();

    const pairwise = await agent.get('/admin/api/analytics/pairwise');
    expect(pairwise.status).toBe(200);
    expect(Array.isArray(pairwise.body.comparisons)).toBe(true);

    const evals = await agent.get('/admin/api/analytics/evals');
    expect(evals.status).toBe(200);
    expect(Array.isArray(evals.body.trend)).toBe(true);
    expect(Array.isArray(evals.body.open_alerts)).toBe(true);

    const calibration = await agent.get('/admin/api/evals/calibration');
    expect(calibration.status).toBe(200);
    expect(Array.isArray(calibration.body.report?.dimensions)).toBe(true);

    expect(appQueriesSince(mark)).toEqual([]);
  });

  it('GET /api/users returns a synthetic roster, not real users', async () => {
    const agent = await demoAgent();
    const mark = queryMock.mock.calls.length;
    const res = await agent.get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body.users.map((u: { username: string }) => u.username)).toContain('dr_demo');
    expect(appQueriesSince(mark)).toEqual([]);
  });

  it('admin API writes are swallowed: acknowledged but never persisted', async () => {
    const agent = await demoAgent();
    const mark = queryMock.mock.calls.length;
    const res = await agent.post('/admin/api/config').send({ anything: true });
    expect(res.status).toBe(200);
    expect(res.body.demo).toBe(true);
    expect(appQueriesSince(mark)).toEqual([]);
  });

  it('user-management writes with trailing slashes or odd casing are still swallowed (pass-5 review)', async () => {
    // Express matches its string routes case-insensitively and non-strictly,
    // so the interceptor's regex layers must be equally permissive — otherwise
    // PUT /api/users/123/ or /API/users/123 would bypass the demo wall and
    // reach the real handler (demo self-edits would persist).
    const agent = await demoAgent();
    const mark = queryMock.mock.calls.length;

    const trailingSlash = await agent.put('/api/users/4242/').send({ username: 'evil' });
    expect(trailingSlash.status).toBe(200);
    expect(trailingSlash.body.demo).toBe(true);

    const upperPrefix = await agent.put('/API/users/4242').send({ username: 'evil' });
    expect(upperPrefix.status).toBe(200);
    expect(upperPrefix.body.demo).toBe(true);

    const mixedCase = await agent.delete('/api/USERS/4242/');
    expect(mixedCase.status).toBe(200);
    expect(mixedCase.body.demo).toBe(true);

    const createSlash = await agent.post('/api/users/').send({ username: 'evil', password: 'x', role: 'researcher' });
    expect(createSlash.status).toBe(200);
    expect(createSlash.body.demo).toBe(true);

    const adminCase = await agent.post('/ADMIN/API/config').send({ anything: true });
    expect(adminCase.status).toBe(200);
    expect(adminCase.body.demo).toBe(true);

    expect(appQueriesSince(mark)).toEqual([]);
  });

  it('unmatched admin GETs never fall through to a real handler', async () => {
    const agent = await demoAgent();
    const mark = queryMock.mock.calls.length;
    const res = await agent.get('/admin/api/sideband/connections');
    expect(res.status).toBe(200);
    expect(appQueriesSince(mark)).toEqual([]);
  });
});

describe('wall 2: real admin queries exclude demo sessions', () => {
  it('therapists pass through the demo router to the real handler', async () => {
    const agent = await therapistAgent();
    const mark = queryMock.mock.calls.length;
    const res = await agent.get('/admin/api/sessions/active');
    expect(res.status).toBe(200);
    const queries = appQueriesSince(mark);
    expect(queries.some(q => q.includes('therapy_sessions'))).toBe(true);
  });

  it('the active-sessions query filters out is_demo sessions', async () => {
    const agent = await therapistAgent();
    const mark = queryMock.mock.calls.length;
    await agent.get('/admin/api/sessions/active');
    const q = appQueriesSince(mark).find(t => t.includes('therapy_sessions'));
    expect(q).toContain('is_demo IS NOT TRUE');
  });

  it('the session-list and count queries filter out is_demo sessions', async () => {
    const agent = await therapistAgent();
    const mark = queryMock.mock.calls.length;
    await agent.get('/admin/api/sessions');
    const listQueries = appQueriesSince(mark).filter(t => t.includes('therapy_sessions'));
    expect(listQueries.length).toBeGreaterThan(0);
    for (const q of listQueries) {
      expect(q).toContain('is_demo IS NOT TRUE');
    }
  });

  it('the analytics query filters out is_demo sessions', async () => {
    const agent = await therapistAgent();
    const mark = queryMock.mock.calls.length;
    await agent.get('/admin/api/analytics');
    const q = appQueriesSince(mark).find(t => t.includes('therapy_sessions'));
    expect(q).toContain('is_demo IS NOT TRUE');
  });

  it('every export variant filters out is_demo sessions', async () => {
    const agent = await therapistAgent();
    for (const type of ['metadata', 'anonymized', 'aggregated', 'full']) {
      const mark = queryMock.mock.calls.length;
      const res = await agent.get(`/admin/api/export?type=${type}`);
      expect(res.status).toBeLessThan(500);
      const q = appQueriesSince(mark).find(t => t.includes('therapy_sessions'));
      if (q) expect(q).toContain('is_demo IS NOT TRUE');
    }
  });

  it('crisis dashboard queries filter out is_demo sessions', async () => {
    const agent = await therapistAgent();
    const mark = queryMock.mock.calls.length;
    await agent.get('/admin/api/crisis/all');
    const joins = appQueriesSince(mark).filter(t => t.includes('therapy_sessions'));
    expect(joins.length).toBeGreaterThan(0);
    for (const q of joins) {
      expect(q).toContain('is_demo IS NOT TRUE');
    }
  });
});
