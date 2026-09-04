// Real-time Qualtrics completion webhook (ai-therapist-149). Each survey has
// a Qualtrics Workflow that POSTs {surveyId, responseId} here the moment a
// response is submitted, so linkage + adverse-experience triage run in
// seconds instead of waiting for the scheduled bulk sync (which remains the
// catch-all backstop). Auth: an API key sent by the Qualtrics WebService
// credential (X-API-TOKEN; X-Webhook-Token also accepted for manual senders),
// verified against a bcrypt hash like account passwords — the server env
// never holds the usable key (QUALTRICS_WEBHOOK_SECRET_HASH; generate with
//   node -e "require('bcrypt').hash(process.argv[1],10).then(console.log)" <key>
// and keep the key itself only in the Qualtrics extension credential). Unset
// hash disables the route (404 like an unknown path). We re-fetch the
// response from the Qualtrics API rather than trusting the webhook body —
// the payload is a pointer, so a forged request can at worst make us re-sync
// a real response.
import { Router } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { handleResponseWebhook } from '../../services/qualtricsSync.service.js';

async function secretMatches(
  req: { get(name: string): string | undefined },
  hash: string
): Promise<boolean> {
  const provided = req.get('X-API-TOKEN') ?? req.get('X-Webhook-Token');
  if (typeof provided !== 'string' || provided.length === 0 || provided.length > 512) return false;
  return bcrypt.compare(provided, hash);
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
    const secretHash = process.env.QUALTRICS_WEBHOOK_SECRET_HASH;
    if (!secretHash) return next(); // feature off: behave like an unknown route
    if (!(await secretMatches(req, secretHash))) {
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
