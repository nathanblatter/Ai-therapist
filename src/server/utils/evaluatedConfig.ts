// The "evaluated configuration" (ai-therapist red-team config gate): the
// subset of system_config that changes WHAT the AI says or WHICH model says
// it, canonicalised and hashed into one fingerprint. A recorded red-team run
// (config_evaluations, migration 126) is tied to a fingerprint; when an
// environment's current fingerprint has no passing run, the admin UI shows a
// drift notice and the redteam-config workflow evaluates it.
//
// Pure module (no DB import) so the harness loader, the export CLI, the admin
// routes and the tests all share one definition. The DB side lives in
// services/configEvaluation.service.ts.
//
// What is in the fingerprint (EVALUATED_CONFIG_VERSION 1):
//   whole keys     system_prompts (minus the per-save last_modified stamps),
//                  ai_model (model id only; the description is cosmetic),
//                  live_backend_model, crisis, crisis_contact (interpolated
//                  into the prompt), languages (per-language prompt
//                  additions), coping_strategies (library the AI's tool
//                  returns), grok_voice, grok_refusal_guard
//   features.*     disabled_tools (sorted), phase_guidance_enabled,
//                  regrounding_enabled, regrounding_interval_minutes,
//                  proactive_offering, psychoeducation_cue_ab_enabled,
//                  lead_conversation_enabled
//   session_limits enabled, max_duration_minutes, vendor_ceiling_minutes
//                  (phase-guidance timing and the crisis duration lift)
// Deliberately NOT in it: participant-facing toggles and telemetry flags,
// quotas (max_sessions_per_day, cooldown_minutes), retention, evals (judge
// settings change the evaluation, not the AI), crisis_alert (on-call paging,
// never copied off an environment), and every runtime-written internal key.
// system_config holds no participant data; the allowlist below is what keeps
// it that way for the snapshot too.
//
// Adding a key here changes every fingerprint (bump EVALUATED_CONFIG_VERSION),
// which marks every environment unevaluated until its next run. That is the
// intended behaviour: the new key was never part of an evaluated run.
import { sha256Hex } from './crypto.js';

export const EVALUATED_CONFIG_VERSION = 1;

/** Keys copied whole (after per-key normalisation). */
export const EVALUATED_WHOLE_KEYS = [
  'system_prompts',
  'ai_model',
  'live_backend_model',
  'crisis',
  'crisis_contact',
  'languages',
  'coping_strategies',
  'grok_voice',
  'grok_refusal_guard',
] as const;

/** Fields of system_config.features that alter prompts, tools or steering. */
export const EVALUATED_FEATURE_FIELDS = [
  'disabled_tools',
  'phase_guidance_enabled',
  'regrounding_enabled',
  'regrounding_interval_minutes',
  'proactive_offering',
  'psychoeducation_cue_ab_enabled',
  'lead_conversation_enabled',
] as const;

/** Fields of system_config.session_limits that alter prompts or steering. */
export const EVALUATED_SESSION_LIMIT_FIELDS = ['enabled', 'max_duration_minutes', 'vendor_ceiling_minutes'] as const;

/** Every system_config key that contributes to the fingerprint. */
export const EVALUATED_CONFIG_KEYS: readonly string[] = [...EVALUATED_WHOLE_KEYS, 'features', 'session_limits'];

/**
 * The evaluated configuration: every key present, `null` when the row is
 * absent on the environment (the code default applies there). `features` and
 * `session_limits` hold only the listed fields that are set.
 */
export type EvaluatedConfig = Record<string, unknown>;

