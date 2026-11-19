// The last few turns of each active session, kept in process memory
// (ai-therapist-373). No I/O.
//
// The crisis assessor reads a turn together with the turns before it. Two of
// its most important readings exist only in that context: a sentence that
// reached us as two voice fragments ("... how I would kill" + " myself"), which
// the pipeline joins back together, and a bare "yes" that answers the
// assistant's "Are you thinking about suicide?". Until this module the context
// came from one database read, bounded at 2 s since PR #86; when that read
// failed or passed its bound the assessor saw the turn alone, the two halves
// scored 0 each and the "yes" scored as a "yes". A page became no page.
//
// Every turn the server already sees is written here as it passes: the chat
// route (the participant's message and the reply), the voice transcripts
// (GPT-Live sideband, Grok proxy), the browser's /logs/batch records, and the
// check-in at session start. The crisis pipeline uses this copy when the
// database cannot give it the history (see crisisPipeline.service
// readTurnContext). The database stays the primary source: it is complete
// across processes and restarts, and normal scoring is unchanged.
//
// Bounds (memory, worst case): RECENT_TURNS_MAX_SESSIONS sessions x
// RECENT_TURNS_PER_SESSION turns x RECENT_TURN_MAX_CHARS characters, about
// 9 M characters (under 20 MB as JS strings); a session is dropped when it is
// evicted (least recently written first), idle for RECENT_TURNS_IDLE_MS, or
// RECENT_TURNS_END_GRACE_MS after it ended. Dropped at once (ai-therapist-374):
// every session of a participant who withdraws or whose account is deleted
// (forgetParticipantTurns), and every turn older than a content wipe's cutoff
// (forgetTurnsBefore), so this copy never outlives the stored content.
//
// One process only. Stage and prod run one app process. With more than one,
// each process holds the turns it handled: a voice session's turns all reach
// the process its sideband is attached to, but typed turns may be split
// across processes, and a process that did not see a session start (another
// instance, a restart, a deploy overlap) knows it may hold only part of it
// (`complete: false`); the pipeline then fails toward paging (see
// crisisPipeline.service CONTEXT_BLIND rule).

/** How many turns (both roles) are kept per session: the assessor's window
 *  (10) plus room for a split sentence's earlier parts. */
export const RECENT_TURNS_PER_SESSION = 12;
/** How many sessions are kept at once; the least recently written goes first. */
export const RECENT_TURNS_MAX_SESSIONS = 500;
/** Longest text kept per turn (the end of a longer turn is kept: the question
 *  an assistant turn ends on, the part of a fragment nearest the next one).
 *  The assessor's whole transcript is capped at about 6000 characters. */
export const RECENT_TURN_MAX_CHARS = 1500;
/** A session with no turn written for this long is dropped. */
export const RECENT_TURNS_IDLE_MS = 2 * 60 * 60 * 1000;
/** How long a session's turns outlive its end: the last turn of a voice
 *  session is flushed and scored as the session closes. */
export const RECENT_TURNS_END_GRACE_MS = 2 * 60 * 1000;

export interface RememberedTurn {
  role: 'user' | 'assistant';
  content: string;
  /** When the turn was seen (ms). For /logs/batch, the browser's timestamp. */
  at: number;
  /** The stored row's id, once known; null for a turn that was not stored. */
  messageId: string | number | null;
  /** Caller's identity for a record that may arrive twice (a re-sent batch). */
  key?: string;
  /** Order of arrival in this process. */
  seq: number;
}

interface SessionTurns {
  turns: RememberedTurn[];
  checkin: string | null;
  /** This process saw the session start (its record is not a fragment). */
  startedHere: boolean;
  /** The signed-in participant, when known at start (for withdrawal and
   *  account deletion); null for an anonymous browser or a fragment. */
  userId: number | null;
  touchedAt: number;
  endedAt: number | null;
}

/** Records that are bookkeeping, not conversation: the same list the stored
 *  history leaves out (db/crisis.queries BOOKKEEPING_MESSAGE_TYPES). */
const BOOKKEEPING_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'tool_call',
  'tool_response',
  'function_call',
  'notable_moment',
  'system',
  'session_start',
  'session_end',
  'admin_action',
  'admin_visible',
  'admin_invisible',
]);

const sessions = new Map<string, SessionTurns>();
let nextSeq = 1;

function clip(text: string): string {
  return text.length > RECENT_TURN_MAX_CHARS ? text.slice(text.length - RECENT_TURN_MAX_CHARS) : text;
}

function expired(record: SessionTurns, now: number): boolean {
  if (now - record.touchedAt > RECENT_TURNS_IDLE_MS) return true;
  return record.endedAt !== null && now - record.endedAt > RECENT_TURNS_END_GRACE_MS;
}

/** The record, refreshed as most recently written (map order is LRU order). */
function touch(sessionId: string, now: number): SessionTurns {
  let record = sessions.get(sessionId);
  if (record && expired(record, now)) record = undefined;
  sessions.delete(sessionId);
  if (!record) record = { turns: [], checkin: null, startedHere: false, userId: null, touchedAt: now, endedAt: null };
  record.touchedAt = now;
  sessions.set(sessionId, record);
  // Oldest first: drop the idle ones, then whatever is over the cap.
  for (const [id, other] of sessions) {
    if (id === sessionId) break;
    if (sessions.size > RECENT_TURNS_MAX_SESSIONS || expired(other, now)) sessions.delete(id);
    else break;
  }
  return record;
}

