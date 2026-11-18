// Evaluated-configuration fingerprint and snapshot (red-team config gate):
// what moves the fingerprint, what must not, and that a snapshot carries
// configuration only.
/* eslint-disable @typescript-eslint/no-explicit-any -- the it.each tables mutate loosely typed JSON config blobs */
import { describe, it, expect } from 'vitest';
import {
  EVALUATED_CONFIG_KEYS,
  EVALUATED_CONFIG_VERSION,
  buildConfigSnapshot,
  buildEvaluatedConfig,
  canonicalJson,
  fingerprintConfigRows,
  parseConfigSnapshot,
  type ConfigRowLike,
} from './evaluatedConfig.js';

const PROMPT = 'You are a supportive research assistant. '.repeat(5);

function baseRows(): ConfigRowLike[] {
  return [
    {
      config_key: 'system_prompts',
      config_value: {
        realtime: { prompt: PROMPT, last_modified: '2026-11-01T00:00:00Z' },
        chat: { prompt: PROMPT + ' chat', last_modified: '2026-11-01T00:00:00Z' },
        active_modality: 'cbt',
      },
    },
    { config_key: 'ai_model', config_value: { model: 'gpt-live-1', description: 'GPT-Live' } },
    { config_key: 'live_backend_model', config_value: 'gpt-5.6-terra' },
    { config_key: 'crisis', config_value: { risk_model: 'gpt-4o-mini', risk_check_min_score: 40 } },
    { config_key: 'crisis_contact', config_value: { hotline: '988', phone: '988', text: 'HOME', enabled: true } },
    {
      config_key: 'features',
      config_value: {
        chat_enabled: true,
        voice_enabled: true,
        telemetry_acoustic_features: false,
        disabled_tools: ['b_tool', 'a_tool'],
        lead_conversation_enabled: false,
        psychoeducation_cue_ab_enabled: false,
      },
    },
    {
      config_key: 'session_limits',
      config_value: { enabled: true, max_duration_minutes: 30, max_sessions_per_day: 3, cooldown_minutes: 60 },
    },
    // Not evaluated:
    { config_key: 'evals', config_value: { judge_model: 'gpt-5.2' } },
    { config_key: 'crisis_alert', config_value: { enabled: true, phone: '+15551234567' } },
    { config_key: 'sim_session_01', config_value: { sessionId: 'sess_abc', week: 1 } },
    { config_key: 'study_protocol', config_value: { principal_investigator: 'Dr X' } },
  ];
}

