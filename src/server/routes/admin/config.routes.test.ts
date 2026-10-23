// Route coverage for the admin system_config write path (ai-therapist-275):
// allowlisted keys are upserted so a missing row becomes present, keys outside
// the allowlist keep the UPDATE-or-404 behaviour, and crisis_alert in
// particular is never created by this route.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

const {
  getAllSystemConfigMock,
  getSystemConfigByKeyMock,
  updateSystemConfigMock,
  upsertSystemConfigMock,
  invalidateConfigCacheMock,
} = vi.hoisted(() => ({
  getAllSystemConfigMock: vi.fn(),
  getSystemConfigByKeyMock: vi.fn(),
  updateSystemConfigMock: vi.fn(),
  upsertSystemConfigMock: vi.fn(),
  invalidateConfigCacheMock: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getAllSystemConfig: getAllSystemConfigMock,
  getSystemConfigByKey: getSystemConfigByKeyMock,
  updateSystemConfig: updateSystemConfigMock,
  upsertSystemConfig: upsertSystemConfigMock,
}));

vi.mock('../../utils/sessionHelpers.js', () => ({
  getSystemPrompt: vi.fn(),
  invalidateConfigCache: invalidateConfigCacheMock,
  DEFAULT_MODALITY_PRESETS: {},
}));

import adminConfigRoutes, { UPSERTABLE_CONFIG_KEYS } from './config.routes.js';

function appAs(role: string | null, username = 'researcher1') {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => {
    if (role !== null) {
      req.session.userId = 7;
      req.session.userRole = role;
      req.session.username = username;
    }
    next();
  });
  app.use(adminConfigRoutes());
  return app;
}

function row(key: string, value: unknown, updatedBy: string | null = 'researcher1') {
  return {
    config_key: key,
    config_value: value,
    description: 'desc',
    updated_at: '2026-10-22T00:00:00.000Z',
    updated_by: updatedBy,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the row does not exist (fresh database).
  updateSystemConfigMock.mockResolvedValue(null);
  upsertSystemConfigMock.mockImplementation(async (key: string, value: unknown, updatedBy: string) =>
    row(key, value, updatedBy)
  );
});

