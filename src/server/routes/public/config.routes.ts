// Public (bot-facing) configuration endpoints. No auth required.
import { Router } from 'express';
import { getSystemConfig } from '../../utils/sessionHelpers.js';
import { getAiModel, type VoicesConfig, type LanguagesConfig } from '../../db/index.js';

export default function configRoutes(): Router {
  const router = Router();

  // GET /api/config/crisis - crisis contact info
  router.get('/api/config/crisis', async (_req, res) => {
    try {
      const config = await getSystemConfig();
      const crisisContact = config.crisis_contact || {
        hotline: '988 Suicide & Crisis Lifeline',
        phone: '988',
        text: 'Text HOME to 741741',
        enabled: true,
      };
      res.json(crisisContact);
    } catch (err) {
      console.error('Failed to fetch crisis contact:', err);
      res.status(500).json({ error: 'Failed to fetch crisis contact' });
    }
  });

  // GET /api/config/features - feature flags
  router.get('/api/config/features', async (_req, res) => {
    try {
      const config = await getSystemConfig();
      const features = config.features || {
        voice_enabled: true,
        chat_enabled: true,
        session_recording_enabled: false,
        output_modalities: ['audio'],
      };
      res.json(features);
    } catch (err) {
      console.error('Failed to fetch features config:', err);
      res.status(500).json({ error: 'Failed to fetch features config' });
    }
  });

  // GET /api/config/ai-model - selected AI model
  router.get('/api/config/ai-model', async (_req, res) => {
    try {
      const model = await getAiModel();
      res.json({ model });
    } catch (err) {
      console.error('Failed to fetch AI model:', err);
      res.status(500).json({ error: 'Failed to fetch AI model configuration' });
    }
  });

  // GET /api/config/client-logging - client logging config
  router.get('/api/config/client-logging', async (_req, res) => {
    try {
      const config = await getSystemConfig();
      const clientLogging = config.client_logging || { enabled: false };
      res.json(clientLogging);
    } catch (err) {
      console.error('Failed to fetch client logging config:', err);
      res.status(500).json({ error: 'Failed to fetch client logging config' });
    }
  });

  // GET /api/config/voices - enabled voices with metadata
  router.get('/api/config/voices', async (_req, res) => {
    try {
      const config = await getSystemConfig();
      const voicesConfig = (config.voices as VoicesConfig | undefined) ?? {
        voices: [{ value: 'cedar', label: 'Cedar', description: 'Warm & natural', enabled: true }],
        default_voice: 'cedar',
      };

      const enabledVoices = voicesConfig.voices
        ? voicesConfig.voices
            .filter((v) => v.enabled)
            .map((v) => ({ value: v.value, label: v.label, description: v.description }))
        : [];

      res.json({ voices: enabledVoices, default_voice: voicesConfig.default_voice });
    } catch (err) {
      console.error('Failed to fetch voices config:', err);
      res.status(500).json({ error: 'Failed to fetch voices config' });
    }
  });

  // GET /api/config/languages - enabled languages with metadata
  router.get('/api/config/languages', async (_req, res) => {
    try {
      const config = await getSystemConfig();
      const languagesConfig = (config.languages as LanguagesConfig | undefined) ?? {
        languages: [{ value: 'en', label: 'English', description: 'English', enabled: true }],
        default_language: 'en',
      };

      const enabledLanguages = languagesConfig.languages
        ? languagesConfig.languages
            .filter((l) => l.enabled)
            .map((l) => ({ value: l.value, label: l.label, description: l.description }))
        : [];

      res.json({ languages: enabledLanguages, default_language: languagesConfig.default_language });
    } catch (err) {
      console.error('Failed to fetch languages config:', err);
      res.status(500).json({ error: 'Failed to fetch languages config' });
    }
  });

  return router;
}
