// System configuration admin API (therapist/researcher). Reads and edits the
// system_config key/value store that drives crisis contacts, voices, languages
// and system prompts. Public read-only config endpoints live in
// routes/public/config.routes.ts; this router is the privileged write side.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  getAllSystemConfig,
  getSystemConfigByKey,
  updateSystemConfig,
  upsertSystemConfig,
  type VoiceOption,
  type LanguageOption,
} from '../../db/index.js';
import { getSystemPrompt, invalidateConfigCache, DEFAULT_MODALITY_PRESETS } from '../../utils/sessionHelpers.js';

import { createLogger } from '../../utils/logger.js';

const log = createLogger('adminConfigRoutes');

/**
 * Keys the admin PUT may CREATE when the row is missing (ai-therapist-275):
 * every key docs/system-config-keys.md lists as admin-editable through this
 * route, with the description a freshly created row gets. Migration 110 seeds
 * most of them, but a database that predates it (or a key such as
 * live_backend_model that no migration seeds) must still be writable from the
 * UI instead of 404ing after the form reports success.
 *
 * Deliberately absent:
 *   crisis_alert  on-call paging; seeded by 044, semantics in docs/on-call-sop.md.
 *                 Stays UPDATE-only so this route can never create a paging
 *                 config that no migration or SOP placed.
 *   content_retention, data_retention, study_protocol  own dedicated routes.
 *   qualtrics.*, work_queue.*, sim_session_*  runtime-written internals.
 * Any key outside the allowlist keeps today's behaviour: updated when the row
 * exists, 404 when it does not.
 */
export const UPSERTABLE_CONFIG_KEYS: Readonly<Record<string, string>> = {
  ai_model: 'Voice/session model id (grok-voice-* selects the Grok proxy, gpt-live-* GPT-Live)',
  live_backend_model: 'Delegated reasoning model behind GPT-Live',
  transcription_model: 'Transcription model (unused since migration 099: GPT-Live and Grok transcribe internally)',
  transcription_context: 'Transcription prompt/keyword overrides (unused since migration 099)',
  system_prompts: 'System prompts for realtime and chat sessions, plus modality presets',
  features: 'Feature flags to enable/disable functionality',
  session_limits: 'Session duration and frequency limits',
  crisis_contact: 'Crisis contact information displayed to users',
  crisis: 'Crisis risk assessor model and risk-check trigger score',
  voices: 'Available voice options',
  languages: 'Available language options',
  client_logging: 'Enable client-side console logging for debugging',
  deployment_mode: 'Deployment posture: research or clinical',
  evals: 'Eval-system settings (drift monitoring, harness schedule)',
  message_embeddings: 'Background embedding of redacted messages for semantic search',
  redaction_verifier: 'LLM leak check on redacted transcripts',
  attention_ranking: 'Needs-attention scoring for the caseworker dashboard roster',
  email_notifications: 'Kill switch for all outbound email',
  coping_strategies: 'Per-category overrides for the built-in coping technique library',
  grok_voice: 'Grok Voice turn-taking and latency knobs forwarded to session.update',
  grok_refusal_guard: 'Grok Voice refusal-loop breaker',
};

