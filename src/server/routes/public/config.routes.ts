// Public (bot-facing) configuration endpoints. No auth required.
import { Router } from 'express';
import { getSystemConfig } from '../../utils/sessionHelpers.js';
import { getQuietHoursStatus } from '../../utils/quietHours.js';
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

  // GET /api/config/quiet-hours - overnight session-blocking window
  // (ai-therapist-152). The client pre-checks this on load so participants
  // see the overnight screen instead of a failed start. blocksYou mirrors the
  // middleware's role logic: only (non-sandbox) participants are gated.
  router.get('/api/config/quiet-hours', (req, res) => {
    const status = getQuietHoursStatus();
    const role = req.session?.userRole ?? 'participant';
    const gated = role === 'participant' && req.session?.isSandbox !== true;
    res.json({ ...status, blocksYou: status.active && gated });
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
  //
  // Two things happen here beyond reading system_config, both added with the
  // GPT-Live migration:
  //
  //  1. Every configured voice is validated against the GPT-Live voice registry
  //     and enriched from it. An admin typo in system_config would otherwise
  //     reach the participant's picker, then 400 the session creation at the
  //     moment they press start — a failure with no useful explanation. Unknown
  //     voices are dropped here instead, and logged.
  //  2. Each voice reports whether a bundled preview clip exists. The twelve
  //     voices introduced with gpt-live-1 ship no preview audio, so the picker
  //     needs to hide the play control for them rather than offer a button that
  //     404s.
  //
  // Optional ?language= filters to voices appropriate for that language: Bossa
  // and Tempo are Brazilian Portuguese and sound wrong reading English.
  router.get('/api/config/voices', async (req, res) => {
    try {
      const [{ getLiveVoice, liveVoicesForLanguage, LIVE_DEFAULT_VOICE }, { voicePreviewExists }] =
        await Promise.all([
          import('../../utils/liveSessionConfig.js'),
          import('../../utils/voicePreviews.js'),
        ]);

      const config = await getSystemConfig();
      const voicesConfig = config.voices as VoicesConfig | undefined;

      const language = typeof req.query.language === 'string' ? req.query.language : null;
      const allowed = new Set(liveVoicesForLanguage(language).map(v => v.value));

      const configured = voicesConfig?.voices?.filter(v => v.enabled) ?? [];
      const unknown: string[] = [];

      const voices = configured
        .filter(v => {
          if (!getLiveVoice(v.value)) { unknown.push(v.value); return false; }
          return allowed.has(v.value);
        })
        .map(v => {
          const meta = getLiveVoice(v.value)!;
          return {
            value: v.value,
            // Admin-authored label/description win; the registry fills any gap.
            label: v.label || meta.label,
            description: v.description || meta.description,
            accent: meta.accent,
            presentation: meta.presentation,
            source: meta.source,
            hasPreview: voicePreviewExists(v.value),
          };
        });

      if (unknown.length > 0) {
        console.warn(
          `[Config] Dropping voice(s) not supported by GPT-Live: ${unknown.join(', ')}. ` +
          'Fix system_config.voices — these would fail at session creation.',
        );
      }

      // Fall back through: configured default -> first offered voice -> the
      // documented GPT-Live default. Never return a default that is not in the
      // list we just returned, or the picker opens with nothing selected.
      const configuredDefault = voicesConfig?.default_voice;
      const defaultVoice =
        (configuredDefault && voices.some(v => v.value === configuredDefault) && configuredDefault) ||
        voices[0]?.value ||
        LIVE_DEFAULT_VOICE;

      res.json({ voices, default_voice: defaultVoice });
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
