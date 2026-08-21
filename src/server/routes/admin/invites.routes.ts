// Therapist invite management (ai-therapist-119, caseload RBAC):
//   - POST /admin/api/caseload/invites — mint a one-time client invite link.
//     The raw token appears only in this response (`link: /join/<rawToken>`);
//     the DB keeps just its sha256 hash.
//   - GET  /admin/api/caseload/invites — the therapist's own invites with a
//     derived pending/used/expired state.
// Therapist-only: invites bind a new participant to the calling therapist.
// Demo requests never reach this router (intercepted earlier).
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { createInvite, listInvites } from '../../db/index.js';
import type { ClientInviteRow } from '../../db/invites.queries.js';

function inviteState(invite: ClientInviteRow): 'pending' | 'used' | 'expired' {
  if (invite.used_at) return 'used';
  if (new Date(invite.expires_at).getTime() <= Date.now()) return 'expired';
  return 'pending';
}

/** Public row shape: everything but the token hash, plus the derived state. */
function toApiInvite(invite: ClientInviteRow): Omit<ClientInviteRow, 'token_hash'> & { state: string } {
  const { token_hash: _tokenHash, ...rest } = invite;
  return { ...rest, state: inviteState(invite) };
}

export default function invitesRoutes(): Router {
  const router = Router();

  // POST /admin/api/caseload/invites — body: { label?, ttlHours? }
  router.post('/admin/api/caseload/invites', requireRole('therapist'), async (req, res) => {
    try {
      const rawLabel = req.body?.label;
      const label =
        typeof rawLabel === 'string' && rawLabel.trim().length > 0 ? rawLabel.trim() : null;

      const rawTtl = req.body?.ttlHours;
      let ttlHours = 168;
      if (rawTtl !== undefined && rawTtl !== null) {
        const parsed = Number(rawTtl);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 24 * 90) {
          return res.status(400).json({ error: 'ttlHours must be a positive number of hours' });
        }
        ttlHours = parsed;
      }

      const { rawToken, invite } = await createInvite(req.session.userId as number, label, ttlHours);
      res.json({ link: `/join/${rawToken}`, invite: toApiInvite(invite) });
    } catch (error) {
      console.error('Error creating client invite:', error);
      res.status(500).json({ error: 'Failed to create invite' });
    }
  });

  // GET /admin/api/caseload/invites — the caller's own invites, newest first.
  router.get('/admin/api/caseload/invites', requireRole('therapist'), async (req, res) => {
    try {
      const invites = await listInvites(req.session.userId as number);
      res.json({ invites: invites.map(toApiInvite) });
    } catch (error) {
      console.error('Error listing client invites:', error);
      res.status(500).json({ error: 'Failed to list invites' });
    }
  });

  return router;
}
