// Admin drift status + snapshot export: role gates, and the exported file is
// configuration only even when system_config holds other kinds of rows.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn(), on: vi.fn() } }));

import adminConfigEvaluationRoutes from './configEvaluation.routes.js';
import { EVALUATED_CONFIG_KEYS } from '../../utils/evaluatedConfig.js';

function appAs(role: string | null) {
  const app = express();
  app.use((req, _res, next) => {
    req.session = role
      ? ({ userId: 1, userRole: role, username: 'tester' } as unknown as typeof req.session)
      : ({} as unknown as typeof req.session);
    next();
  });
  app.use(adminConfigEvaluationRoutes());
  return app;
}

// What a real system_config can hold: evaluated rows plus paging, protocol
// and simulation rows. The SQL filters by key; the mock honours that filter so
// the test proves both the query and the builder keep everything else out.
const ALL_ROWS = [
  { config_key: 'system_prompts', config_value: { chat: { prompt: 'p'.repeat(150), last_modified: 'x' } } },
  { config_key: 'features', config_value: { lead_conversation_enabled: true, participant_reflections_enabled: true } },
  { config_key: 'crisis_alert', config_value: { enabled: true, phone: '+15551234567' } },
  { config_key: 'study_protocol', config_value: { principal_investigator: 'Dr Example' } },
  { config_key: 'sim_session_01', config_value: { sessionId: 'sess_participant_1' } },
];

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM system_config')) {
      const keys = params?.[0] as string[];
      return {
        rows: ALL_ROWS.filter((r) => keys.includes(r.config_key)).map((r) => ({
          ...r,
          updated_at: null,
          updated_by: null,
        })),
      };
    }
    if (sql.includes('COUNT(*)')) return { rows: [{ n: '0' }] };
    return { rows: [] };
  });
});

describe('GET /admin/api/config-evaluation/status', () => {
  it('serves therapists and researchers, not caseworkers or anonymous users', async () => {
    expect((await request(appAs('therapist')).get('/admin/api/config-evaluation/status')).status).toBe(200);
    expect((await request(appAs('researcher')).get('/admin/api/config-evaluation/status')).status).toBe(200);
    expect((await request(appAs('caseworker')).get('/admin/api/config-evaluation/status')).status).toBe(403);
    expect((await request(appAs(null)).get('/admin/api/config-evaluation/status')).status).toBe(401);
  });
});

describe('GET /admin/api/config-evaluation/snapshot', () => {
  it('is researcher-only', async () => {
    for (const role of ['therapist', 'caseworker', 'participant']) {
      expect((await request(appAs(role)).get('/admin/api/config-evaluation/snapshot')).status).toBe(403);
    }
    expect((await request(appAs(null)).get('/admin/api/config-evaluation/snapshot')).status).toBe(401);
  });

  it('returns configuration only: the evaluated keys, no participant, paging or protocol fields', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/config-evaluation/snapshot');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="config-snapshot-[0-9a-f]{12}\.json"/);
    expect(Object.keys(res.body.config).sort()).toEqual([...EVALUATED_CONFIG_KEYS].sort());
    const text = JSON.stringify(res.body);
    for (const forbidden of [
      'sess_participant_1',
      '+15551234567',
      'Dr Example',
      'participant_reflections_enabled',
      'last_modified',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(res.body.config.features).toEqual({ lead_conversation_enabled: true });
  });
});
