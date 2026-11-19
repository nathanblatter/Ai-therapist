// Text hand-off after the voice vendor ends a GPT-Live session
// (ai-therapist-356, step 1). Wording and the pure decisions are in
// shared/textHandoff.ts; this module does the reading and writing.
//
// What POST /api/chat/start does for a continuation (`continued_from`):
//
//  1. Finds this call's chain: the voice call that was just cut and the
//     sessions linked to it (db/paging.queries getIncidentChainSessionIds, the
//     one chain lookup the paging policy reads too), as far as the requester
//     owns them.
//  2. Waits, briefly, for the cut call's last participant turn to finish being
//     scored. The vendor closes a session one to three seconds after a
//     disclosure, which is about how long the risk assessor takes to read it;
//     without the wait the hand-off would be worded for "no risk" at exactly
//     the moment the risk row is being written.
//  3. Reads two peaks (flags and assessed scores, never the automatic
//     continuation stamp):
//       - the CHAIN's, which alone chooses the first message: the app says "I
//         heard you" only about something said in this call;
//       - the PARTICIPANT's across their sessions in the look-back
//         (crisisPaging.resolveIncidentPeak, which the on-call page uses too),
//         which decides the flag, and turns a calm first message into an open
//         check-in after an earlier high flag elsewhere.
//  4. Flags the new chat session at the participant's peak, as a continuation.
//  5. Seeds the model with the most recent turns of the chain.
//  6. Records the link on both sessions, so the incident can be reviewed from
//     either side.
//
// It does not page. What the on-call is told about the cut is decided where it
// always was, by the sideband's pageVendorTermination; the hand-off adds
// nothing to it.
import { createLogger } from '../utils/logger.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';
import { buildVoiceContinuationGuidance } from '../utils/openingLine.js';
import {
  getHandoffRecord,
  hasOrdinaryOpeningLine,
  getHandoffSessionRow,
  getIncidentTurns,
  getSessionAssessedPeak,
  getSessionRiskCheckSteps,
  insertHandoffLink,
  markTextHandoffContinuation,
  HANDOFF_EVENT,
  VOICE_RETURN_EVENT,
  type HandoffSessionRow,
  type HandoffTurn,
} from '../db/textHandoff.queries.js';
import {
  getIncidentChainSessionIds,
  getParticipantAssessedRisk,
  getParticipantFlagEvents,
  INCIDENT_CHAIN_BACKSTOP_MS,
} from '../db/paging.queries.js';
import {
  handoffFirstMessage,
  handoffKind,
  handoffQuickReplies,
  handoffSpokenBridge,
  handoffStampSeverity,
  maxHandoffSeverity,
  voiceReturnAllowed,
  type HandoffKind,
  type HandoffReason,
  type HandoffSeverity,
  type HandoffStartPayload,
} from '../../shared/textHandoff.js';
import { recoveryCrisisLinePhrase, type RecoveryCrisisContact } from '../../shared/recoveryPrompt.js';

const log = createLogger('textHandoff');

/**
 * Longest the hand-off waits for the cut call's last participant turn to be
 * scored. The participant is on the static screen with the crisis numbers
 * while it runs. Measured 2026-11-18: the assessor answered 1 to 3.5 s after
 * the turn ended and the vendor cut 1 to 3 s after it, so the remaining wait
 * is usually well under two seconds; a turn still unscored at the bound is
 * treated as risk not yet known, which is worded as a crisis.
 */
export const HANDOFF_SCORING_WAIT_MS = 3_000;

/** Size bound on the seeded transcript (unchanged from the first-session-only
 *  seeding this replaces). */
export const HANDOFF_RECAP_MAX_CHARS = 6_000;
/** Most turns read back across the incident before the character bound is applied. */
export const HANDOFF_RECAP_MAX_TURNS = 60;
/** Longest chain of linked sessions followed back from the one that was cut. */
export const HANDOFF_MAX_CHAIN = 8;

/** Marker line placed in the seeded transcript where one session of the
 *  incident ends and the next begins. */
export const HANDOFF_RECAP_SESSION_BREAK = '(the voice service ended the call here; the conversation went on)';

/** Longest either risk read may hold the hand-off up; one that is slower is
 *  treated as failed (risk unknown, worded as a crisis). */
