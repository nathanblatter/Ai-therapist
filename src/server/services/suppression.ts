// Intent-named suppression predicates for the demo/sandbox populations.
// The underlying flags are easy to conflate — users.role='demo' (magic-link
// resume viewers), users.is_sandbox (synthetic caseworker-portal caseloads),
// work_items.is_sandbox (items produced from sandbox data) — and each
// suppresses a DIFFERENT slice of the machinery. These thin wrappers name the
// intent at the call site so a future surface picks the right population
// instead of the nearest-looking flag. Pure delegation: no behavior change.
import { isDemoAccountSession, isSandboxAccountSession, getSandboxWorkItemIds } from '../db/index.js';

/** Population: sessions owned by a magic-link demo account (users.role='demo').
 *  They skip the ENTIRE safety pipeline — no scoring, flags, admin alerts, or
 *  paging (recruiters kicking tires must never wake the on-call). Sandbox
 *  accounts do NOT match: their sessions exercise the real pipeline. */
export function sessionSuppressesSafetyPipeline(sessionId: string): Promise<boolean> {
  return isDemoAccountSession(sessionId);
}

/** Population: sessions owned by a sandbox account (users.is_sandbox).
 *  Only the on-call SMS page is suppressed — dashboards, flags, and sideband
 *  steering stay on (that is the product being demoed, spec s7 #3). */
export function sessionSuppressesCrisisPaging(sessionId: string): Promise<boolean> {
  return isSandboxAccountSession(sessionId);
}

/** Population: work items produced from sandbox data (work_items.is_sandbox).
 *  They never generate EMAIL (in-app notifications still flow) — the
 *  sandbox-never-emails hard rule, docs/caseworker-portal.md section 5. */
export function workItemSuppressesEmail(item: { is_sandbox: boolean }): boolean {
  return item.is_sandbox;
}

/** Population: sandbox recipient ACCOUNTS (users.is_sandbox). A sandbox user
 *  never receives email, even about real items — same hard rule as above. */
export function recipientSuppressesEmail(user: { is_sandbox?: boolean | null }): boolean {
  return user.is_sandbox === true;
}

/** Batch form of workItemSuppressesEmail for the digest sweep: of the given
 *  work-item ids, the ones whose items are sandbox-origin (excluded from a
 *  real recipient's digest email and stamped without sending). */
export function emailSuppressedWorkItemIds(itemIds: number[]): Promise<number[]> {
  return getSandboxWorkItemIds(itemIds);
}
