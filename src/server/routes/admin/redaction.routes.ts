// Redaction-verification API (researcher only): review and correct the
// auto-redacted message content. Mounted before the /redact SSR catch-all.
// Organization scoping (ai-therapist-272): the queue and backlog count are
// scoped to the caller's org in SQL (anonymous sessions: irb-study org only);
// the by-id correct/approve writes go through requireMessageClientAccess,
// which 404s a message whose session owner is outside the caller's org.
import { Router, type Request } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { requireMessageClientAccess } from '../../middleware/caseload.js';
import { orgIdFor } from '../../middleware/org.js';
import {
  getRandomRedactedMessages,
  countLeakCheckBacklog,
  updateRedactedContent,
  recordRedactionApproval,
} from '../../db/index.js';

import { createLogger } from '../../utils/logger.js';

const log = createLogger('redactionRoutes');

/** The caller's org; orgIdFor throws on lookup failure (-> 500). Null means
 *  unauthenticated, impossible past requireRole — fail closed, never unscoped. */
async function callerOrgId(req: Request): Promise<number> {
  const orgId = await orgIdFor(req);
  if (orgId === null) throw new Error('[redaction] unauthenticated caller reached a scoped read');
  return orgId;
}

/**
 * A correction or an approval changes what the working-alliance judge may
 * read of the session (ai-therapist-173): the corrected text, or a message
 * the leak check had withheld and the reviewer has now released. Tell the
 * rating job, fire-and-forget. It does nothing unless
 * system_config.alliance_markers is enabled, and it can never fail the
 * review request.
 */
function notifyAllianceRatingOfReview(messageId: string): void {
  import('../../services/allianceRating.service.js')
    .then((m) => m.maybeRateAllianceAfterLeakReview(messageId))
    .catch((err) => log.error({ err }, 'alliance rating after review could not start (non-fatal)'));
  // The session-features judge (ai-therapist-172) reads the same messages
  // under the same rule: same notification, behind its own switch
  // (system_config.session_features, default off).
  import('../../services/sessionFeatures.service.js')
    .then((m) => m.maybeExtractFeaturesAfterLeakReview(messageId))
    .catch((err) => log.error({ err }, 'session features after review could not start (non-fatal)'));
}

export default function redactionRoutes(): Router {
  const router = Router();

  // GET /redact/api/messages - review queue: leak-flagged messages first
  // (ai-therapist-262), then errored checks (ai-therapist-288), then a random
  // sample; plus the size of each backlog.
  router.get('/redact/api/messages', requireRole('researcher'), async (req, res) => {
    try {
      const orgId = await callerOrgId(req);
      const [messages, backlog] = await Promise.all([getRandomRedactedMessages(orgId), countLeakCheckBacklog(orgId)]);
      res.json({
        messages,
        flagged_unreviewed: backlog.flaggedUnreviewed,
        errored_unreviewed: backlog.erroredUnreviewed,
      });
    } catch (err) {
      log.error({ err }, 'Failed to fetch redacted messages');
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // PUT /redact/api/messages/:id - save corrected redacted content
  router.put(
    '/redact/api/messages/:id',
    requireRole('researcher'),
    requireMessageClientAccess('id'),
    async (req, res) => {
      const { id } = req.params;
      const { content_redacted } = req.body;

      if (content_redacted === undefined) {
        return res.status(400).json({ error: 'content_redacted field is required' });
      }

      try {
        // Accountability (091): the correction and its redaction_review_log row
        // are written together, stamped with the reviewing researcher.
        const updated = await updateRedactedContent(id, content_redacted, req.session.userId ?? null);
        if (!updated) {
          return res.status(404).json({ error: 'Message not found' });
        }
        res.json({ success: true });
        notifyAllianceRatingOfReview(id);
      } catch (err) {
        log.error({ err }, 'Failed to update redacted content');
        res.status(500).json({ error: 'Failed to update message' });
      }
    },
  );

  // POST /redact/api/messages/:id/approve - record a no-change sign-off
  // (reviewer inspected the sampled message and the auto-redaction stands).
  router.post(
    '/redact/api/messages/:id/approve',
    requireRole('researcher'),
    requireMessageClientAccess('id'),
    async (req, res) => {
      const { id } = req.params;
      try {
        const recorded = await recordRedactionApproval(id, req.session.userId ?? null);
        if (!recorded) {
          return res.status(404).json({ error: 'Message not found' });
        }
        res.json({ success: true });
        notifyAllianceRatingOfReview(id);
      } catch (err) {
        log.error({ err }, 'Failed to record redaction approval');
        res.status(500).json({ error: 'Failed to record approval' });
      }
    },
  );

  return router;
}
