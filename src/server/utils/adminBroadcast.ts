// Caseload-aware admin event fan-out (docs/caseload-rbac.md, HIGH-1).
//
// The 'admin-broadcast' room is researchers-only: therapist sockets join
// `therapist:<userid>` instead (src/server/index.ts connection handler).
// Participant-linked live events must go through broadcastAdminEvent /
// broadcastAdminEventForSession so therapists only receive events for
// participants on their caseload. Unattributable events (no participant
// userId resolvable) fail closed: researchers only.
import type { Server as SocketIOServer } from 'socket.io';
import { getSessionAccessInfo, getTherapistIdsForClient } from '../db/index.js';

/** The slice of a socket.io Server we need (keeps tests trivial to mock). */
export type AdminBroadcastIo = Pick<SocketIOServer, 'to'>;

/** Room every researcher socket sits in. */
export const ADMIN_BROADCAST_ROOM = 'admin-broadcast';

/** Per-therapist room a therapist socket joins on connect. */
export function therapistRoom(therapistId: number): string {
  return `therapist:${therapistId}`;
}

/**
 * Emit an admin monitoring event.
 *
 * - Always emits to 'admin-broadcast' (researchers).
 * - When `participantUserId` is a finite number, also emits to
 *   `therapist:<id>` for every therapist with that participant on caseload.
 * - When `participantUserId` is null/undefined, or the caseload lookup fails,
 *   emits to 'admin-broadcast' only (fail closed for therapists). Lookup
 *   failures are logged, never thrown — an emit must not crash a service.
 */
export async function broadcastAdminEvent(
  io: AdminBroadcastIo,
  event: string,
  payload: unknown,
  participantUserId: number | null | undefined
): Promise<void> {
  io.to(ADMIN_BROADCAST_ROOM).emit(event, payload);

  if (typeof participantUserId !== 'number' || !Number.isFinite(participantUserId)) return;

  let therapistIds: number[];
  try {
    therapistIds = await getTherapistIdsForClient(participantUserId);
  } catch (err) {
    console.error(`[AdminBroadcast] Caseload lookup failed for user ${participantUserId} (event ${event}); therapists skipped:`, err);
    return;
  }
  for (const therapistId of therapistIds) {
    io.to(therapistRoom(therapistId)).emit(event, payload);
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
  sessionId: string
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
  await broadcastAdminEvent(io, event, payload, userId);
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