export const HANDOFF_RISK_READ_TIMEOUT_MS = 2_000;

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${HANDOFF_RISK_READ_TIMEOUT_MS} ms`)),
      HANDOFF_RISK_READ_TIMEOUT_MS,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// In-process state
// ---------------------------------------------------------------------------

interface HandoffState {
  kind: HandoffKind;
  /** This call's chain (the wording). */
  severity: HandoffSeverity;
  /** The participant across the look-back (the flag). */
  participantSeverity: HandoffSeverity;
  /** The first participant turn of a crisis hand-off takes the narrow model
   *  path (chat.routes.ts); cleared when that turn is taken. */
  narrowFirstTurn: boolean;
}

/** Hand-off chat sessions started by this process. The database rows are the
 *  record; this only saves a read per turn and holds the one-shot flag. */
const handoffStates = new Map<string, HandoffState>();

/** Test hook. */
export function _resetTextHandoffStateForTests(): void {
  handoffStates.clear();
}

/** Was this chat session started, by this process, as a text hand-off? */
export function isHandoffSession(chatSessionId: string): boolean {
  return handoffStates.has(chatSessionId);
}

/** Drop a session's in-process hand-off state (chat end). */
export function clearHandoffState(chatSessionId: string): void {
  handoffStates.delete(chatSessionId);
}

/**
 * Is this the first participant turn of a crisis hand-off, which is answered
 * on the narrow path? True at most once per session; a process that restarted
 * since the hand-off answers false and the turn takes the ordinary path.
 */
export function consumeNarrowFirstTurn(chatSessionId: string): boolean {
  const state = handoffStates.get(chatSessionId);
  if (!state?.narrowFirstTurn) return false;
  state.narrowFirstTurn = false;
  return true;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * The seeded transcript: the incident's turns as "Participant: ..." / "You:
 * ..." lines, oldest first, keeping the MOST RECENT lines that fit in
 * `maxChars`. Whole lines only (a disclosure cut in half reads as something
 * else), with a marker where one session of the incident ends and the next
 * begins. Returns '' when there is nothing to carry.
 */
export function buildIncidentRecap(turns: HandoffTurn[], maxChars = HANDOFF_RECAP_MAX_CHARS): string {
  const lines: Array<{ text: string; sessionId: string }> = [];
  for (const turn of turns) {
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    const content = (turn.content ?? '').trim();
    if (!content) continue;
    lines.push({ text: `${turn.role === 'user' ? 'Participant' : 'You'}: ${content}`, sessionId: turn.session_id });
  }
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const next = lines[i + 1];
    const marker = next && next.sessionId !== line.sessionId && kept.length > 0 ? HANDOFF_RECAP_SESSION_BREAK : null;
    const cost = line.text.length + 1 + (marker ? marker.length + 1 : 0);
    if (used + cost > maxChars) {
      // The newest line alone is over the bound: keep its end, where a spoken
      // disclosure usually sits, instead of carrying nothing.
      if (kept.length === 0) kept.unshift(line.text.slice(-maxChars));
      break;
    }
    if (marker) kept.unshift(marker);
    kept.unshift(line.text);
    used += cost;
  }
  return kept.join('\n');
}

function asHandoffSeverity(value: string | null | undefined): HandoffSeverity {
  return value === 'high' || value === 'medium' || value === 'unknown' ? value : 'none';
}

// ---------------------------------------------------------------------------
// The incident
// ---------------------------------------------------------------------------

/** Predicate: may the requester read this session? (canAccessSession, bound to
 *  the request by the route.) */
export type SessionAccessCheck = (row: { user_id: number | string | null }, sessionId: string) => boolean;

/**
 * This call's chain, oldest first: the session itself and the sessions it
 * continues, as db/paging.queries getIncidentChainSessionIds finds them (the
 * hand-off's own link rows first, the older stamp-and-start-order walk only
 * where there is no link row; the same lookup the paging policy reads, so
 * there is one answer to "which sessions are this incident"). Stops at the
 * first session the requester may not read (one session's transcript is never
 * seeded into another person's), at a missing row and at HANDOFF_MAX_CHAIN.
 * Empty when `sessionId` itself is missing or not theirs. A chain lookup that
 * fails leaves the cut session alone: it is always carried.
 */
export async function resolveIncidentChain(
  sessionId: string,
  canAccess: SessionAccessCheck,
): Promise<HandoffSessionRow[]> {
  let ids: string[];
  try {
    ids = await getIncidentChainSessionIds(sessionId, new Date(Date.now() - INCIDENT_CHAIN_BACKSTOP_MS));
  } catch (err) {
    log.error({ err }, `[handoff] could not follow the incident back from ${sessionId.substring(0, 12)}...`);
    ids = [sessionId];
  }
  if (ids[0] !== sessionId) ids = [sessionId, ...ids.filter((id) => id !== sessionId)];
  const chain: HandoffSessionRow[] = [];
  for (const id of ids.slice(0, HANDOFF_MAX_CHAIN)) {
    const row = await getHandoffSessionRow(id);
    if (!row || !canAccess(row, id)) break;
    chain.unshift(row);
  }
  return chain;
}

interface Peak {
  severity: HandoffSeverity;
  riskScore: number | null;
}

const EVENT_RANK: Record<string, number> = { none: 0, low: 0, medium: 1, high: 2 };

/**
 * The participant's peak risk in exactly these sessions: their crisis flags
 * (a member of staff raising the risk by hand included) and the scores the
 * assessor gave their turns, never the automatic continuation stamp (the same
 * reads, and the same exclusion, as the paging policy's). No participant-wide
 * look-back: this decides what the app SAYS, and it may only speak about what
 * happened in this call. Throws (or times out) on a failed read.
 */
export async function chainRiskPeak(sessionIds: string[]): Promise<Peak> {
  const now = new Date();
  const [flags, assessed] = await withTimeout(
    Promise.all([getParticipantFlagEvents(sessionIds, null, now), getParticipantAssessedRisk(sessionIds, null, now)]),
    'chain risk read',
  );
  let rank = 0;
  let riskScore: number | null = null;
  for (const event of [...(flags ?? []), ...(assessed ?? [])]) {
    const r = EVENT_RANK[event.severity ?? 'none'] ?? 0;
    if (r === 0) continue;
    if (r > rank) {
      rank = r;
      riskScore = event.risk_score ?? null;
    } else if (r === rank && (event.risk_score ?? -1) > (riskScore ?? -1)) {
      riskScore = event.risk_score ?? null;
    }
  }
  return { severity: rank === 2 ? 'high' : rank === 1 ? 'medium' : 'none', riskScore };
}

/**
 * The participant's peak across ALL their sessions in the paging policy's
 * look-back (crisisPaging.resolveIncidentPeak: the chain plus any other
 * session of theirs in the last 2 hours). What the on-call is told, and what
 * the chat is flagged at; never what the app says. Never throws: that
 * function answers 'unknown' when it cannot read.
 */
async function participantPeak(cut: HandoffSessionRow): Promise<Peak> {
  const { resolveIncidentPeak } = await import('./crisisPaging.service.js');
  const peak = await resolveIncidentPeak(cut.session_id, {
    flagged: cut.crisis_flagged === true,
    severity: cut.crisis_severity,
  });
  return { severity: asHandoffSeverity(peak.severity), riskScore: peak.riskScore };
}

function maxPeak(a: Peak, b: Peak): Peak {
  const severity = maxHandoffSeverity(a.severity, b.severity);
  if (severity === 'unknown') return { severity, riskScore: null };
  const candidates = [a, b].filter((p) => p.severity === severity);
  const riskScore = candidates.reduce<number | null>(
    (best, p) => (p.riskScore !== null && (best === null || p.riskScore > best) ? p.riskScore : best),
    null,
  );
  return { severity, riskScore };
}

export interface PrepareHandoffInput {
  chatSessionId: string;
  /** The voice session the vendor just ended. */
  continuedFrom: string;
  reason: HandoffReason;
  canAccess: SessionAccessCheck;
  crisisContact?: RecoveryCrisisContact | null;
  /** Whether this deployment has a voice mode to go back to. */
  voiceEnabled: boolean;
}

export interface PreparedHandoff {
  payload: HandoffStartPayload;
  /** The server-authored first assistant message. */
  firstMessage: string;
  /** Steering for the model, with the seeded transcript; null when there was
   *  no transcript to carry. */
  guidance: string | null;
}

/**
 * Decide and record the hand-off for a new chat session. Returns null when the
 * session to continue is missing or not the requester's: the caller then
 * starts an ordinary chat session.
 *
 * Fails toward the crisis wording: a risk read that throws or runs out of time
 * is `unknown`, which is worded and flagged as a crisis. Individual writes
 * (the flag, the link rows) are attempted independently; one failing does not
 * cost the participant the others or the session.
 */
export async function prepareTextHandoff(input: PrepareHandoffInput): Promise<PreparedHandoff | null> {
  const { continuedFrom } = input;
  const short = continuedFrom.substring(0, 12);

  const chain = await resolveIncidentChain(continuedFrom, input.canAccess);
  if (chain.length === 0) return null;
  const seededFrom = chain.map((row) => row.session_id);

  // The cut call's last words may still be with the risk assessor.
  let scored = true;
  try {
    const { sidebandManager } = await import('./sidebandManager.service.js');
    scored = await sidebandManager.waitForUserTurnsScored(continuedFrom, HANDOFF_SCORING_WAIT_MS);
  } catch (err) {
    log.error({ err }, `[handoff] could not wait for ${short}... to finish scoring`);
  }

  // This call's own risk: what the app may say.
  let call: Peak;
  try {
    call = await chainRiskPeak(seededFrom);
  } catch (err) {
    log.error({ err }, `[handoff] could not read the risk in ${short}...'s chain; treating it as unknown`);
    call = { severity: 'unknown', riskScore: null };
  }
  if (!scored && call.severity !== 'high') {
    log.warn(`[handoff] ${short}... still had a participant turn being scored; risk treated as unknown`);
    call = { severity: 'unknown', riskScore: null };
  }

  // The participant across the look-back: what the chat is flagged at. It
  // includes the chain, so it is never lower than the call.
  let participant: Peak;
  try {
    participant = maxPeak(await participantPeak(chain[chain.length - 1]), call);
  } catch (err) {
    log.error({ err }, `[handoff] could not read the participant's risk for ${short}...; treating it as unknown`);
    participant = maxPeak({ severity: 'unknown', riskScore: null }, call);
  }

  return await applyHandoff(input, { seededFrom, call, participant, scored, source: 'chat_start' });
}

