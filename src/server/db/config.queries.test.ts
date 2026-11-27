// system_config data access (ai-therapist-275): updateSystemConfig stays a
// plain UPDATE that reports a missing row as null, while upsertSystemConfig
// creates the row and keeps a seeded description on conflict.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, connectMock, clientQueryMock, releaseMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
  clientQueryMock: vi.fn(),
  releaseMock: vi.fn(),
}));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: connectMock, on: vi.fn() },
}));

import {
  ASSISTANT_AGENTS_API_FLAG,
  GUARDED_FEATURE_FLAGS,
  getSystemConfigByKey,
  setGuardedFeatureFlagAudited,
  updateSystemConfig,
  upsertFeaturesKeepingGuardedFlags,
  upsertSystemConfig,
} from './config.queries.js';
import { AGENTS_API_FEATURE_KEY } from '../services/assistant.service.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rowCount: 0, rows: [] });
  clientQueryMock.mockReset().mockResolvedValue({ rowCount: 0, rows: [] });
  releaseMock.mockReset();
  connectMock.mockReset().mockResolvedValue({ query: clientQueryMock, release: releaseMock });
});

describe('guarded feature flags', () => {
  const ACTOR = { userId: 7, username: 'dr_lee', role: 'researcher' };
  const sqlOf = (i: number) => String(clientQueryMock.mock.calls[i][0]);

  it('guards the flag the assistant service reads', () => {
    expect(ASSISTANT_AGENTS_API_FLAG).toBe(AGENTS_API_FEATURE_KEY);
    expect(GUARDED_FEATURE_FLAGS).toContain(AGENTS_API_FEATURE_KEY);
  });

  it('saves features in one statement that strips guarded flags and keeps the stored ones', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ config_key: 'features', config_value: { chat_enabled: false } }] });
    const stale = { chat_enabled: false, assistant_agents_api_enabled: true };
    await upsertFeaturesKeepingGuardedFlags(stale, 'researcher1', 'Feature flags');
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    // Incoming guarded flags are removed, on insert and on update alike...
    expect(sql).toMatch(/VALUES \('features', \$1::jsonb - \$4::text\[\]/);
    // ...and the stored value of each guarded flag is carried over.
    expect(sql).toMatch(/EXCLUDED\.config_value \|\| COALESCE\(/);
    expect(sql).toMatch(/system_config\.config_value -> g\.flag/);
    expect(params).toEqual([JSON.stringify(stale), 'Feature flags', 'researcher1', ['assistant_agents_api_enabled']]);
  });

  it('switches the flag and writes the audit row in one transaction', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ config_key: 'features', config_value: {}, previous: null }] })
      .mockResolvedValueOnce({ rows: [{ config_key: 'features', updated_by: 'dr_lee' }] });
    const change = await setGuardedFeatureFlagAudited(ASSISTANT_AGENTS_API_FLAG, true, ACTOR, 'Feature flags');
    expect(change).toMatchObject({ previous: null, changed: true, row: { updated_by: 'dr_lee' } });
    expect(clientQueryMock.mock.calls.map((c) => String(c[0]).trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'SELECT',
      'INSERT',
      'INSERT',
      'COMMIT',
    ]);
    expect(sqlOf(1)).toMatch(/FOR UPDATE/);
    // Only this one key is written: the rest of the stored object is kept.
    expect(sqlOf(2)).toMatch(/system_config\.config_value \|\| jsonb_build_object\(\$1::text, \$2::boolean\)/);
    expect(clientQueryMock.mock.calls[2][1]).toEqual(['assistant_agents_api_enabled', true, 'Feature flags', 'dr_lee']);
    expect(sqlOf(3)).toMatch(/INSERT INTO data_access_log[\s\S]*'config_flag_change'/);
    const [actorId, role, detail] = clientQueryMock.mock.calls[3][1] as [number, string, string];
    expect([actorId, role]).toEqual([7, 'researcher']);
    expect(JSON.parse(detail)).toEqual({
      key: 'features.assistant_agents_api_enabled',
      old: null,
      new: true,
      actor_username: 'dr_lee',
      scope: 'all organisations',
    });
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rolls the flag change back when the audit row cannot be written', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ config_key: 'features', previous: true }] })
      .mockResolvedValueOnce({ rows: [{ config_key: 'features' }] })
      .mockRejectedValueOnce(new Error('relation "data_access_log" does not exist'));
    await expect(setGuardedFeatureFlagAudited(ASSISTANT_AGENTS_API_FLAG, false, ACTOR)).rejects.toThrow(
      /data_access_log/,
    );
    expect(sqlOf(4)).toBe('ROLLBACK');
    expect(clientQueryMock.mock.calls.some((c) => c[0] === 'COMMIT')).toBe(false);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('writes nothing, and no audit row, when the flag already has the requested value', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ config_key: 'features', previous: true }] });
    const change = await setGuardedFeatureFlagAudited(ASSISTANT_AGENTS_API_FLAG, true, ACTOR);
    expect(change).toMatchObject({ previous: true, changed: false });
    expect(clientQueryMock.mock.calls.map((c) => String(c[0]).trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'SELECT',
      'COMMIT',
    ]);
  });

  it('refuses a flag that is not guarded', async () => {
    await expect(setGuardedFeatureFlagAudited('voice_enabled', true, ACTOR)).rejects.toThrow(/not a guarded/);
    expect(connectMock).not.toHaveBeenCalled();
  });
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
