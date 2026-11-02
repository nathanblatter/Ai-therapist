// Staff email from the admin app (ai-therapist-283, phase 2). Researcher
// only; every send is recorded in outbound_mail. Self-scoped: a researcher
// sees only mail they sent.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { listOutboundMailForUser } from '../../db/index.js';
import { sendStaffMail, senderStatus, MailComposeError } from '../../services/mailCompose.service.js';
import {
  listMailboxFor,
  readMailboxMessage,
  markMailboxMessageRead,
  MailInboxError,
} from '../../services/mailInbox.service.js';
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

  // --- Inbox (phase 3): the caller's own mailbox on the study domain. ---

  // GET /admin/api/mail/inbox?limit=&unread=1
  router.get('/admin/api/mail/inbox', requireRole('researcher'), async (req, res) => {
    try {
      const { limit } = parsePagination(req.query as Record<string, unknown>, { defaultLimit: 50, maxLimit: 200 });
      const unread = req.query.unread === '1' || req.query.unread === 'true';
      res.json(await listMailboxFor(req.session.userId!, { limit, unread }));
    } catch (err) {
      if (err instanceof MailInboxError) return res.status(err.status).json({ error: err.message });
      log.error({ err }, 'inbox list failed');
      res.status(500).json({ error: 'Failed to load the inbox' });
    }
  });

  // GET /admin/api/mail/inbox/:id?mark_read=1 — text only; 404 unless delivered to the caller.
  router.get('/admin/api/mail/inbox/:id', requireRole('researcher'), async (req, res) => {
    try {
      const markRead = req.query.mark_read === '1' || req.query.mark_read === 'true';
      res.json({ message: await readMailboxMessage(req.session.userId!, req.params.id, { markRead }) });
    } catch (err) {
      if (err instanceof MailInboxError) return res.status(err.status).json({ error: err.message });
      log.error({ err }, 'inbox read failed');
      res.status(500).json({ error: 'Failed to load the message' });
    }
  });

  // POST /admin/api/mail/inbox/:id/read { read?: boolean }
  router.post('/admin/api/mail/inbox/:id/read', requireRole('researcher'), async (req, res) => {
    try {
      const read = (req.body as { read?: unknown } | undefined)?.read !== false;
      await markMailboxMessageRead(req.session.userId!, req.params.id, read);
      res.json({ success: true, read });
    } catch (err) {
      if (err instanceof MailInboxError) return res.status(err.status).json({ error: err.message });
      log.error({ err }, 'inbox mark-read failed');
      res.status(500).json({ error: 'Failed to update the message' });
    }
  });

  return router;
}