/**
 * The browser opened a hand-off chat and the server's answer carried no
 * hand-off (the preparation failed, or the cut session could not be linked),
 * so the browser fell back to the crisis wording on its own
 * (client lib/crisisRecovery.ts readHandoffStart). Make the server agree with
 * what is on the participant's screen, on the first request it can: flag the
 * chat as a continuation with risk UNKNOWN (stamped high, no score), store the
 * first message the participant was shown so the transcript, the summary and
 * the model all have the question their next message answers, link and seed
 * from the cut session when it is theirs, and answer their first message on
 * the crisis path.
 *
 * Idempotent: a chat that already has a hand-off (this process's state or a
 * stored link row) is left as it is and null is returned. `chatRow` is the
 * caller's read of the chat session, which must be theirs, a chat session and
 * not ended. Never throws; null when nothing was done.
 */
export async function recordClientHandoffFallback(input: ClientFallbackInput): Promise<PreparedHandoff | null> {
  const { chatSessionId } = input;
  // One at a time per chat (PR #79 review). The browser posts the fallback at
  // once and also carries it on its first chat message until acknowledged, so
  // a quick "Yes" sends it twice in parallel; both used to pass the checks
  // below before either wrote: two flags, two link rows, and the first
  // message twice in the transcript and in the model's context. A second
  // caller now waits for the first and then does nothing.
  const inFlight = fallbacksInFlight.get(chatSessionId);
  if (inFlight) {
    await inFlight.catch(() => null);
    return null;
  }
  const work = recordClientHandoffFallbackOnce(input);
  fallbacksInFlight.set(chatSessionId, work);
  try {
    return await work;
  } finally {
    fallbacksInFlight.delete(chatSessionId);
  }
}

