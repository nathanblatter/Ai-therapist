import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

// These must be set before index.ts is imported: its top-level getOpenAIKey()
// reads OPENAI_API_KEY (so the app boots without AWS), and the session
// middleware reads SESSION_SECRET.
process.env.OPENAI_API_KEY = 'sk-test-key';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

// Mock the Postgres pool so importing the whole app never touches a real DB.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

const SYSTEM_CONFIG_ROWS = [
  {
    config_key: 'crisis_contact',
    config_value: { hotline: '988 Suicide & Crisis Lifeline', phone: '988', text: 'HELLO to 741741', enabled: true },
  },
  {
    config_key: 'features',
    config_value: { voice_enabled: true, chat_enabled: true, output_modalities: ['audio'] },
  },
  {
    config_key: 'voices',
    config_value: { voices: [{ value: 'cedar', label: 'Cedar', description: 'Warm', enabled: true }], default_voice: 'cedar' },
  },
];

let app: Express;
let invalidateConfigCache: () => void;

beforeAll(async () => {
  queryMock.mockImplementation((sql: unknown) => {
    if (typeof sql === 'string' && sql.includes('system_config')) {
      return Promise.resolve({ rows: SYSTEM_CONFIG_ROWS });
    }
    return Promise.resolve({ rows: [] });
  });
  // Importing the app registers every inline route on the Express instance but,
  // thanks to the entrypoint guard, does NOT start an HTTP listener.
  app = (await import('../index.js')).app as Express;
  ({ invalidateConfigCache } = await import('../utils/sessionHelpers.js'));
});

beforeEach(() => invalidateConfigCache());

describe('public config routes', () => {
  it('GET /api/config/crisis returns the configured crisis contact', async () => {
    const res = await request(app).get('/api/config/crisis');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ phone: '988', enabled: true });
  });

  it('GET /api/config/features returns the features config', async () => {
    const res = await request(app).get('/api/config/features');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ voice_enabled: true, chat_enabled: true });
  });

  it('GET /api/config/voices returns only enabled voices', async () => {
    const res = await request(app).get('/api/config/voices');
    expect(res.status).toBe(200);
    expect(res.body.voices).toEqual([
      { value: 'cedar', label: 'Cedar', description: 'Warm' },
    ]);
    expect(res.body.default_voice).toBe('cedar');
  });
});

describe('voice preview file route', () => {
  it('GET /api/voices/preview/cedar streams audio', async () => {
    const res = await request(app).get('/api/voices/preview/cedar');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
  });

  it('GET /api/voices/preview/<unknown> is 404', async () => {
    const res = await request(app).get('/api/voices/preview/not-a-real-voice');
    expect(res.status).toBe(404);
  });

  it('rejects path traversal via basename sanitisation', async () => {
    const res = await request(app).get('/api/voices/preview/..%2f..%2fpackage');
    expect(res.status).toBe(404);
  });
});

describe('auth / role gating', () => {
  it('returns 401 on an admin route without a session', async () => {
    const res = await request(app).get('/admin/api/export');
    expect(res.status).toBe(401);
  });

  it('returns 401 on a researcher-only route without a session', async () => {
    const res = await request(app).get('/admin/api/config');
    expect(res.status).toBe(401);
  });
});

describe('auth routes', () => {
  it('GET /api/auth/status reports unauthenticated without a session', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it('POST /api/auth/login requires username and password', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/register is researcher-gated (401 without a session)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'x', password: 'y', role: 'participant' });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/logout succeeds', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe('mfa routes', () => {
  it('GET /api/mfa/status requires auth (401)', async () => {
    const res = await request(app).get('/api/mfa/status');
    expect(res.status).toBe(401);
  });

  it('POST /api/mfa/disable requires auth (401)', async () => {
    const res = await request(app).post('/api/mfa/disable').send({ password: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('app wiring', () => {
  it('unknown API routes 404 (no rogue catch-all in API scope)', async () => {
    const res = await request(app).get('/api/this-route-does-not-exist');
    expect(res.status).toBe(404);
  });

  it('parses JSON bodies and validates input', async () => {
    // No session -> auth/validation should reject rather than 500 on a bad body.
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: '', password: '' });
    expect([400, 401]).toContain(res.status);
  });
});
