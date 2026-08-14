import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
  // Importing the server graph vite-transforms hundreds of modules; on a loaded
  // machine (or cold cache) that legitimately exceeds the 10s default.
}, 60_000);

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

describe('users routes', () => {
  it('GET /api/users is researcher-gated (401 without a session)', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('GET /api/users/preferences requires auth (401)', async () => {
    const res = await request(app).get('/api/users/preferences');
    expect(res.status).toBe(401);
  });

  it('PUT /api/users/preferences requires auth (401)', async () => {
    const res = await request(app).put('/api/users/preferences').send({ voice: 'cedar', language: 'en' });
    expect(res.status).toBe(401);
  });
});

describe('health + bug-report', () => {
  it('GET /health returns ok with uptime', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
  });

  it('POST /api/bug-report requires a message (or reports not configured)', async () => {
    // Without FLIGHTDECK_INGEST_KEY the route returns 503; with it, empty body -> 400.
    const res = await request(app).post('/api/bug-report').send({});
    expect([400, 503]).toContain(res.status);
  });
});

describe('bug-report screenshots', () => {
  // These paths are all rejected before any forward to flightdeck, so a dummy
  // ingest key keeps the route configured without touching the network.
  const UUID = '123e4567-e89b-12d3-a456-426614174000';
  let savedKey: string | undefined;
  beforeAll(() => { savedKey = process.env.FLIGHTDECK_INGEST_KEY; process.env.FLIGHTDECK_INGEST_KEY = 'test-key'; });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.FLIGHTDECK_INGEST_KEY;
    else process.env.FLIGHTDECK_INGEST_KEY = savedKey;
  });

  it('rejects a non-uuid item id (400)', async () => {
    const res = await request(app)
      .post('/api/bug-report/not-a-uuid/screenshots')
      .attach('files', Buffer.from([0x89, 0x50]), 'shot.png');
    expect(res.status).toBe(400);
  });

  it('rejects non-multipart bodies (400)', async () => {
    const res = await request(app)
      .post(`/api/bug-report/${UUID}/screenshots`)
      .send({ nope: true });
    expect(res.status).toBe(400);
  });

  it('rejects an empty multipart upload (400)', async () => {
    const res = await request(app)
      .post(`/api/bug-report/${UUID}/screenshots`)
      .field('note', 'no files here')
      .catch((e: { status?: number }) => e as { status?: number });
    // fields are disallowed (limits.fields=0) and there are no files -> 400.
    expect(res.status).toBe(400);
  });

  it('rejects non-image bytes (415)', async () => {
    const res = await request(app)
      .post(`/api/bug-report/${UUID}/screenshots`)
      .attach('files', Buffer.from('definitely not an image'), 'notes.txt');
    expect(res.status).toBe(415);
  });

  it('rejects more than 4 files (400)', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    let req = request(app).post(`/api/bug-report/${UUID}/screenshots`);
    for (let i = 0; i < 5; i++) req = req.attach('files', png, `shot-${i}.png`);
    const res = await req.catch((e: { status?: number }) => e as { status?: number });
    expect(res.status).toBe(400);
  });

  it('returns 503 when bug reporting is not configured', async () => {
    delete process.env.FLIGHTDECK_INGEST_KEY;
    try {
      const res = await request(app)
        .post(`/api/bug-report/${UUID}/screenshots`)
        .attach('files', Buffer.from([0x89, 0x50]), 'shot.png');
      expect(res.status).toBe(503);
    } finally {
      process.env.FLIGHTDECK_INGEST_KEY = 'test-key';
    }
  });
});

describe('logs batch route', () => {
  it('POST /logs/batch rejects an empty/invalid body (400)', async () => {
    const res = await request(app).post('/logs/batch').send({});
    expect(res.status).toBe(400);
  });
});

describe('session management routes', () => {
  it('GET /api/sessions requires auth (401)', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(401);
  });

  it('POST /api/sessions/:id/register-call requires call_id (400)', async () => {
    const res = await request(app).post('/api/sessions/abc/register-call').send({});
    expect(res.status).toBe(400);
  });
});

describe('admin recording routes', () => {
  it('GET /admin/api/sessions/:id/recording-info is gated (401)', async () => {
    const res = await request(app).get('/admin/api/sessions/abc/recording-info');
    expect(res.status).toBe(401);
  });

  it('GET /admin/api/sessions/:id/recording is gated (401)', async () => {
    const res = await request(app).get('/admin/api/sessions/abc/recording');
    expect(res.status).toBe(401);
  });
});

describe('chat routes', () => {
  it('POST /api/chat/message requires sessionId and message (400)', async () => {
    const res = await request(app).post('/api/chat/message').send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/chat/end requires sessionId (400)', async () => {
    const res = await request(app).post('/api/chat/end').send({});
    expect(res.status).toBe(400);
  });
});