export interface ConfigRowLike {
  config_key: string;
  config_value: unknown;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function pick(source: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (!isPlainObject(source)) return null;
  const out: Record<string, unknown> = {};
  for (const f of fields) if (source[f] !== undefined) out[f] = source[f];
  return out;
}

function normaliseSystemPrompts(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = { ...value };
  for (const k of ['realtime', 'chat']) {
    const entry = out[k];
    if (isPlainObject(entry)) {
      // last_modified is restamped on every admin save, even when the prompt
      // text is unchanged; it is provenance, not configuration.
      const { last_modified: _lastModified, ...rest } = entry;
      out[k] = rest;
    }
  }
  return out;
}

function normaliseAiModel(value: unknown): unknown {
  if (isPlainObject(value) && typeof value.model === 'string') return { model: value.model };
  return value;
}

function normaliseFeatures(value: unknown): Record<string, unknown> | null {
  const picked = pick(value, EVALUATED_FEATURE_FIELDS);
  if (picked && Array.isArray(picked.disabled_tools)) {
    // Order carries no meaning for the kill switch.
    picked.disabled_tools = [...new Set(picked.disabled_tools.map(String))].sort();
  }
  return picked;
}

/** Build the evaluated configuration from system_config rows (any order). */
export function buildEvaluatedConfig(rows: readonly ConfigRowLike[]): EvaluatedConfig {
  const byKey = new Map(rows.map((r) => [r.config_key, r.config_value]));
  const config: EvaluatedConfig = {};
  for (const key of EVALUATED_WHOLE_KEYS) {
    const raw = byKey.has(key) ? byKey.get(key) : null;
    if (raw === null || raw === undefined) config[key] = null;
    else if (key === 'system_prompts') config[key] = normaliseSystemPrompts(raw);
    else if (key === 'ai_model') config[key] = normaliseAiModel(raw);
    else config[key] = raw;
  }
  config.features = normaliseFeatures(byKey.get('features'));
  config.session_limits = pick(byKey.get('session_limits'), EVALUATED_SESSION_LIMIT_FIELDS);
  return config;
}

/**
 * Deterministic JSON: object keys sorted at every depth, `undefined` members
 * dropped (as JSON.stringify does), arrays kept in order. Two configurations
 * that differ only in key order or JSONB storage order hash identically.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** sha256 hex of the versioned, canonicalised evaluated configuration. */
export function fingerprintEvaluatedConfig(config: EvaluatedConfig): string {
  return sha256Hex(canonicalJson({ version: EVALUATED_CONFIG_VERSION, config }));
}

/** Fingerprint straight from system_config rows. */
export function fingerprintConfigRows(rows: readonly ConfigRowLike[]): string {
  return fingerprintEvaluatedConfig(buildEvaluatedConfig(rows));
}

// ---- snapshot file (export -> harness --config-snapshot) -------------------

export const CONFIG_SNAPSHOT_KIND = 'ai-therapist/evaluated-config';

export interface ConfigSnapshot {
  kind: typeof CONFIG_SNAPSHOT_KIND;
  version: number;
  fingerprint: string;
  /** Free-text label of the source environment (e.g. "stage", "prod"). */
  environment: string | null;
  exported_at: string;
  config: EvaluatedConfig;
}

export function buildConfigSnapshot(
  rows: readonly ConfigRowLike[],
  meta: { environment?: string | null; now?: Date } = {},
): ConfigSnapshot {
  const config = buildEvaluatedConfig(rows);
  return {
    kind: CONFIG_SNAPSHOT_KIND,
    version: EVALUATED_CONFIG_VERSION,
    fingerprint: fingerprintEvaluatedConfig(config),
    environment: meta.environment ?? null,
    exported_at: (meta.now ?? new Date()).toISOString(),
    config,
  };
}

/**
 * Validate an untrusted snapshot (a file handed to the harness): right kind
 * and version, exactly the evaluated keys, and a fingerprint that matches the
 * content. Throws with a readable message otherwise.
 */
export function parseConfigSnapshot(input: unknown): ConfigSnapshot {
  if (!isPlainObject(input)) throw new Error('config snapshot: not a JSON object');
  if (input.kind !== CONFIG_SNAPSHOT_KIND) throw new Error(`config snapshot: kind must be "${CONFIG_SNAPSHOT_KIND}"`);
  if (input.version !== EVALUATED_CONFIG_VERSION) {
    throw new Error(
      `config snapshot: version ${String(input.version)} does not match this code (${EVALUATED_CONFIG_VERSION}); re-export it with the same code version`,
    );
  }
  if (!isPlainObject(input.config)) throw new Error('config snapshot: config must be an object');
  const keys = Object.keys(input.config).sort();
  const expected = [...EVALUATED_CONFIG_KEYS].sort();
  if (keys.join(',') !== expected.join(',')) {
    throw new Error(`config snapshot: config keys [${keys.join(', ')}] do not match [${expected.join(', ')}]`);
  }
  for (const [key, fields] of [
    ['features', EVALUATED_FEATURE_FIELDS],
    ['session_limits', EVALUATED_SESSION_LIMIT_FIELDS],
  ] as const) {
    const v = input.config[key];
    if (v === null) continue;
    if (!isPlainObject(v)) throw new Error(`config snapshot: ${key} must be an object or null`);
    const extra = Object.keys(v).filter((f) => !(fields as readonly string[]).includes(f));
    if (extra.length)
      throw new Error(`config snapshot: ${key} has fields outside the evaluated set: ${extra.join(', ')}`);
  }
  const fingerprint = fingerprintEvaluatedConfig(input.config);
  if (input.fingerprint !== fingerprint) {
    throw new Error('config snapshot: fingerprint does not match its content (edited or truncated file?)');
  }
  return {
    kind: CONFIG_SNAPSHOT_KIND,
    version: EVALUATED_CONFIG_VERSION,
    fingerprint,
    environment: typeof input.environment === 'string' ? input.environment : null,
    exported_at: typeof input.exported_at === 'string' ? input.exported_at : '',
    config: input.config,
  };
}

/** Short display form of a fingerprint. */
export function shortFingerprint(fp: string): string {
  return fp.slice(0, 12);
}
