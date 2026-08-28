// Caseload-aware admin event fan-out (docs/caseload-rbac.md, HIGH-1).
//
// The 'admin-broadcast' room is researchers-only: therapist sockets join
// `therapist:<userid>` instead (src/server/index.ts connection handler).
// Participant-linked live events must go through broadcastAdminEvent /
// broadcastAdminEventForSession so therapists only receive events for
// participants on their caseload. Unattributable events (no participant
// userId resolvable) fail closed: researchers only.
import type { Server as SocketIOServer } from 'socket.io';
import {
  getSessionAccessInfo,
  getTherapistIdsForClient,
  getCaseworkerIdsForClient,
  isSandboxAccount,
} from '../db/index.js';

/** The slice of a socket.io Server we need (keeps tests trivial to mock). */
export type AdminBroadcastIo = Pick<SocketIOServer, 'to'>;

/** Room every researcher socket sits in. */
export const ADMIN_BROADCAST_ROOM = 'admin-broadcast';

/** Per-therapist room a therapist socket joins on connect. */
export function therapistRoom(therapistId: number): string {
  return `therapist:${therapistId}`;
}

/** Per-caseworker room a caseworker socket joins on connect (summary tier). */
export function caseworkerRoom(caseworkerId: number): string {
  return `caseworker:${caseworkerId}`;
}

/**
 * Data tier of an emitted event (docs/caseworker-portal.md section 5).
 * 'full' (the default — fail closed) reaches researcher + therapist rooms
 * only; 'summary' additionally fans out to the client's caseworkers'
 * `caseworker:<id>` rooms. Only call sites whose payloads are transcript-free
 * by construction may pass 'summary'.
 */
export type BroadcastTier = 'full' | 'summary';

// Participant -> is_sandbox cache. users.is_sandbox is stamped at account
// creation and never toggled (spec C3), so resolved values never go stale.
// Bounded FIFO like the session->user cache below.
const sandboxUserCache = new Map<number, boolean>();
const SANDBOX_USER_CACHE_MAX = 1000;

/** Test hook: clear the participant->is_sandbox cache. */
export function clearSandboxUserCache(): void {
  sandboxUserCache.clear();
}

/**
 * Is this participant a sandbox account? On lookup failure returns false
 * (the event stays visible to the researcher room): suppressing study
 * events on a transient db error would hide real-participant crisis alerts
 * from on-call researchers, which is worse than briefly leaking sandbox
 * METADATA (these payloads carry no transcript content for researchers who
 * cannot open the underlying resources — the org-scoped queries 404 them).
 */
async function isSandboxParticipant(participantUserId: number): Promise<boolean> {
  const cached = sandboxUserCache.get(participantUserId);
  if (cached !== undefined) return cached;
  try {
    const sandbox = await isSandboxAccount(participantUserId);
    if (sandboxUserCache.size >= SANDBOX_USER_CACHE_MAX) {
      const oldest = sandboxUserCache.keys().next().value;
      if (oldest !== undefined) sandboxUserCache.delete(oldest);
    }
    sandboxUserCache.set(participantUserId, sandbox);
    return sandbox;
  } catch (err) {
    console.error(`[AdminBroadcast] Sandbox lookup failed for user ${participantUserId}; treating as non-sandbox:`, err);
    return false; // do not cache failures
  }
}

/**
 * Emit an admin monitoring event.
 *
 * - Emits to 'admin-broadcast' (researchers) UNLESS the event is attributed
 *   to a sandbox participant (C13: sandbox orgs' live events must never
 *   stream to study researchers; the sandbox org's own care-team members
 *   still receive them via their therapist:/caseworker: rooms below).
 *   Unattributable events keep going to the researcher room (they carry no
 *   participant linkage), as does an event whose sandbox lookup fails — see
 *   isSandboxParticipant for the safety rationale.
 * - When `participantUserId` is a finite number, also emits to
 *   `therapist:<id>` for every therapist with that participant on caseload,
 *   and — only when tier='summary' — to `caseworker:<id>` for the client's
 *   caseworkers.
 * - When `participantUserId` is null/undefined, or a caseload lookup fails,
 *   the affected rooms are skipped (fail closed). Lookup failures are
 *   logged, never thrown — an emit must not crash a service.
 */