/**
 * A session started in this process: from here its record is complete for this
 * process. `checkin` is the session's check-in (its free text, topic and
 * goal, is kept the way the pipeline quotes it: crisisPipeline
 * checkinFreeText), so the pipeline has it when the stored check-in cannot be
 * read. `userId`: the signed-in participant, so a withdrawal or account
 * deletion can drop the session (forgetParticipantTurns). Never throws.
 */
export function rememberSessionStart(
  sessionId: string,
  checkin?: { topic?: unknown; goal?: unknown } | null,
  userId?: number | string | null,
): void {
  if (!sessionId) return;
  const record = touch(sessionId, Date.now());
  record.startedHere = true;
  record.endedAt = null;
  const participant = participantId(userId);
  if (participant !== null) record.userId = participant;
  const text = [checkin?.topic, checkin?.goal]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join('\n');
  if (text) record.checkin = clip(text);
}

/**
 * A participant or assistant turn the server has seen. Returns the remembered
 * turn (the caller may set its `messageId` once the row is stored), or null
 * when there is nothing to keep. A turn whose `key` is already held is not
 * added twice. Never throws.
 */
export function rememberTurn(
  sessionId: string,
  role: string,
  content: string | null | undefined,
  opts: { messageId?: string | number | null; at?: number; key?: string; messageType?: string | null } = {},
): RememberedTurn | null {
  if (!sessionId || (role !== 'user' && role !== 'assistant')) return null;
  if (opts.messageType && BOOKKEEPING_MESSAGE_TYPES.has(opts.messageType)) return null;
  if (typeof content !== 'string' || content.trim() === '') return null;
  const now = Date.now();
  const record = touch(sessionId, now);
  if (opts.key) {
    const held = record.turns.find((t) => t.key === opts.key);
    if (held) {
      if (opts.messageId != null) held.messageId = opts.messageId;
      return held;
    }
  }
  const at = typeof opts.at === 'number' && Number.isFinite(opts.at) ? opts.at : now;
  const turn: RememberedTurn = {
    role,
    content: clip(content),
    at,
    messageId: opts.messageId ?? null,
    ...(opts.key ? { key: opts.key } : {}),
    seq: nextSeq++,
  };
  record.turns.push(turn);
  // Kept in time order: a /logs/batch record carries the browser's own time
  // and can arrive after a later turn seen another way.
  record.turns.sort((a, b) => a.at - b.at || a.seq - b.seq);
  if (record.turns.length > RECENT_TURNS_PER_SESSION) {
    record.turns.splice(0, record.turns.length - RECENT_TURNS_PER_SESSION);
  }
  return turn;
}

/** What this process holds for a session, or null when it holds nothing. */
export function recentTurns(
  sessionId: string,
): { turns: RememberedTurn[]; checkin: string | null; complete: boolean } | null {
  const record = sessions.get(sessionId);
  if (!record) return null;
  if (expired(record, Date.now())) {
    sessions.delete(sessionId);
    return null;
  }
  return { turns: record.turns.map((t) => ({ ...t })), checkin: record.checkin, complete: record.startedHere };
}

/** The check-in text remembered at session start, or null. */
export function rememberedCheckin(sessionId: string): string | null {
  return recentTurns(sessionId)?.checkin ?? null;
}

/** The session ended: its turns are dropped after RECENT_TURNS_END_GRACE_MS.
 *  Never throws. */
export function forgetSessionTurns(sessionId: string): void {
  const record = sessions.get(sessionId);
  if (record && record.endedAt === null) record.endedAt = Date.now();
}

function participantId(userId: number | string | null | undefined): number | null {
  const n = typeof userId === 'string' && userId.trim() !== '' ? Number(userId) : userId;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/**
 * A participant withdrew or their account was deleted: drop at once every
 * session held for them, by the participant remembered at start and by
 * `sessionIds` (the participant's sessions as the database lists them, which
 * also covers a session this process did not see start). No grace: nothing of
 * theirs is kept for a later turn. Returns how many sessions were dropped.
 * Never throws.
 */
export function forgetParticipantTurns(
  userId: number | string | null | undefined,
  sessionIds: Iterable<string> = [],
): number {
  const participant = participantId(userId);
  let dropped = 0;
  for (const id of sessionIds) {
    if (sessions.delete(id)) dropped++;
  }
  if (participant !== null) {
    for (const [id, record] of sessions) {
      if (record.userId === participant) {
        sessions.delete(id);
        dropped++;
      }
    }
  }
  return dropped;
}

/**
 * A content wipe nulled every stored message created before `cutoffMs`: drop
 * the remembered turns from before it too, so no copy outlives the stored
 * text. The check-in is kept (the wipe does not touch it), and so is whether
 * the session started here: the database lost the same turns, so the copy is
 * as complete as the record. Returns how many turns were dropped. Never throws.
 */
export function forgetTurnsBefore(cutoffMs: number): number {
  if (!Number.isFinite(cutoffMs)) return 0;
  let dropped = 0;
  for (const record of sessions.values()) {
    const kept = record.turns.filter((t) => t.at >= cutoffMs);
    dropped += record.turns.length - kept.length;
    record.turns = kept;
  }
  return dropped;
}

/** How many sessions are held (tests and the health report). */
export function recentTurnsSessionCount(): number {
  return sessions.size;
}

/** Test hook. Also what a restart does: nothing is held. */
export function _resetRecentTurnsForTests(): void {
  sessions.clear();
  nextSeq = 1;
}
