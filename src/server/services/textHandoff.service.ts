// Text hand-off after the voice vendor ends a GPT-Live session
// (ai-therapist-356, step 1). Wording and the pure decisions are in
// shared/textHandoff.ts; this module does the reading and writing.
//
// What POST /api/chat/start does for a continuation (`continued_from`):
//
//  1. Finds every session of the incident (the voice call that was just cut,
//     and anything it continued) that the requester owns.
//  2. Waits, briefly, for the cut call's last participant turn to finish being
//     scored. The vendor closes a session one to three seconds after a
//     disclosure, which is about how long the risk assessor takes to read it;
//     without the wait the hand-off would be worded for "no risk" at exactly
//     the moment the risk row is being written.
//  3. Reads the participant's real peak risk in the incident
//     (crisisPaging.resolveIncidentPeak: flags and assessed scores, never the
//     automatic continuation stamp) and from it chooses the first message.
//  4. Flags the new chat session at that severity, as a continuation.
//  5. Seeds the model with the most recent turns of the whole incident.
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
  getHandoffSessionRow,
  getIncidentTurns,
  getPredecessorSessionId,
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
  handoffFirstMessage,
  handoffKind,
  handoffQuickReplies,
  handoffSpokenBridge,
  handoffStampSeverity,
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

const SEVERITY_RANK: Record<HandoffSeverity, number> = { none: 0, medium: 1, unknown: 2, high: 3 };

// ---------------------------------------------------------------------------
// In-process state
// ---------------------------------------------------------------------------