export async function broadcastAdminEvent(
  io: AdminBroadcastIo,
  event: string,
  payload: unknown,
  participantUserId: number | null | undefined,
  tier: BroadcastTier = 'full'
): Promise<void> {
  if (typeof participantUserId !== 'number' || !Number.isFinite(participantUserId)) {
    io.to(ADMIN_BROADCAST_ROOM).emit(event, payload);
    return;
  }

  if (!(await isSandboxParticipant(participantUserId))) {
    io.to(ADMIN_BROADCAST_ROOM).emit(event, payload);
  }

  let therapistIds: number[];
  try {
    therapistIds = await getTherapistIdsForClient(participantUserId);
  } catch (err) {
    console.error(`[AdminBroadcast] Caseload lookup failed for user ${participantUserId} (event ${event}); therapists skipped:`, err);
    therapistIds = [];
  }
  for (const therapistId of therapistIds) {
    io.to(therapistRoom(therapistId)).emit(event, payload);
  }

  if (tier !== 'summary') return;
  let caseworkerIds: number[];
  try {
    caseworkerIds = await getCaseworkerIdsForClient(participantUserId);
  } catch (err) {
    console.error(`[AdminBroadcast] Caseworker lookup failed for user ${participantUserId} (event ${event}); caseworkers skipped:`, err);
    return;
  }
  for (const caseworkerId of caseworkerIds) {
    io.to(caseworkerRoom(caseworkerId)).emit(event, payload);
  }
}

// Session -> participant user_id cache. A session's user_id is fixed at
// creation, so resolved values never go stale. Bounded FIFO to keep the map
// from growing forever on a long-lived process.
const sessionUserCache = new Map<string, number | null>();
const SESSION_USER_CACHE_MAX = 1000;

/** Test hook: clear the session->user cache. */
export function clearSessionUserCache(): void {
  sessionUserCache.clear();
}

/**
 * Like broadcastAdminEvent, but resolves the participant userId from the
 * session row (therapy_sessions.user_id), with an in-memory cache so
 * high-frequency emitters (live transcript deltas) don't hit the DB per
 * fragment. Anonymous sessions (user_id NULL) and lookup failures fail
 * closed: researchers only.
 */
export async function broadcastAdminEventForSession(
  io: AdminBroadcastIo,
  event: string,
  payload: unknown,
  sessionId: string,
  tier: BroadcastTier = 'full'
): Promise<void> {
  let userId: number | null;
  if (sessionUserCache.has(sessionId)) {
    userId = sessionUserCache.get(sessionId) ?? null;
  } else {
    try {
      const session = await getSessionAccessInfo(sessionId);
      const raw = session?.user_id;
      userId = raw === null || raw === undefined ? null : Number(raw);
      if (userId !== null && !Number.isFinite(userId)) userId = null;
      // Only cache when the session ROW exists. A missing row (insert raced
      // or deferred to the logs/batch endpoint) must stay uncached, or every
      // later event for the session — including crisis alerts — would be
      // permanently misrouted away from the assigned therapist.
      if (session) {
        if (sessionUserCache.size >= SESSION_USER_CACHE_MAX) {
          const oldest = sessionUserCache.keys().next().value;
          if (oldest !== undefined) sessionUserCache.delete(oldest);
        }
        sessionUserCache.set(sessionId, userId);
      }
    } catch (err) {
      console.error(`[AdminBroadcast] Session owner lookup failed for ${sessionId} (event ${event}); therapists skipped:`, err);
      userId = null; // fail closed, do not cache failures
    }
  }
  await broadcastAdminEvent(io, event, payload, userId, tier);
}


/**
 * Kick a therapist's live sockets out of a client's session rooms after an
 * unassignment (docs/caseload-rbac.md revocation semantics): future emits
 * already re-resolve the caseload per event, but session-room membership
 * (live unredacted transcripts) is only checked at join time.
 */
export async function revokeTherapistSessionRooms(
  io: { in: (room: string) => { fetchSockets: () => Promise<Array<{ rooms: Set<string>; leave: (room: string) => void }>> } },
  therapistId: number,
  clientId: number
): Promise<void> {
  try {
    const sockets = await io.in(therapistRoom(therapistId)).fetchSockets();
    for (const socket of sockets) {
      for (const room of socket.rooms) {
        if (!room.startsWith('session:')) continue;
        const sessionId = room.slice('session:'.length);
        try {
          const session = await getSessionAccessInfo(sessionId);
          const ownerId = session && session.user_id != null ? Number(session.user_id) : null;
          if (ownerId === clientId) socket.leave(room);
        } catch (err) {
          console.error(`[AdminBroadcast] revoke lookup failed for ${sessionId}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('[AdminBroadcast] revokeTherapistSessionRooms failed:', err);
  }
}
