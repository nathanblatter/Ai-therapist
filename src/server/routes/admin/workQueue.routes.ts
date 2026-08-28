// Work-queue API (caseworker portal, spec section 3). Ownership is enforced
// IN the queries (assignee = me, or pool item for a client on my caseload),
// preserving 404-over-403: a member can never distinguish "not mine" from
// "does not exist". Researchers get an org-scoped read-only view.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { orgIdFor } from '../../middleware/org.js';
import {
  listWorkItemsForMember,
  listWorkItemsForOrg,
  getWorkItemById,
  ackWorkItem,
  resolveWorkItem,
  isAssigned,
  insertCaseloadAudit,
  type WorkItemRow,
  type WorkItemStatus,
} from '../../db/index.js';
import { emitWorkItemUpdated } from '../../services/workQueue.service.js';
import { isCareTeamRole } from '../../../shared/roles.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('workQueueRoutes');

/**
 * Append the spec-mandated caseload_audit_log row for a work-item state
 * change (docs/caseworker-portal.md section 3: "state changes append to
 * caseload_audit_log"). Best-effort — insertCaseloadAudit never throws.
 * The caseload_audit_log action CHECK admits these values as of migration 080.
 */
function auditWorkItemChange(
  action: 'work_item_ack' | 'work_item_resolve',
  item: WorkItemRow,
  memberId: number,
  username: string | null | undefined,
  detail: Record<string, unknown>
): void {
  void insertCaseloadAudit({
    action,
    therapistId: memberId,
    clientId: item.client_id,
    actorUserId: memberId,
    actorUsername: username ?? null,
    detail: { item_id: item.item_id, item_type: item.item_type, ...detail },
  });
}

const VALID_STATUSES: WorkItemStatus[] = ['open', 'acked', 'resolved', 'expired'];

function parseStatuses(raw: unknown): WorkItemStatus[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return ['open', 'acked'];
  const statuses = raw.split(',').map((s) => s.trim()) as WorkItemStatus[];
  return statuses.every((s) => VALID_STATUSES.includes(s)) ? statuses : null;
}

/**
 * Distinguish 404 (missing or not visible to me — same answer) from 409
 * (visible but the guarded UPDATE lost the state race) after a null result.
 */
async function missOrConflict(itemId: number, memberId: number):
  Promise<{ status: 404 } | { status: 409; itemStatus: string }> {
  const item = await getWorkItemById(itemId);
  if (!item) return { status: 404 };
  const visible =
    item.assignee_id === memberId ||
    (item.assignee_id === null &&
      item.client_id !== null &&
      (await isAssigned(memberId, item.client_id)));
  if (!visible) return { status: 404 };
  return { status: 409, itemStatus: item.status };
}

export default function workQueueRoutes(): Router {
  const router = Router();

  // GET /admin/api/work-items?status=open,acked&limit=100
  router.get(
    '/admin/api/work-items',
    requireRole('caseworker', 'therapist', 'researcher'),
    async (req, res) => {
      const statuses = parseStatuses(req.query.status);
      if (!statuses) return res.status(400).json({ error: 'Invalid status filter' });
      const rawLimit = Number(req.query.limit ?? 200);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;

      try {
        if (isCareTeamRole(req.session.userRole)) {
          const items = await listWorkItemsForMember(req.session.userId!, { statuses, limit });
          return res.json({ items });
        }
        // Researcher: org-scoped read. Unresolvable org -> empty, never a leak.
        const orgId = await orgIdFor(req);
        const items = orgId === null ? [] : await listWorkItemsForOrg(orgId, { statuses, limit });
        res.json({ items });
      } catch (err) {
        log.error({ err }, 'Failed to list work items');
        res.status(500).json({ error: 'Failed to list work items' });
      }
    }
  );

  // POST /admin/api/work-items/:itemId/ack — care-team members only
  router.post(
    '/admin/api/work-items/:itemId/ack',
    requireRole('caseworker', 'therapist'),
    async (req, res) => {
      const itemId = Number(req.params.itemId);
      if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'Invalid item id' });
      try {
        const memberId = req.session.userId!;
        const item = await ackWorkItem(itemId, memberId);
        if (!item) {
          const miss = await missOrConflict(itemId, memberId);
          if (miss.status === 404) return res.status(404).json({ error: 'Not found' });
          return res.status(409).json({ error: 'Item is not open', status: miss.itemStatus });
        }
        log.info(
          { itemId, memberId, actor: req.session.username, itemType: item.item_type },
          'work item acknowledged'
        );
        auditWorkItemChange('work_item_ack', item, memberId, req.session.username, {});
        void emitWorkItemUpdated(item);
        res.json({ item });
      } catch (err) {
        log.error({ err, itemId }, 'Failed to ack work item');
        res.status(500).json({ error: 'Failed to acknowledge work item' });
      }
    }
  );

  // POST /admin/api/work-items/:itemId/resolve — body { resolution_note? }
  router.post(
    '/admin/api/work-items/:itemId/resolve',
    requireRole('caseworker', 'therapist'),
    async (req, res) => {
      const itemId = Number(req.params.itemId);
      if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'Invalid item id' });
      const rawNote = req.body?.resolution_note;
      if (rawNote !== undefined && typeof rawNote !== 'string') {
        return res.status(400).json({ error: 'Invalid resolution_note' });
      }
      const note = typeof rawNote === 'string' && rawNote.trim() !== '' ? rawNote.trim() : null;
      try {
        const memberId = req.session.userId!;
        const item = await resolveWorkItem(itemId, memberId, note);
        if (!item) {
          const miss = await missOrConflict(itemId, memberId);
          if (miss.status === 404) return res.status(404).json({ error: 'Not found' });
          return res.status(409).json({ error: 'Item is not open or acknowledged', status: miss.itemStatus });
        }
        log.info(
          { itemId, memberId, actor: req.session.username, itemType: item.item_type },
          'work item resolved'
        );
        auditWorkItemChange('work_item_resolve', item, memberId, req.session.username, {
          has_resolution_note: note !== null,
        });
        void emitWorkItemUpdated(item);
        res.json({ item });
      } catch (err) {
        log.error({ err, itemId }, 'Failed to resolve work item');
        res.status(500).json({ error: 'Failed to resolve work item' });
      }
    }
  );

  return router;
}
