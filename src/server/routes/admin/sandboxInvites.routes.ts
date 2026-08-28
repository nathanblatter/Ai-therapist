// Researcher-only sandbox invite minting (caseworker portal, spec section 7):
//   - POST /admin/api/sandbox/invites — mint a batch (1-500) of one-time
//     /join-sandbox links. Raw tokens appear ONLY in this response; the DB
//     keeps sha256 hashes (065 pattern). No env kill-switch by decision 12 —
//     sandbox org isolation is the boundary.
//   - GET  /admin/api/sandbox/invites — batch history with used/total counts.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  createSandboxInviteBatch,
  listSandboxInviteBatches,
  insertCaseloadAudit,
} from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('sandboxInvites');

const MAX_TTL_HOURS = 24 * 180;
const DEFAULT_TTL_HOURS = 24 * 30;

export default function sandboxInvitesRoutes(): Router {
  const router = Router();
  const researcherOnly = requireRole('researcher');

  // POST /admin/api/sandbox/invites — body: { count, role, label?, ttlHours? }
  router.post('/admin/api/sandbox/invites', researcherOnly, async (req, res) => {
    try {
      const count = Number(req.body?.count);
      if (!Number.isInteger(count) || count < 1 || count > 500) {
        return res.status(400).json({ error: 'count must be an integer between 1 and 500' });
      }

      const role = req.body?.role;
      if (role !== 'therapist' && role !== 'caseworker') {
        return res.status(400).json({ error: "role must be 'therapist' or 'caseworker'" });
      }

      const rawLabel = req.body?.label;
      const label =
        typeof rawLabel === 'string' && rawLabel.trim().length > 0 ? rawLabel.trim().slice(0, 120) : null;

      let ttlHours = DEFAULT_TTL_HOURS;
      const rawTtl = req.body?.ttlHours;
      if (rawTtl !== undefined && rawTtl !== null) {
        const parsed = Number(rawTtl);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_TTL_HOURS) {
          return res.status(400).json({ error: `ttlHours must be a positive number of hours (max ${MAX_TTL_HOURS})` });
        }
        ttlHours = parsed;
      }

      const { batchId, invites } = await createSandboxInviteBatch({
        count,
        inviteRole: role,
        label,
        ttlHours,
        createdBy: req.session.userId as number,
      });

      void insertCaseloadAudit({
        action: 'invite_created',
        therapistId: req.session.userId as number,
        clientId: null,
        actorUserId: req.session.userId as number,
        actorUsername: req.session.username ?? null,
        detail: { sandbox: true, batch_id: batchId, count, role, label, ttl_hours: ttlHours },
      });

      log.info({ batchId, count, role }, 'sandbox invite batch minted');
      res.status(201).json({
        batchId,
        role,
        label,
        expiresAt: invites[0]?.invite.expires_at ?? null,
        // Raw links, shown exactly once — never retrievable again.
        links: invites.map(({ rawToken, invite }) => ({
          inviteId: invite.invite_id,
          link: `/join-sandbox/${rawToken}`,
        })),
      });
    } catch (err) {
      log.error({ err }, 'sandbox invite mint failed');
      res.status(500).json({ error: 'Failed to create sandbox invites' });
    }
  });

  // GET /admin/api/sandbox/invites — batches, newest first.
  router.get('/admin/api/sandbox/invites', researcherOnly, async (_req, res) => {
    try {
      const batches = await listSandboxInviteBatches();
      res.json({ batches });
    } catch (err) {
      log.error({ err }, 'sandbox invite list failed');
      res.status(500).json({ error: 'Failed to list sandbox invites' });
    }
  });

  return router;
}
