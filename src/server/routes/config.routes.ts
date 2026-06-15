import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../config/db.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getSystemConfig, getSystemPrompt, invalidateConfigCache } from '../utils/sessionHelpers.js';
import { getAiModel } from '../models/dbQueries.js';
import { createLogger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = createLogger('config');

export default function configRoutes() {
  const router = Router();

  // GET /api/config/crisis
  router.get("/api/config/crisis", asyncHandler(async (req, res) => {
    const config = await getSystemConfig();
    const crisisContact = config.crisis_contact || {
      hotline: 'BYU Counseling and Psychological Services',
      phone: '(801) 422-3035',
      text: 'HELLO to 741741',
      enabled: true
    };
    res.json(crisisContact);
  }));

  // GET /api/config/features
  router.get("/api/config/features", asyncHandler(async (req, res) => {
    const config = await getSystemConfig();
    const features = config.features || {
      voice_enabled: true,
      chat_enabled: true,
      file_upload_enabled: false,
      session_recording_enabled: false,
      output_modalities: ["audio"]
    };
    res.json(features);
  }));

  // GET /api/config/ai-model
  router.get("/api/config/ai-model", asyncHandler(async (req, res) => {
    const model = await getAiModel();
    res.json({ model });
  }));

  // GET /api/config/client-logging
  router.get("/api/config/client-logging", asyncHandler(async (req, res) => {
    const config = await getSystemConfig();
    const clientLogging = config.client_logging || { enabled: false };
    res.json(clientLogging);
  }));

  // GET /api/config/voices
  router.get("/api/config/voices", asyncHandler(async (req, res) => {
    const config = await getSystemConfig();
    const voicesConfig = config.voices || {
      voices: [{ value: 'cedar', label: 'Cedar', description: 'Warm & natural', enabled: true }],
      default_voice: 'cedar'
    };

    const enabledVoices = voicesConfig.voices
      ? voicesConfig.voices
          .filter(v => v.enabled)
          .map(v => ({ value: v.value, label: v.label, description: v.description }))
      : [];

    res.json({ voices: enabledVoices, default_voice: voicesConfig.default_voice });
  }));

  // GET /api/config/languages
  router.get("/api/config/languages", asyncHandler(async (req, res) => {
    const config = await getSystemConfig();
    const languagesConfig = config.languages || {
      languages: [{ value: 'en', label: 'English', description: 'English', enabled: true }],
      default_language: 'en'
    };

    const enabledLanguages = languagesConfig.languages
      ? languagesConfig.languages
          .filter(l => l.enabled)
          .map(l => ({ value: l.value, label: l.label, description: l.description }))
      : [];

    res.json({ languages: enabledLanguages, default_language: languagesConfig.default_language });
  }));

  // GET /api/voices/preview/:voiceName
  router.get("/api/voices/preview/:voiceName", async (req, res) => {
    try {
      const { voiceName } = req.params;
      const sanitizedVoiceName = path.basename(voiceName);
      const voiceFilePath = path.join(__dirname, '../../../OAI_VOICES', `${sanitizedVoiceName}.mp3`);

      if (!fs.existsSync(voiceFilePath)) {
        return res.status(404).json({ error: 'Voice preview not found' });
      }

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=86400');

      const stream = fs.createReadStream(voiceFilePath);
      stream.pipe(res);

      stream.on('error', (err) => {
        log.error({ err }, 'Error streaming voice preview');
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream voice preview' });
        }
      });
    } catch (err) {
      log.error({ err }, 'Failed to serve voice preview');
      res.status(500).json({ error: "Failed to serve voice preview" });
    }
  });

  // GET /admin/api/config
  router.get("/admin/api/config", requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const result = await pool.query('SELECT config_key, config_value, description, updated_at, updated_by FROM system_config ORDER BY config_key');

    const config = {};
    result.rows.forEach(row => {
      config[row.config_key] = {
        value: row.config_value,
        description: row.description,
        updated_at: row.updated_at,
        updated_by: row.updated_by
      };
    });

    res.json(config);
  }));

  // GET /admin/api/config/system-prompt-preview
  // NOTE: Must be defined BEFORE /admin/api/config/:key
  router.get("/admin/api/config/system-prompt-preview", requireRole('researcher'), asyncHandler(async (req, res) => {
    const { sessionType = 'realtime', language = 'en' } = req.query;

    if (!['realtime', 'chat'].includes(sessionType)) {
      return res.status(400).json({ error: 'sessionType must be either "realtime" or "chat"' });
    }

    const interpolatedPrompt = await getSystemPrompt(language, sessionType);

    res.json({
      success: true,
      sessionType,
      language,
      prompt: interpolatedPrompt,
      characterCount: interpolatedPrompt.length
    });
  }));

  // GET /admin/api/config/:key
  router.get("/admin/api/config/:key", requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { key } = req.params;

    const result = await pool.query(
      'SELECT config_key, config_value, description, updated_at, updated_by FROM system_config WHERE config_key = $1',
      [key]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Configuration key not found' });
    }

    res.json({
      key: result.rows[0].config_key,
      value: result.rows[0].config_value,
      description: result.rows[0].description,
      updated_at: result.rows[0].updated_at,
      updated_by: result.rows[0].updated_by
    });
  }));

  // PUT /admin/api/config/:key
  router.put("/admin/api/config/:key", requireRole('researcher'), asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { value } = req.body;

    if (!value) {
      return res.status(400).json({ error: 'Configuration value is required' });
    }

    // Validate voices config
    if (key === 'voices') {
      if (!value.voices || !Array.isArray(value.voices)) {
        return res.status(400).json({ error: 'voices must be an array' });
      }
      const enabledVoices = value.voices.filter(v => v.enabled);
      if (enabledVoices.length === 0) {
        return res.status(400).json({ error: 'At least one voice must be enabled' });
      }
      const defaultVoice = value.voices.find(v => v.value === value.default_voice && v.enabled);
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
      const enabledLanguages = value.languages.filter(l => l.enabled);
      if (enabledLanguages.length === 0) {
        return res.status(400).json({ error: 'At least one language must be enabled' });
      }
      const defaultLanguage = value.languages.find(l => l.value === value.default_language && l.enabled);
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

    const result = await pool.query(
      `UPDATE system_config
       SET config_value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
       WHERE config_key = $3
       RETURNING *`,
      [JSON.stringify(value), req.session.username, key]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Configuration key not found' });
    }

    // Invalidate cache to force refresh
    invalidateConfigCache();

    log.info({ key, updatedBy: req.session.username }, 'Config updated');

    res.json({
      success: true,
      key: result.rows[0].config_key,
      value: result.rows[0].config_value,
      updated_at: result.rows[0].updated_at,
      updated_by: result.rows[0].updated_by
    });
  }));

  return router;
}
