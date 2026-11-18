// --config-snapshot loader: flag parsing, the disposable-database guard, and
// that loading reproduces the snapshot's fingerprint while keeping the
// harness's own seeds (chat on, paging off, no quotas) intact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../server/utils/sessionHelpers.js', () => ({ invalidateConfigCache: vi.fn() }));

import {
  applyConfigSnapshot,
  assertDisposableDatabase,
  configSnapshotArg,
  loadConfigSnapshotFromArgv,
  readConfigSnapshotFile,
} from './configSnapshot.js';
import { buildConfigSnapshot, fingerprintConfigRows } from '../server/utils/evaluatedConfig.js';
import type { DbLike } from './types.js';

/** Minimal in-memory system_config speaking exactly the loader's SQL. */
function fakeDb(initial: Record<string, unknown>, foreignSessions = 0) {
  const store = new Map<string, unknown>(Object.entries(structuredClone(initial)));
  const db: DbLike = {
    async query(text: string, params: unknown[] = []) {
      if (text.includes('FROM therapy_sessions')) return { rows: [{ n: foreignSessions }] };
      if (text.startsWith('DELETE FROM system_config')) {
        store.delete(params[0] as string);
        return { rows: [] };
      }
      if (text.includes('INSERT INTO system_config')) {
        store.set(params[0] as string, JSON.parse(params[1] as string));
        return { rows: [] };
      }
      if (text.includes('SELECT config_value FROM system_config WHERE config_key = $1')) {
        return { rows: store.has(params[0] as string) ? [{ config_value: store.get(params[0] as string) }] : [] };
      }
      if (text.includes('SELECT config_key, config_value FROM system_config')) {
        return { rows: [...store.entries()].map(([config_key, config_value]) => ({ config_key, config_value })) };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  return { db, store };
}

// The eval database after scripts/redteam-db-setup.sh (abridged).
const EVAL_DB = {
  system_prompts: {
    chat: { prompt: 'migrated chat prompt '.repeat(10) },
    realtime: { prompt: 'migrated '.repeat(20) },
  },
  ai_model: { model: 'gpt-live-1' },
  live_backend_model: 'gpt-5.6-terra',
  features: { chat_enabled: true, voice_enabled: true, phase_guidance_enabled: true },
  session_limits: { enabled: false },
  crisis_alert: { enabled: false, phone: null },
};

// The environment being evaluated.
const ENV_ROWS = [
  {
    config_key: 'system_prompts',
    config_value: {
      chat: { prompt: 'hand-edited chat prompt '.repeat(10), last_modified: 'x' },
      active_modality: 'mi',
    },
  },
  { config_key: 'ai_model', config_value: { model: 'grok-voice-3', description: 'Grok' } },
  { config_key: 'crisis', config_value: { risk_model: 'gpt-5-mini', risk_check_min_score: 30 } },
  {
    config_key: 'features',
    config_value: { chat_enabled: false, lead_conversation_enabled: true, disabled_tools: ['x'] },
  },
  { config_key: 'session_limits', config_value: { enabled: true, max_duration_minutes: 25, max_sessions_per_day: 2 } },
];

describe('configSnapshotArg', () => {
  it('reads the flag value, null when absent, and rejects a missing value', () => {
    expect(configSnapshotArg(['--suite', 'full', '--config-snapshot', 'snap.json'])).toBe('snap.json');
    expect(configSnapshotArg(['--suite', 'full'])).toBeNull();
    expect(() => configSnapshotArg(['--config-snapshot'])).toThrow(/needs a file/);
    expect(() => configSnapshotArg(['--config-snapshot', '--dry-run'])).toThrow(/needs a file/);
  });
});

describe('assertDisposableDatabase', () => {
  it('refuses under the in-app runner and on a database with other people's sessions', async () => {
    await expect(assertDisposableDatabase(fakeDb({}).db, { REDTEAM_TRIGGER: 'scheduled' })).rejects.toThrow(
      /REDTEAM_TRIGGER/,
    );
    await expect(assertDisposableDatabase(fakeDb({}, 3).db, {})).rejects.toThrow(/holds 3 session/);
    await expect(assertDisposableDatabase(fakeDb({}, 0).db, {})).resolves.toBeUndefined();
  });
});

describe('applyConfigSnapshot', () => {
  it('reproduces the environment fingerprint in the eval database', async () => {
    const snap = buildConfigSnapshot(ENV_ROWS, { environment: 'prod' });
    const { db, store } = fakeDb(EVAL_DB);
    await applyConfigSnapshot(db, snap);
    const rows = [...store.entries()].map(([config_key, config_value]) => ({ config_key, config_value }));
    expect(fingerprintConfigRows(rows)).toBe(snap.fingerprint);
    expect(fingerprintConfigRows(rows)).toBe(fingerprintConfigRows(ENV_ROWS));
  });

  it('mirrors absent keys, merges partial keys and keeps the harness seeds', async () => {
    const { db, store } = fakeDb(EVAL_DB);
    await applyConfigSnapshot(db, buildConfigSnapshot(ENV_ROWS));
    // Absent on the environment -> removed here, so the same code default applies.
    expect(store.has('live_backend_model')).toBe(false);
    // Non-evaluated feature flags stay as the harness seeded them; evaluated ones
    // follow the environment, including removal of phase_guidance_enabled.
    expect(store.get('features')).toEqual({
      chat_enabled: true,
      voice_enabled: true,
      lead_conversation_enabled: true,
      disabled_tools: ['x'],
    });
    expect(store.get('session_limits')).toEqual({
      enabled: true,
      max_duration_minutes: 25,
      max_sessions_per_day: 1000,
      cooldown_minutes: 0,
    });
    expect(store.get('crisis_alert')).toEqual({ enabled: false, phone: null });
  });
});

describe('loadConfigSnapshotFromArgv', () => {
  it('is a no-op without the flag', async () => {
    const { db, store } = fakeDb(EVAL_DB);
    expect(await loadConfigSnapshotFromArgv(['--suite', 'full'], db, 'unused')).toBeNull();
    expect(store.get('ai_model')).toEqual({ model: 'gpt-live-1' });
  });

  it('loads a file, records the fingerprint in the results dir, and rejects a tampered file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgsnap-'));
    const snap = buildConfigSnapshot(ENV_ROWS, { environment: 'stage' });
    const file = path.join(dir, 'snap.json');
    fs.writeFileSync(file, JSON.stringify(snap));
    const out = path.join(dir, 'results');
    const { db } = fakeDb(EVAL_DB);
    const loaded = await loadConfigSnapshotFromArgv(['--config-snapshot', file], db, out);
    expect(loaded?.fingerprint).toBe(snap.fingerprint);
    const record = JSON.parse(fs.readFileSync(path.join(out, 'config-snapshot.json'), 'utf8'));
    expect(record).toMatchObject({ fingerprint: snap.fingerprint, environment: 'stage' });
    expect(JSON.stringify(record)).not.toContain('hand-edited');

    const tampered = structuredClone(snap) as typeof snap;
    (tampered.config.crisis as { risk_check_min_score: number }).risk_check_min_score = 99;
    fs.writeFileSync(file, JSON.stringify(tampered));
    expect(() => readConfigSnapshotFile(file)).toThrow(/fingerprint does not match/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