interface HandoffState {
  kind: HandoffKind;
  severity: HandoffSeverity;
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
 * Every session of the incident that ends with `sessionId`, oldest first: the
 * session itself and the sessions it continued, followed back through the
 * link rows. Stops at the first session the requester may not read (one
 * session's transcript is never seeded into another person's), at a missing
 * row, at a loop, and at HANDOFF_MAX_CHAIN. Empty when `sessionId` itself is
 * missing or not theirs.
 */
export async function resolveIncidentChain(
  sessionId: string,
  canAccess: SessionAccessCheck,
): Promise<HandoffSessionRow[]> {
  const chain: HandoffSessionRow[] = [];
  const seen = new Set<string>();
  let current: string | null = sessionId;
  while (current && !seen.has(current) && chain.length < HANDOFF_MAX_CHAIN) {
    const id: string = current;
    seen.add(id);
    const row = await getHandoffSessionRow(id);
    if (!row || !canAccess(row, id)) break;
    chain.unshift(row);
    try {
      current = await getPredecessorSessionId(id);
    } catch (err) {
      // The cut session itself is always carried; older links are best effort.
      log.error({ err }, `[handoff] could not follow the incident back from ${id.substring(0, 12)}...`);
      current = null;
    }
  }
  return chain;
}

/**
 * The participant's peak risk across the incident. For a logged-in participant
 * one read already spans their sessions; an anonymous one has no account to
 * follow, so each linked session is read and the highest stands.
 */
async function incidentPeak(
  chain: HandoffSessionRow[],
): Promise<{ severity: HandoffSeverity; riskScore: number | null }> {
  const { resolveIncidentPeak } = await import('./crisisPaging.service.js');
  let best: { severity: HandoffSeverity; riskScore: number | null } = { severity: 'none', riskScore: null };
  // Newest first: for a logged-in participant the first read is the answer.
  for (const row of [...chain].reverse()) {
    const peak = await resolveIncidentPeak(row.session_id, {
      flagged: row.crisis_flagged === true,
      severity: row.crisis_severity,
    });
    const severity = asHandoffSeverity(peak.severity);
    if (
      SEVERITY_RANK[severity] > SEVERITY_RANK[best.severity] ||
      (severity === best.severity && (peak.riskScore ?? -1) > (best.riskScore ?? -1))
    ) {
      best = { severity, riskScore: peak.riskScore };
    }
    if (best.severity === 'high' || row.user_id !== null) break;
  }
  return best;
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
  const { chatSessionId, continuedFrom, reason } = input;
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

  let peak: { severity: HandoffSeverity; riskScore: number | null };
  try {
    peak = await incidentPeak(chain);
  } catch (err) {
    log.error({ err }, `[handoff] could not read the incident's risk for ${short}...; treating it as unknown`);
    peak = { severity: 'unknown', riskScore: null };
  }
  if (!scored && peak.severity !== 'high') {
    log.warn(`[handoff] ${short}... still had a participant turn being scored; risk treated as unknown`);
    peak = { severity: 'unknown', riskScore: null };
  }

  const kind = handoffKind(reason, peak.severity);
  const returnAllowed =
    input.voiceEnabled &&
    voiceReturnAllowed({ handoffSeverity: peak.severity, chatPeakSeverity: 'none', riskCheckSteps: [] });
  const firstMessage = handoffFirstMessage(kind, returnAllowed);

  // The flag. A continuation starts at the incident's real severity.
  const stamp = handoffStampSeverity(peak.severity);
  if (stamp) {
    try {
      await markTextHandoffContinuation(chatSessionId, {
        severity: stamp,
        riskScore: peak.severity === 'unknown' ? null : peak.riskScore,
        continuedFrom,
        reason,
      });
    } catch (err) {
      log.error({ err }, `[handoff] failed to flag ${chatSessionId.substring(0, 16)}... as a crisis continuation`);
    }
  }

  // The link, on both sessions.
  const linkFacts = {
    event: HANDOFF_EVENT,
    reason,
    kind,
    severity: peak.severity,
    ...(peak.riskScore === null ? {} : { riskScore: peak.riskScore }),
    seededFrom,
    scoringSettled: scored,
  };
  await Promise.all([
    insertHandoffLink(chatSessionId, { ...linkFacts, role: 'continuation', from: continuedFrom }).catch((err) =>
      log.error({ err }, '[handoff] failed to record the hand-off on the chat session'),
    ),
    insertHandoffLink(continuedFrom, { ...linkFacts, role: 'cut_session', to: chatSessionId }).catch((err) =>
      log.error({ err }, '[handoff] failed to record the hand-off on the voice session'),
    ),
  ]);

  // What was said, across the whole incident.
  let guidance: string | null = null;
  try {
    const recap = buildIncidentRecap(await getIncidentTurns(seededFrom, HANDOFF_RECAP_MAX_TURNS));
    if (recap) {
      guidance = buildVoiceContinuationGuidance(recap, {
        kind,
        severity: peak.severity,
        crisisLine: recoveryCrisisLinePhrase(input.crisisContact),
      });
    }
  } catch (err) {
    // Continuity is best effort; the session, its flag and its first message stand.
    log.error({ err }, '[handoff] failed to read the incident transcript');
  }

  handoffStates.set(chatSessionId, { kind, severity: peak.severity, narrowFirstTurn: kind === 'crisis' });
  if (handoffStates.size > 500) {
    for (const id of handoffStates.keys()) {
      if (handoffStates.size <= 400) break;
      handoffStates.delete(id);
    }
  }

  log.warn(
    `[handoff] voice session ${short}... (${reason}) continues as chat ${chatSessionId.substring(0, 16)}...: ` +
      `${kind}, incident risk ${peak.severity}${peak.riskScore === null ? '' : ` (${peak.riskScore}/100)`}, ` +
      `seeded from ${seededFrom.length} session(s)`,
  );
  if (global.io) {
    const event = {
      sessionId: chatSessionId,
      continuedFrom,
      reason,
      kind,
      severity: peak.severity,
      riskScore: peak.riskScore,
      seededFrom,
      at: new Date(),
    };
    void broadcastAdminEventForSession(global.io, 'session:text-handoff', event, chatSessionId).catch((err: unknown) =>
      log.error({ err }, '[handoff] admin broadcast failed'),
    );
  }

  return {
    payload: {
      kind,
      severity: peak.severity,
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
    let severity = handoffStates.get(chatSessionId)?.severity;
    if (severity === undefined) {
      const record = await getHandoffRecord(chatSessionId);
      if (!record) return null;
      severity = asHandoffSeverity(record.severity);
    }
    const [chatPeakSeverity, riskCheckSteps] = await Promise.all([
      getSessionAssessedPeak(chatSessionId),
      getSessionRiskCheckSteps(chatSessionId),
    ]);
    return voiceReturnAllowed({ handoffSeverity: severity, chatPeakSeverity, riskCheckSteps });
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
