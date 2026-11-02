// Staff email from the admin app (ai-therapist-283, phase 2). Researcher
// only; every send is recorded in outbound_mail. Self-scoped: a researcher
// sees only mail they sent.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { listOutboundMailForUser } from '../../db/index.js';
import { sendStaffMail, senderStatus, MailComposeError } from '../../services/mailCompose.service.js';
import { parsePagination } from '../../utils/pagination.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('mailRoutes');

export default function mailRoutes(): Router {
  const router = Router();

  // GET /admin/api/mail/me — can this account send, from what address, how much today.
  router.get('/admin/api/mail/me', requireRole('researcher'), async (req, res) => {
    try {
      res.json(await senderStatus(req.session.userId!));
    } catch (err) {
      log.error({ err }, 'sender status failed');
      res.status(500).json({ error: 'Failed to load mail status' });
    }
  });

  // POST /admin/api/mail/send { to, cc?, subject, text, in_reply_to? }
  router.post('/admin/api/mail/send', requireRole('researcher'), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const row = await sendStaffMail({
        senderUserId: req.session.userId!,
        to: body.to,
        cc: body.cc,
        subject: body.subject,
        text: body.text,
        inReplyTo: body.in_reply_to,
      });
      res.json({ success: true, mail: { ...row, body_text: undefined } });
    } catch (err) {
      if (err instanceof MailComposeError) return res.status(err.status).json({ error: err.message });
      log.error({ err }, 'staff mail send failed');
      res.status(500).json({ error: 'Failed to send mail' });
    }
  });

  // GET /admin/api/mail/sent?limit=&offset= — the caller's own sent mail.
  router.get('/admin/api/mail/sent', requireRole('researcher'), async (req, res) => {
    try {
      const { limit, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultLimit: 50,
        maxLimit: 200,
      });
      const rows = await listOutboundMailForUser(req.session.userId!, { limit, offset });
      res.json({ mail: rows });
    } catch (err) {
      log.error({ err }, 'sent mail list failed');
      res.status(500).json({ error: 'Failed to load sent mail' });
    }
  });

  return router;
}
