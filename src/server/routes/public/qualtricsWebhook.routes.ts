// Real-time Qualtrics completion webhook (ai-therapist-149). Each survey has
// a Qualtrics Workflow that POSTs {surveyId, responseId} here the moment a
// response is submitted, so linkage + adverse-experience triage run in
// seconds instead of waiting for the scheduled bulk sync (which remains the
// catch-all backstop). Auth: shared secret in the X-Webhook-Token header,
// compared constant-time; unset QUALTRICS_WEBHOOK_SECRET disables the route
// (404 like an unknown path). We re-fetch the response from the Qualtrics
// API rather than trusting the webhook body — the payload is a pointer, so a
// forged request can at worst make us re-sync a real response.
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { handleResponseWebhook } from '../../services/qualtricsSync.service.js';

function secretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default function qualtricsWebhookRoutes(): Router {
  const router = Router();

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post('/api/qualtrics/webhook', limiter, async (req, res, next) => {
    const secret = process.env.QUALTRICS_WEBHOOK_SECRET;
    if (!secret) return next(); // feature off: behave like an unknown route
    if (!secretMatches(req.get('X-Webhook-Token'), secret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { surveyId, responseId } = req.body ?? {};
    if (
      typeof surveyId !== 'string' || !/^SV_[A-Za-z0-9]+$/.test(surveyId) ||
      typeof responseId !== 'string' || !/^R_[A-Za-z0-9]+$/.test(responseId)
    ) {
      return res.status(400).json({ error: 'surveyId and responseId are required' });
    }

    try {
      const outcome = await handleResponseWebhook(surveyId, responseId);
      switch (outcome) {
        case 'ok':
          return res.json({ success: true });
        case 'disabled':
          return res.status(503).json({ error: 'Qualtrics integration is not configured' });
        case 'unknown-survey':
          return res.status(400).json({ error: 'Survey is not part of this study' });
        case 'not-found':
          // Qualtrics indexes responses asynchronously; 503 asks its retry
          // policy to redeliver, and the bulk sync catches any that never do.
          return res.status(503).json({ error: 'Response not available yet - retry' });
      }
    } catch (err) {
      console.error('[QualtricsWebhook] failed:', err);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
}