export default function adminConfigRoutes(): Router {
  const router = Router();

  // GET /admin/api/config/modality-defaults - built-in therapeutic-approach
  // presets, used by the SystemPrompts UI to bootstrap editing before any
  // custom presets have been saved to system_config.
  router.get('/admin/api/config/modality-defaults', requireRole('therapist', 'researcher'), (_req, res) => {
    res.json({ presets: DEFAULT_MODALITY_PRESETS });
  });

  // GET /admin/api/tools - registered AI tools with enabled state + usage
  // counts, for the SystemConfig tools panel (ai-therapist-32).
  router.get('/admin/api/tools', requireRole('therapist', 'researcher'), async (_req, res) => {
    try {
      const { toolRegistry } = await import('../../services/toolRegistry.service.js');
      const { getToolInvocationStats } = await import('../../db/index.js');
      const [enabled, stats] = await Promise.all([
        toolRegistry.getEnabledToolDefinitions(),
        getToolInvocationStats(),
      ]);
      const enabledNames = new Set(enabled.map(d => d.name));
      const statsByName = new Map(stats.map(s => [s.tool_name, s]));
      const tools = toolRegistry.getAllToolDefinitions().map(def => ({
        name: def.name,
        description: def.description,
        enabled: enabledNames.has(def.name),
        invocations: statsByName.get(def.name)?.invocations ?? 0,
        sessions: statsByName.get(def.name)?.sessions ?? 0,
        last_used: statsByName.get(def.name)?.last_used ?? null,
      }));
      res.json({ tools });
    } catch (err) {
      log.error({ err }, 'Failed to list tools');
      res.status(500).json({ error: 'Failed to list tools' });
    }
  });

  // GET /admin/api/config - all configuration, keyed by config_key
  router.get('/admin/api/config', requireRole('therapist', 'researcher'), async (_req, res) => {
    try {
      const rows = await getAllSystemConfig();
      const config: Record<string, unknown> = {};
      rows.forEach(row => {
        config[row.config_key] = {
          value: row.config_value,
          description: row.description,
          updated_at: row.updated_at,
          updated_by: row.updated_by,
        };
      });
      // deployment_mode (migration 060) always appears in the response, even
      // on databases that predate the row — default is the research posture.
      if (!config.deployment_mode) {
        config.deployment_mode = {
          value: { mode: 'research' },
          description: 'Deployment posture: research or clinical (default; migration 060 seeds the row, this database predates it)',
          updated_at: null,
          updated_by: null,
        };
      }
      res.json(config);
    } catch (err) {
      log.error({ err }, 'Failed to fetch system configuration');
      res.status(500).json({ error: 'Failed to fetch system configuration' });
    }
  });

  // GET /admin/api/config/system-prompt-preview - fully interpolated prompt.
  // Must be registered BEFORE /admin/api/config/:key so it isn't matched as a key.
  router.get('/admin/api/config/system-prompt-preview', requireRole('researcher'), async (req, res) => {
    const sessionType = typeof req.query.sessionType === 'string' ? req.query.sessionType : 'realtime';
    const language = typeof req.query.language === 'string' ? req.query.language : 'en';

    if (!['realtime', 'chat'].includes(sessionType)) {
      return res.status(400).json({ error: 'sessionType must be either "realtime" or "chat"' });
    }

    try {
      const interpolatedPrompt = await getSystemPrompt(language, sessionType);
      res.json({
        success: true,
        sessionType,
        language,
        prompt: interpolatedPrompt,
        characterCount: interpolatedPrompt.length,
      });
    } catch (err) {
      log.error({ err }, 'Failed to generate system prompt preview');
      res.status(500).json({ error: 'Failed to generate system prompt preview' });
    }
  });

  // GET /admin/api/config/:key - a single configuration entry
  router.get('/admin/api/config/:key', requireRole('therapist', 'researcher'), async (req, res) => {
    const { key } = req.params;
    try {
      const row = await getSystemConfigByKey(key);
      if (!row) {
        // Same fallback as the list endpoint: deployment_mode reads as
        // 'research' until the migration-060 row exists.
        if (key === 'deployment_mode') {
          return res.json({
            key,
            value: { mode: 'research' },
            description: 'Deployment posture: research or clinical (default; migration 060 seeds the row, this database predates it)',
            updated_at: null,
            updated_by: null,
          });
        }
        return res.status(404).json({ error: 'Configuration key not found' });
      }
      res.json({
        key: row.config_key,
        value: row.config_value,
        description: row.description,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      });
    } catch (err) {
      log.error({ err }, 'Failed to fetch configuration');
      res.status(500).json({ error: 'Failed to fetch configuration' });
    }
  });

  // PUT /admin/api/config/:key - update a configuration entry
  router.put('/admin/api/config/:key', requireRole('researcher'), async (req, res) => {
    const { key } = req.params;
    const { value } = req.body;

    if (!value) {
      return res.status(400).json({ error: 'Configuration value is required' });
    }

    try {
      // Validate voices config
      if (key === 'voices') {
        if (!value.voices || !Array.isArray(value.voices)) {
          return res.status(400).json({ error: 'voices must be an array' });
        }
        const enabledVoices = (value.voices as VoiceOption[]).filter(v => v.enabled);
        if (enabledVoices.length === 0) {
          return res.status(400).json({ error: 'At least one voice must be enabled' });
        }
        const defaultVoice = (value.voices as VoiceOption[]).find(v => v.value === value.default_voice && v.enabled);
        if (!defaultVoice) {
          return res.status(400).json({ error: 'default_voice must be one of the enabled voices' });
        }
        for (const voice of value.voices) {
          if (!voice.value || !voice.label) {
            return res.status(400).json({ error: 'Each voice must have value and label' });
          }
        }
      }

      // Validate languages config
      if (key === 'languages') {
        if (!value.languages || !Array.isArray(value.languages)) {
          return res.status(400).json({ error: 'languages must be an array' });
        }
        const enabledLanguages = (value.languages as LanguageOption[]).filter(l => l.enabled);
        if (enabledLanguages.length === 0) {
          return res.status(400).json({ error: 'At least one language must be enabled' });
        }
        const defaultLanguage = (value.languages as LanguageOption[]).find(l => l.value === value.default_language && l.enabled);
        if (!defaultLanguage) {
          return res.status(400).json({ error: 'default_language must be one of the enabled languages' });
        }
        for (const language of value.languages) {
          if (!language.value || !language.label) {
            return res.status(400).json({ error: 'Each language must have value and label' });
          }
        }
      }

      // Validate system_prompts config
      if (key === 'system_prompts') {
        if (!value.realtime || !value.chat) {
          return res.status(400).json({ error: 'system_prompts must have both realtime and chat prompts' });
        }
        for (const promptType of ['realtime', 'chat']) {
          if (!value[promptType].prompt) {
            return res.status(400).json({ error: `${promptType} prompt is required` });
          }
          if (value[promptType].prompt.length < 100) {
            return res.status(400).json({ error: `${promptType} prompt must be at least 100 characters` });
          }
        }
        const now = new Date().toISOString();
        value.realtime.last_modified = now;
        value.chat.last_modified = now;
      }

      // Allowlisted keys are upserted so a fresh database (or one predating
      // the seed migration) gets the row on first save; everything else is an
      // UPDATE that 404s when the row is absent, so arbitrary keys cannot be
      // created from the UI.
      const description = Object.prototype.hasOwnProperty.call(UPSERTABLE_CONFIG_KEYS, key)
        ? UPSERTABLE_CONFIG_KEYS[key]
        : undefined;
      const updated = description !== undefined
        ? await upsertSystemConfig(key, value, req.session.username, description)
        : await updateSystemConfig(key, value, req.session.username);
      if (!updated) {
        return res.status(404).json({ error: 'Configuration key not found' });
      }

      // Force the public/realtime config cache to reload on next read.
      invalidateConfigCache();

      log.info(`Config updated: ${key} by ${req.session.username}`);

      res.json({
        success: true,
        key: updated.config_key,
        value: updated.config_value,
        updated_at: updated.updated_at,
        updated_by: updated.updated_by,
      });
    } catch (err) {
      log.error({ err }, 'Failed to update configuration');
      res.status(500).json({ error: 'Failed to update configuration' });
    }
  });

  return router;
}
