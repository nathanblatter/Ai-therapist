// Redaction-verification API (researcher only): review and correct the
// auto-redacted message content. Mounted before the /redact SSR catch-all.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  getRandomRedactedMessages,
  updateRedactedContent,
  recordRedactionApproval,
} from '../../db/index.js';

export default function redactionRoutes(): Router {
  const router = Router();

  // GET /redact/api/messages - random sample of redacted messages
  router.get('/redact/api/messages', requireRole('researcher'), async (_req, res) => {
    try {
      const messages = await getRandomRedactedMessages();
      res.json({ messages });
    } catch (err) {
      console.error('Failed to fetch redacted messages:', err);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // PUT /redact/api/messages/:id - save corrected redacted content
  router.put('/redact/api/messages/:id', requireRole('researcher'), async (req, res) => {
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
    } catch (err) {
      console.error('Failed to update redacted content:', err);
      res.status(500).json({ error: 'Failed to update message' });
    }
  });

  // POST /redact/api/messages/:id/approve - record a no-change sign-off
  // (reviewer inspected the sampled message and the auto-redaction stands).
  router.post('/redact/api/messages/:id/approve', requireRole('researcher'), async (req, res) => {
    const { id } = req.params;
    try {
      const recorded = await recordRedactionApproval(id, req.session.userId ?? null);
      if (!recorded) {
        return res.status(404).json({ error: 'Message not found' });
      }
      res.json({ success: true });
    } catch (err) {
      console.error('Failed to record redaction approval:', err);
      res.status(500).json({ error: 'Failed to record approval' });
    }
  });

  return router;
}