interface ClientFallbackInput {
  chatSessionId: string;
  chatRow: HandoffSessionRow;
  continuedFrom: string;
  reason: HandoffReason;
  canAccess: SessionAccessCheck;
  crisisContact?: RecoveryCrisisContact | null;
  voiceEnabled: boolean;
}

const fallbacksInFlight = new Map<string, Promise<PreparedHandoff | null>>();

/** Session ids are short and plain; anything else is not one and is never
 *  stored (PR #79 review stored a 50,000-character `continued_from`). */
const SESSION_ID_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;

async function recordClientHandoffFallbackOnce(input: ClientFallbackInput): Promise<PreparedHandoff | null> {
  const { chatSessionId, chatRow, continuedFrom } = input;
  try {
    if (!SESSION_ID_SHAPE.test(continuedFrom)) return null;
    if (chatRow.session_type !== 'chat' || chatRow.status === 'ended') return null;
    if (!input.canAccess(chatRow, chatSessionId) || continuedFrom === chatSessionId) return null;
    if (handoffStates.has(chatSessionId)) return null;
    if (await getHandoffRecord(chatSessionId)) return null;
    // Never an ORDINARY chat. A chat started as a hand-off continuation gets no
    // ordinary opening line (chat.routes.ts), so a chat that has one was not
    // opened by a vendor cut and must not be turned into a crisis continuation
    // by a browser request (PR #79 review: one was, the crisis first message
    // appended after "Hello! I'm an AI ...", flagged high).
    if (await hasOrdinaryOpeningLine(chatSessionId)) return null;
    // The cut session links and seeds only when it is the requester's; the
    // flag and the first message stand either way, since the browser knows a
    // vendor cut happened and has already said so.
    const chain = await resolveIncidentChain(continuedFrom, input.canAccess).catch(() => []);
    const unknown: Peak = { severity: 'unknown', riskScore: null };
    return await applyHandoff(
      { ...input, continuedFrom },
      {
        seededFrom: chain.map((row) => row.session_id),
        call: unknown,
        participant: unknown,
        scored: false,
        source: 'client_fallback',
      },
    );
  } catch (err) {
    log.error(
      { err },
      `[handoff] could not record the browser's hand-off fallback for ${chatSessionId.slice(0, 16)}...`,
    );
    return null;
  }
}

