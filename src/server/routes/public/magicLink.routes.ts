// Magic-link demo access. A single signed link (put on a resume) auto-provisions
// a throwaway 'demo' account, logs the visitor in, and drops them into the admin
// dashboard — which serves fully synthetic data for demo accounts (see
// routes/demo.routes.ts). Demo accounts can also try the real therapy app, but
// capped hard (5 sessions/day, 5 min each; see sessionHelpers).
//
// The link is gated by DEMO_MAGIC_TOKEN. If that env var is unset the feature is
// disabled and the route 404s like any unknown path.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { tokensMatch } from '../../utils/crypto.js';
import { createDemoUser } from '../../db/index.js';

export default function magicLinkRoutes(): Router {
  const router = Router();

  // Cap account creation from a single IP so the link can't be scripted into
  // flooding the users table. Generous enough for real recruiters sharing an IP.
  const demoLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many demo sessions from this network. Please try again later.',
  });

  router.get('/demo/:token', demoLimiter, async (req, res, next) => {
    const expected = process.env.DEMO_MAGIC_TOKEN;

    // Feature disabled (no token configured) or wrong token: behave like an
    // unknown route so the link reveals nothing. next() falls through to SSR.
    if (!expected || !req.params.token || !tokensMatch(req.params.token, expected)) {
      return next();
    }

    try {
      // Reuse an existing demo session on refresh instead of minting a new user
      // every visit.
      if (req.session?.userId && req.session.userRole === 'demo') {
        return res.redirect('/demo');
      }

      const demoUser = await createDemoUser();

      req.session.userId = demoUser.userid;
      req.session.username = demoUser.username;
      req.session.userRole = 'demo';
      req.session.mfaVerified = true;

      req.session.save((err) => {
        if (err) {
          console.error('[MagicLink] Session save error:', err);
          return res.status(500).send('Could not start demo session.');
        }
        console.log(`[MagicLink] Provisioned demo account ${demoUser.username} (id ${demoUser.userid})`);
        res.redirect('/demo');
      });
    } catch (error) {
      console.error('[MagicLink] Failed to provision demo account:', error);
      res.status(500).send('Could not start demo session.');
    }
  });

  return router;
}
