// Admin assistant chat endpoint (docs/admin-assistant-spec.md). Read-only:
// the service has no mutating tools. Gated by ASSISTANT_ENABLED so prod
// stays dark until the post-submission red-team pass.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { orgIdFor } from '../../middleware/org.js';
import {
  runAssistantTurn,
  type AssistantContext,
  type AssistantMessage,
  type AssistantRole,
} from '../../services/assistant.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('assistantRoutes');

const MAX_HISTORY = 20;
const MAX_CONTENT = 4000;

function parseHistory(raw: unknown): AssistantMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_HISTORY) return null;
  const messages: AssistantMessage[] = [];
  for (const m of raw) {
    const role = (m as Record<string, unknown>)?.role;
    const content = (m as Record<string, unknown>)?.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) {
      return null;
    }
    messages.push({ role, content: content.slice(0, MAX_CONTENT) });
  }
  return messages.at(-1)?.role === 'user' ? messages : null;
}

export default function assistantRoutes(): Router {
  const router = Router();

  const chatLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

  router.post(
    '/admin/api/assistant/chat',
    requireAuth,
    requireRole('therapist', 'researcher', 'caseworker'),
    chatLimiter,
    async (req, res) => {
      if (process.env.ASSISTANT_ENABLED !== 'true') {
        return res.status(503).json({ error: 'The assistant is not enabled in this environment.' });
      }
      const messages = parseHistory(req.body?.messages);
      if (!messages) {
        return res.status(400).json({ error: 'messages must be 1-20 user/assistant turns ending with a user message.' });
      }
      try {
        const ctx: AssistantContext = {
          userId: req.session.userId!,
          role: req.session.userRole as AssistantRole,
          username: req.session.username ?? null,
          orgId: await orgIdFor(req),
        };
        const result = await runAssistantTurn(ctx, messages);
        res.json(result);
      } catch (err) {
        log.error({ err }, 'assistant turn failed');
        res.status(502).json({ error: 'The assistant is unavailable right now. Try again shortly.' });
      }
    }
  );

  return router;
}