/** Decide the wording, write the flag and the links, build the seeding, and
 *  hold the in-process state. Shared by the chat start and the browser's
 *  fallback. */
async function applyHandoff(
  input: Pick<PrepareHandoffInput, 'chatSessionId' | 'continuedFrom' | 'reason' | 'crisisContact' | 'voiceEnabled'>,
  facts: {
    seededFrom: string[];
    call: Peak;
    participant: Peak;
    scored: boolean;
    source: 'chat_start' | 'client_fallback';
  },
): Promise<PreparedHandoff> {
  const { chatSessionId, continuedFrom, reason } = input;
  const { seededFrom, call, participant, scored, source } = facts;
  const short = continuedFrom.substring(0, 12);

  const kind = handoffKind(reason, call.severity, participant.severity);
  const returnAllowed =
    input.voiceEnabled &&
    voiceReturnAllowed({
      handoffSeverity: call.severity,
      participantSeverity: participant.severity,
      chatPeakSeverity: 'none',
      riskCheckSteps: [],
    });
  const firstMessage = handoffFirstMessage(kind, returnAllowed);

  // The flag: the participant's peak in the look-back, as a continuation stamp.
  const stamp = handoffStampSeverity(participant.severity);
  if (stamp) {
    try {
      await markTextHandoffContinuation(chatSessionId, {
        severity: stamp,
        riskScore: participant.severity === 'unknown' ? null : participant.riskScore,
        continuedFrom,
        reason,
      });
    } catch (err) {
      log.error({ err }, `[handoff] failed to flag ${chatSessionId.substring(0, 16)}... as a crisis continuation`);
    }
  }

  // The link, on both sessions (only to a cut session that is the requester's).
  const linked = seededFrom.includes(continuedFrom);
  const linkFacts = {
    event: HANDOFF_EVENT,
    reason,
    kind,
    severity: call.severity,
    participantSeverity: participant.severity,
    ...(call.riskScore === null ? {} : { riskScore: call.riskScore }),
    ...(participant.riskScore === null ? {} : { participantRiskScore: participant.riskScore }),
    seededFrom,
    scoringSettled: scored,
    source,
  };
  await Promise.all([
    insertHandoffLink(chatSessionId, {
      ...linkFacts,
      role: 'continuation',
      ...(linked ? { from: continuedFrom } : { unlinkedFrom: continuedFrom }),
    }).catch((err) => log.error({ err }, '[handoff] failed to record the hand-off on the chat session')),
    linked
      ? insertHandoffLink(continuedFrom, { ...linkFacts, role: 'cut_session', to: chatSessionId }).catch((err) =>
          log.error({ err }, '[handoff] failed to record the hand-off on the voice session'),
        )
      : Promise.resolve(),
  ]);

  // What was said in this call's chain.
  let guidance: string | null = null;
  try {
    const recap = seededFrom.length
      ? buildIncidentRecap(await getIncidentTurns(seededFrom, HANDOFF_RECAP_MAX_TURNS))
      : '';
    if (recap) {
      guidance = buildVoiceContinuationGuidance(recap, {
        kind,
        severity: call.severity,
        crisisLine: recoveryCrisisLinePhrase(input.crisisContact),
      });
    }
  } catch (err) {
    // Continuity is best effort; the session, its flag and its first message stand.
    log.error({ err }, '[handoff] failed to read the incident transcript');
  }

  handoffStates.set(chatSessionId, {
    kind,
    severity: call.severity,
    participantSeverity: participant.severity,
    narrowFirstTurn: kind === 'crisis',
  });
  if (handoffStates.size > 500) {
    for (const id of handoffStates.keys()) {
      if (handoffStates.size <= 400) break;
      handoffStates.delete(id);
    }
  }

  log.warn(
    `[handoff] voice session ${short}... (${reason}) continues as chat ${chatSessionId.substring(0, 16)}...: ` +
      `${kind}, call risk ${call.severity}${call.riskScore === null ? '' : ` (${call.riskScore}/100)`}, ` +
      `participant risk ${participant.severity}, seeded from ${seededFrom.length} session(s)` +
      (source === 'client_fallback' ? ', recorded from the browser fallback' : ''),
  );
  if (global.io) {
    const event = {
      sessionId: chatSessionId,
      continuedFrom,
      reason,
      kind,
      severity: call.severity,
      participantSeverity: participant.severity,
      riskScore: call.riskScore,
      seededFrom,
      source,
      at: new Date(),
    };
    void broadcastAdminEventForSession(global.io, 'session:text-handoff', event, chatSessionId).catch((err: unknown) =>
      log.error({ err }, '[handoff] admin broadcast failed'),
    );
  }

  return {
    payload: {
      kind,
      severity: call.severity,
      participantSeverity: participant.severity,
      reason,
      quickReplies: handoffQuickReplies(kind),
      voiceReturnAllowed: returnAllowed,
      spokenBridge: handoffSpokenBridge(kind, input.crisisContact),
      seededFrom,
    },
    firstMessage,
    guidance,
  };
}

