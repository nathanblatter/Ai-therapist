// Organization scoping helper (caseworker portal foundation, migration 069).
// Login stamps req.session.orgId; sessions established before 069 shipped get
// a lazy lookup + session write-back here so org scoping works without
// forcing a re-login.
import type { Request } from 'express';
import { getOrganizationIdForUser, getIrbStudyOrgId } from '../db/index.js';

/**
 * The caller's organization id.
 *
 * Contract (fail-closed, red-team round 3):
 *   - Unauthenticated request (no session userId): returns null. This is the
 *     ONLY case that returns null.
 *   - User has an organization_id: returns it (cached on the session).
 *   - User has NO organization_id (legacy row from before the 069 backfill,
 *     or the row disappeared mid-session): treated as the irb-study default
 *     org — the same org 069 backfills every pre-org user into.
 *   - Lookup FAILED (db error, or the irb-study org cannot be resolved):
 *     THROWS. Callers must let the error reach their catch/error handler so
 *     the request 500s. A transient failure must never widen a researcher's
 *     org-scoped read to all organizations — consumers must not treat a
 *     thrown error as "unscoped".
 */
export async function orgIdFor(req: Request): Promise<number | null> {
  const session = req.session;
  if (!session?.userId) return null;
  if (typeof session.orgId === 'number') return session.orgId;

  // Any throw below is a resolution FAILURE and must propagate (fail closed).
  const orgId = await getOrganizationIdForUser(session.userId);
  if (typeof orgId === 'number') {
    session.orgId = orgId; // lazy write-back for pre-069 sessions
    return orgId;
  }

  // No org on the row: legacy (pre-backfill) user — irb-study default.
  const irbOrgId = await getIrbStudyOrgId();
  if (typeof irbOrgId === 'number') {
    session.orgId = irbOrgId;
    return irbOrgId;
  }

  throw new Error(
    `[org] Could not resolve an organization for user ${session.userId}: ` +
      'no organization_id on the user row and no irb-study org (pre-069 schema?)'
  );
}

/**
 * The organization a client-scoped write should land in: the client's own
 * organization_id when set, otherwise (legacy pre-069 client rows) the
 * caller's org via orgIdFor — with orgIdFor's fail-closed contract (throws on
 * lookup failure; null only for unauthenticated callers). Shared by the
 * escalation/note create paths.
 */
export async function resolveClientOrgId(
  client: { organization_id?: number | null },
  req: Request
): Promise<number | null> {
  return client.organization_id ?? (await orgIdFor(req));
}
