// system_config data access (ai-therapist-275): updateSystemConfig stays a
// plain UPDATE that reports a missing row as null, while upsertSystemConfig
// creates the row and keeps a seeded description on conflict.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { getSystemConfigByKey, updateSystemConfig, upsertSystemConfig } from './config.queries.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rowCount: 0, rows: [] });
});

describe('getSystemConfigByKey', () => {
  it('returns null when the row is absent', async () => {
    await expect(getSystemConfigByKey('grok_voice')).resolves.toBeNull();
    expect(queryMock.mock.calls[0][1]).toEqual(['grok_voice']);
  });
});

describe('updateSystemConfig', () => {
  it('runs an UPDATE (never an INSERT) and returns null for a missing row', async () => {
    const result = await updateSystemConfig('crisis_alert', { enabled: false }, 'researcher1');
    expect(result).toBeNull();
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/^\s*UPDATE system_config/);
    expect(sql).not.toMatch(/INSERT/);
    expect(params).toEqual([JSON.stringify({ enabled: false }), 'researcher1', 'crisis_alert']);
  });
});

describe('upsertSystemConfig', () => {
  it('inserts with ON CONFLICT DO UPDATE and binds key, JSON value, description, actor', async () => {
    const stored = {
      config_key: 'grok_voice',
      config_value: { speed: 1.1 },
      description: 'Grok Voice turn-taking',
      updated_at: '2026-10-22T00:00:00.000Z',
      updated_by: 'researcher1',
    };
    queryMock.mockResolvedValue({ rowCount: 1, rows: [stored] });

    const result = await upsertSystemConfig('grok_voice', { speed: 1.1 }, 'researcher1', 'Grok Voice turn-taking');
    expect(result).toEqual(stored);

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO system_config \(config_key, config_value, description, updated_at, updated_by\)/);
    expect(sql).toMatch(/ON CONFLICT \(config_key\) DO UPDATE/);
    expect(sql).toMatch(/RETURNING \*/);
    expect(params).toEqual(['grok_voice', JSON.stringify({ speed: 1.1 }), 'Grok Voice turn-taking', 'researcher1']);
  });

  it('only overwrites value, timestamp and actor on conflict, never the description', async () => {
    queryMock.mockResolvedValue({ rowCount: 1, rows: [{ config_key: 'features' }] });
    await upsertSystemConfig('features', { chat_enabled: true }, 'researcher1', 'Feature flags');
    const sql: string = queryMock.mock.calls[0][0];
    const conflictClause = sql.slice(sql.indexOf('DO UPDATE'));
    expect(conflictClause).toMatch(/config_value = EXCLUDED\.config_value/);
    expect(conflictClause).toMatch(/updated_by = EXCLUDED\.updated_by/);
    expect(conflictClause).not.toMatch(/description/);
  });

  it('defaults the description to null', async () => {
    queryMock.mockResolvedValue({ rowCount: 1, rows: [{ config_key: 'evals' }] });
    await upsertSystemConfig('evals', { auto_run_enabled: true }, undefined);
    expect(queryMock.mock.calls[0][1]).toEqual(['evals', JSON.stringify({ auto_run_enabled: true }), null, undefined]);
  });
});