describe('PUT /admin/api/config/:key (upsert path)', () => {
  it('rejects non-researcher callers before touching the store', async () => {
    const res = await request(appAs('therapist'))
      .put('/admin/api/config/grok_voice')
      .send({ value: { speed: 1.2 } });
    expect(res.status).toBe(403);
    expect(upsertSystemConfigMock).not.toHaveBeenCalled();
    expect(updateSystemConfigMock).not.toHaveBeenCalled();
  });

  it('creates a missing allowlisted row instead of reporting 404', async () => {
    const tuning = {
      vad: { threshold: 0.6, silence_duration_ms: 400, prefix_padding_ms: 333 },
      reasoning_effort: 'none',
      speed: 1.1,
    };
    const res = await request(appAs('researcher'))
      .put('/admin/api/config/grok_voice')
      .send({ value: tuning });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, key: 'grok_voice', value: tuning, updated_by: 'researcher1' });
    expect(upsertSystemConfigMock).toHaveBeenCalledWith(
      'grok_voice',
      tuning,
      'researcher1',
      UPSERTABLE_CONFIG_KEYS.grok_voice
    );
    expect(updateSystemConfigMock).not.toHaveBeenCalled();
    expect(invalidateConfigCacheMock).toHaveBeenCalledTimes(1);
  });

  it('lets the email_notifications kill switch be set on a database without the row', async () => {
    const res = await request(appAs('researcher'))
      .put('/admin/api/config/email_notifications')
      .send({ value: { enabled: false } });
    expect(res.status).toBe(200);
    expect(upsertSystemConfigMock).toHaveBeenCalledWith(
      'email_notifications',
      { enabled: false },
      'researcher1',
      expect.any(String)
    );
  });

  it('404s for a key outside the allowlist when the row is missing (no row is created)', async () => {
    const res = await request(appAs('researcher'))
      .put('/admin/api/config/totally_new_key')
      .send({ value: { anything: true } });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Configuration key not found' });
    expect(upsertSystemConfigMock).not.toHaveBeenCalled();
    expect(updateSystemConfigMock).toHaveBeenCalledWith('totally_new_key', { anything: true }, 'researcher1');
    expect(invalidateConfigCacheMock).not.toHaveBeenCalled();
  });

  it('does not treat Object.prototype names as allowlisted keys', async () => {
    const res = await request(appAs('researcher'))
      .put('/admin/api/config/constructor')
      .send({ value: { anything: true } });
    expect(res.status).toBe(404);
    expect(upsertSystemConfigMock).not.toHaveBeenCalled();
  });

  it('still updates a non-allowlisted key whose row already exists', async () => {
    updateSystemConfigMock.mockResolvedValue(row('content_retention', { enabled: true }));
    const res = await request(appAs('researcher'))
      .put('/admin/api/config/content_retention')
      .send({ value: { enabled: true } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, key: 'content_retention' });
    expect(upsertSystemConfigMock).not.toHaveBeenCalled();
  });

  it('rejects an empty value before any write', async () => {
    const res = await request(appAs('researcher'))
      .put('/admin/api/config/grok_voice')
      .send({});
    expect(res.status).toBe(400);
    expect(upsertSystemConfigMock).not.toHaveBeenCalled();
    expect(updateSystemConfigMock).not.toHaveBeenCalled();
  });

  it('keeps voices validation ahead of the upsert', async () => {
    const res = await request(appAs('researcher'))
      .put('/admin/api/config/voices')
      .send({ value: { voices: [{ value: 'eve', label: 'Eve', enabled: false }], default_voice: 'eve' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'At least one voice must be enabled' });
    expect(upsertSystemConfigMock).not.toHaveBeenCalled();
  });

  it('keeps languages validation ahead of the upsert', async () => {
    const res = await request(appAs('researcher'))
      .put('/admin/api/config/languages')
      .send({ value: { languages: [{ value: 'en', label: 'English', enabled: true }], default_language: 'fr' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'default_language must be one of the enabled languages' });
    expect(upsertSystemConfigMock).not.toHaveBeenCalled();
  });

  it('returns 500 and no cache invalidation when the store throws', async () => {
    upsertSystemConfigMock.mockRejectedValueOnce(new Error('db down'));
    const res = await request(appAs('researcher'))
      .put('/admin/api/config/features')
      .send({ value: { chat_enabled: true } });
    expect(res.status).toBe(500);
    expect(invalidateConfigCacheMock).not.toHaveBeenCalled();
  });
});

describe('PUT /admin/api/config/crisis_alert (behaviour unchanged)', () => {
  it('is not in the upsert allowlist', () => {
    expect(Object.keys(UPSERTABLE_CONFIG_KEYS)).not.toContain('crisis_alert');
  });

  it('404s when the row is missing and never creates it', async () => {
    const res = await request(appAs('researcher'))
      .put('/admin/api/config/crisis_alert')
      .send({ value: { enabled: true, phone: '+15555550100' } });
    expect(res.status).toBe(404);
    expect(upsertSystemConfigMock).not.toHaveBeenCalled();
    expect(updateSystemConfigMock).toHaveBeenCalledWith(
      'crisis_alert',
      { enabled: true, phone: '+15555550100' },
      'researcher1'
    );
  });

  it('updates the existing row through the plain UPDATE path', async () => {
    const value = { enabled: false, phone: null };
    updateSystemConfigMock.mockResolvedValue(row('crisis_alert', value));
    const res = await request(appAs('researcher'))
      .put('/admin/api/config/crisis_alert')
      .send({ value });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, key: 'crisis_alert', value });
    expect(upsertSystemConfigMock).not.toHaveBeenCalled();
    expect(invalidateConfigCacheMock).toHaveBeenCalledTimes(1);
  });
});

describe('UPSERTABLE_CONFIG_KEYS', () => {
  it('covers every key the admin UI saves through this route', () => {
    for (const key of [
      'crisis_contact', 'session_limits', 'features', 'ai_model', 'transcription_model',
      'grok_voice', 'client_logging', 'voices', 'languages', 'system_prompts', 'deployment_mode',
    ]) {
      expect(UPSERTABLE_CONFIG_KEYS, key).toHaveProperty(key);
    }
  });

  it('never includes runtime-written or dedicated-route keys', () => {
    for (const key of ['content_retention', 'data_retention', 'study_protocol', 'work_queue.last_sweep_date']) {
      expect(UPSERTABLE_CONFIG_KEYS).not.toHaveProperty(key);
    }
  });
});
