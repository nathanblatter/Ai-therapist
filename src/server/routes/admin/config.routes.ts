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
  type VoiceOption,
  type LanguageOption,
} from '../../db/index.js';
import { getSystemPrompt, invalidateConfigCache } from '../../utils/sessionHelpers.js';

export default function adminConfigRoutes(): Router {
  const router = Router();

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
      res.json(config);
    } catch (err) {
      console.error('Failed to fetch system configuration:', err);
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
      console.error('Failed to generate system prompt preview:', err);
      res.status(500).json({ error: 'Failed to generate system prompt preview' });
    }
  });

  // GET /admin/api/config/:key - a single configuration entry
  router.get('/admin/api/config/:key', requireRole('therapist', 'researcher'), async (req, res) => {
    const { key } = req.params;
    try {
      const row = await getSystemConfigByKey(key);
      if (!row) {
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
      console.error('Failed to fetch configuration:', err);
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

      const updated = await updateSystemConfig(key, value, req.session.username);
      if (!updated) {
        return res.status(404).json({ error: 'Configuration key not found' });
      }

      // Force the public/realtime config cache to reload on next read.
      invalidateConfigCache();

      console.log(`Config updated: ${key} by ${req.session.username}`);

      res.json({
        success: true,
        key: updated.config_key,
        value: updated.config_value,
        updated_at: updated.updated_at,
        updated_by: updated.updated_by,
      });
    } catch (err) {
      console.error('Failed to update configuration:', err);
      res.status(500).json({ error: 'Failed to update configuration' });
    }
  });

  return router;
}