describe('admin sideband routes', () => {
  it('GET /admin/api/sideband/status is gated (401)', async () => {
    const res = await request(app).get('/admin/api/sideband/status');
    expect(res.status).toBe(401);
  });

  it('POST /admin/api/sideband/disconnect is gated (401)', async () => {
    const res = await request(app).post('/admin/api/sideband/disconnect').send({ sessionId: 'x' });
    expect(res.status).toBe(401);
  });

  it('POST /admin/api/sessions/:id/update-instructions is gated (401)', async () => {
    const res = await request(app).post('/admin/api/sessions/x/update-instructions').send({ instructions: 'hi' });
    expect(res.status).toBe(401);
  });
});

describe('admin sessions + messages routes', () => {
  it('GET /admin/api/sessions/active is gated (401)', async () => {
    const res = await request(app).get('/admin/api/sessions/active');
    expect(res.status).toBe(401);
  });

  it('GET /admin/api/sessions is gated (401)', async () => {
    const res = await request(app).get('/admin/api/sessions');
    expect(res.status).toBe(401);
  });

  it('GET /admin/api/sessions/:id is gated (401)', async () => {
    const res = await request(app).get('/admin/api/sessions/abc');
    expect(res.status).toBe(401);
  });

  it('POST /admin/api/sessions/:id/end is gated (401)', async () => {
    const res = await request(app).post('/admin/api/sessions/abc/end');
    expect(res.status).toBe(401);
  });

  it('PUT /admin/api/messages/:id is gated (401)', async () => {
    const res = await request(app).put('/admin/api/messages/1').send({ content: 'x' });
    expect(res.status).toBe(401);
  });

  it('DELETE /admin/api/messages/:id is gated (401)', async () => {
    const res = await request(app).delete('/admin/api/messages/1');
    expect(res.status).toBe(401);
  });
});

describe('rate-limit routes', () => {
  it('GET /api/rate-limits/status requires auth (401)', async () => {
    const res = await request(app).get('/api/rate-limits/status');
    expect(res.status).toBe(401);
  });

  it('GET /admin/api/rate-limits/users is gated (401)', async () => {
    const res = await request(app).get('/admin/api/rate-limits/users');
    expect(res.status).toBe(401);
  });
});

describe('admin analytics route', () => {
  it('GET /admin/api/analytics is gated (401)', async () => {
    const res = await request(app).get('/admin/api/analytics');
    expect(res.status).toBe(401);
  });
});

describe('admin config routes', () => {
  it('GET /admin/api/config/system-prompt-preview is researcher-gated (401)', async () => {
    const res = await request(app).get('/admin/api/config/system-prompt-preview');
    expect(res.status).toBe(401);
  });

  it('GET /admin/api/config/:key is gated (401)', async () => {
    const res = await request(app).get('/admin/api/config/voices');
    expect(res.status).toBe(401);
  });

  it('PUT /admin/api/config/:key is researcher-gated (401)', async () => {
    const res = await request(app).put('/admin/api/config/voices').send({ value: {} });
    expect(res.status).toBe(401);
  });
});

describe('admin content-retention routes', () => {
  it('GET /admin/api/content-retention is researcher-gated (401)', async () => {
    const res = await request(app).get('/admin/api/content-retention');
    expect(res.status).toBe(401);
  });

  it('POST /admin/api/content-retention/wipe is researcher-gated (401)', async () => {
    const res = await request(app).post('/admin/api/content-retention/wipe');
    expect(res.status).toBe(401);
  });
});

describe('admin user-sessions routes', () => {
  it('GET /admin/api/user-sessions is researcher-gated (401)', async () => {
    const res = await request(app).get('/admin/api/user-sessions');
    expect(res.status).toBe(401);
  });

  it('DELETE /admin/api/user-sessions/:sid is researcher-gated (401)', async () => {
    const res = await request(app).delete('/admin/api/user-sessions/abc');
    expect(res.status).toBe(401);
  });
});

describe('admin crisis + redaction routes', () => {
  it('POST /admin/api/sessions/:id/crisis/flag is gated (401)', async () => {
    const res = await request(app).post('/admin/api/sessions/abc/crisis/flag').send({ severity: 'high' });
    expect(res.status).toBe(401);
  });

  it('GET /admin/api/crisis/all is gated (401)', async () => {
    const res = await request(app).get('/admin/api/crisis/all');
    expect(res.status).toBe(401);
  });

  it('GET /redact/api/messages is researcher-gated (401)', async () => {
    const res = await request(app).get('/redact/api/messages');
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