// ---------------------------------------------------------------------------
// Return to voice
// ---------------------------------------------------------------------------

/**
 * May a new voice call be started from this chat session right now? Null when
 * the session is not a hand-off continuation at all (the caller then applies
 * its ordinary rules). The rule is shared/textHandoff.ts voiceReturnAllowed,
 * read from stored state. Any read that fails answers false: the button is
 * withheld, never offered on a guess.
 */
export async function resolveVoiceReturn(chatSessionId: string): Promise<boolean | null> {
  try {
    const state = handoffStates.get(chatSessionId);
    let severity = state?.severity;
    let participantSeverity = state?.participantSeverity;
    if (severity === undefined) {
      const record = await getHandoffRecord(chatSessionId);
      if (!record) return null;
      severity = asHandoffSeverity(record.severity);
      // A row written before the participant-wide severity was recorded
      // carries only the one it was worded from.
      participantSeverity = record.participantSeverity ? asHandoffSeverity(record.participantSeverity) : severity;
    }
    const [chatPeakSeverity, riskCheckSteps] = await Promise.all([
      getSessionAssessedPeak(chatSessionId),
      getSessionRiskCheckSteps(chatSessionId),
    ]);
    return voiceReturnAllowed({ handoffSeverity: severity, participantSeverity, chatPeakSeverity, riskCheckSteps });
  } catch (err) {
    log.error({ err }, `[handoff] could not decide voice return for ${chatSessionId.substring(0, 16)}...`);
    return false;
  }
}

/**
 * Server-side check for "start a new voice call from this hand-off chat": the
 * chat session exists, is the requester's, was started by a text hand-off, and
 * its risk check has cleared (resolveVoiceReturn). The browser's own copy of
 * that answer is never trusted. Never throws; any doubt answers false.
 */
export async function verifyVoiceReturn(chatSessionId: string, canAccess: SessionAccessCheck): Promise<boolean> {
  try {
    const row = await getHandoffSessionRow(chatSessionId);
    if (!row || row.session_type !== 'chat' || !canAccess(row, chatSessionId)) return false;
    return (await resolveVoiceReturn(chatSessionId)) === true;
  } catch (err) {
    log.error({ err }, `[handoff] could not verify voice return for ${chatSessionId.substring(0, 16)}...`);
    return false;
  }
}

/** Record that a voice call was started again from a hand-off chat session,
 *  so a later cut of that call is seeded from the whole incident. */
export async function recordVoiceReturn(voiceSessionId: string, chatSessionId: string): Promise<void> {
  try {
    await insertHandoffLink(voiceSessionId, { event: VOICE_RETURN_EVENT, from: chatSessionId });
  } catch (err) {
    log.error({ err }, '[handoff] failed to record the return to voice');
  }
}