function withValue(rows: ConfigRowLike[], key: string, fn: (v: unknown) => unknown): ConfigRowLike[] {
  return rows.map((r) => (r.config_key === key ? { ...r, config_value: fn(structuredClone(r.config_value)) } : r));
}

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('fingerprint', () => {
  const fp = fingerprintConfigRows(baseRows());

  it('is a 64-char hex sha256 and stable across row and key order', () => {
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    const shuffled = [...baseRows()]
      .reverse()
      .map((r) =>
        r.config_value && typeof r.config_value === 'object' && !Array.isArray(r.config_value)
          ? { ...r, config_value: Object.fromEntries(Object.entries(r.config_value).reverse()) }
          : r,
      );
    expect(fingerprintConfigRows(shuffled)).toBe(fp);
  });

  it.each([
    ['prompt text', 'system_prompts', (v: any) => ({ ...v, chat: { ...v.chat, prompt: v.chat.prompt + '!' } })],
    ['active modality', 'system_prompts', (v: any) => ({ ...v, active_modality: 'act' })],
    ['voice model', 'ai_model', () => ({ model: 'grok-voice-3' })],
    ['delegated model', 'live_backend_model', () => 'gpt-5.7'],
    ['crisis risk model', 'crisis', (v: any) => ({ ...v, risk_model: 'gpt-5-mini' })],
    ['crisis hotline', 'crisis_contact', (v: any) => ({ ...v, phone: '911' })],
    ['lead_conversation flag', 'features', (v: any) => ({ ...v, lead_conversation_enabled: true })],
    ['psychoeducation cue flag', 'features', (v: any) => ({ ...v, psychoeducation_cue_ab_enabled: true })],
    ['disabled tools', 'features', (v: any) => ({ ...v, disabled_tools: ['a_tool'] })],
    ['session length (phase guidance)', 'session_limits', (v: any) => ({ ...v, max_duration_minutes: 45 })],
  ])('changes when the %s changes', (_label, key, fn) => {
    expect(fingerprintConfigRows(withValue(baseRows(), key, fn))).not.toBe(fp);
  });

  it.each([
    ['last_modified restamp', 'system_prompts', (v: any) => ({ ...v, chat: { ...v.chat, last_modified: 'later' } })],
    ['model description', 'ai_model', (v: any) => ({ ...v, description: 'other words' })],
    ['disabled_tools order', 'features', (v: any) => ({ ...v, disabled_tools: ['a_tool', 'b_tool'] })],
    ['telemetry flag', 'features', (v: any) => ({ ...v, telemetry_acoustic_features: true })],
    ['participant-facing toggle', 'features', (v: any) => ({ ...v, voice_enabled: false })],
    ['daily quota', 'session_limits', (v: any) => ({ ...v, max_sessions_per_day: 9, cooldown_minutes: 0 })],
    ['judge model', 'evals', () => ({ judge_model: 'other' })],
    ['on-call paging', 'crisis_alert', () => ({ enabled: false, phone: null })],
  ])('does not change on a %s', (_label, key, fn) => {
    expect(fingerprintConfigRows(withValue(baseRows(), key, fn))).toBe(fp);
  });

  it('treats an absent row as null (code default) and distinguishes it from a present one', () => {
    const without = baseRows().filter((r) => r.config_key !== 'live_backend_model');
    expect(buildEvaluatedConfig(without).live_backend_model).toBeNull();
    expect(fingerprintConfigRows(without)).not.toBe(fp);
  });
});

describe('snapshot', () => {
  const snap = buildConfigSnapshot(baseRows(), { environment: 'stage', now: new Date('2026-11-18T12:00:00Z') });

  it('contains exactly the evaluated keys and no participant, account or paging fields', () => {
    expect(Object.keys(snap.config).sort()).toEqual([...EVALUATED_CONFIG_KEYS].sort());
    const text = JSON.stringify(snap);
    for (const forbidden of ['sess_abc', '+15551234567', 'Dr X', 'sim_session', 'crisis_alert', 'judge_model']) {
      expect(text).not.toContain(forbidden);
    }
    expect(Object.keys(snap.config.features as object).sort()).toEqual([
      'disabled_tools',
      'lead_conversation_enabled',
      'psychoeducation_cue_ab_enabled',
    ]);
    expect(snap.config.session_limits).toEqual({ enabled: true, max_duration_minutes: 30 });
    expect(snap).toMatchObject({ kind: 'ai-therapist/evaluated-config', version: EVALUATED_CONFIG_VERSION });
    expect(snap.fingerprint).toBe(fingerprintConfigRows(baseRows()));
  });

  it('round-trips through parseConfigSnapshot', () => {
    expect(parseConfigSnapshot(JSON.parse(JSON.stringify(snap))).fingerprint).toBe(snap.fingerprint);
  });

  it('rejects an edited, extended or foreign snapshot', () => {
    const edited = structuredClone(snap) as any;
    edited.config.live_backend_model = 'other';
    expect(() => parseConfigSnapshot(edited)).toThrow(/fingerprint does not match/);

    const extraKey = structuredClone(snap) as any;
    extraKey.config.users = [{ username: 'p1' }];
    expect(() => parseConfigSnapshot(extraKey)).toThrow(/config keys/);

    const extraField = structuredClone(snap) as any;
    extraField.config.features.participant_reflections_enabled = true;
    expect(() => parseConfigSnapshot(extraField)).toThrow(/outside the evaluated set/);

    expect(() => parseConfigSnapshot({ ...snap, version: 99 })).toThrow(/version/);
    expect(() => parseConfigSnapshot({ ...snap, kind: 'x' })).toThrow(/kind/);
    expect(() => parseConfigSnapshot('nope')).toThrow(/not a JSON object/);
  });
});
