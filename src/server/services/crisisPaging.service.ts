// On-call paging policy for participant crises (ai-therapist-350, 349, 320).
//
// crisisAlert.service is the transport (one SMS to the on-call phone). This
// module decides WHETHER a participant-linked event becomes an SMS, and what
// the SMS says. Before it existed every caller paged on its own, keyed on the
// session id at best: one person in one crisis produced four texts in 2.5
// minutes, because each recovery session is a new session id and "risk is
// high" and "the vendor ended the session" paged independently.
//
// THE RULES
//
//  1. The first page for a participant always goes out, immediately.
//  2. A later event for the SAME PARTICIPANT (any session, so a recovery chain
//     counts as one incident) inside PAGE_FOLD_WINDOW_MS of a DELIVERED page
//     is folded into that page when the earlier page already told the on-call
//     everything this one would: same or higher level, and, for a vendor
//     termination, the earlier page was itself about a vendor termination.
//  3. Anything that carries new, worse information pages at once, whatever the
//     window: a higher level (vendor cut at medium < high < critical), or the
//     first vendor termination of a high-risk session.
//  4. A folded event is never invisible: it is written to intervention_actions
//     with the reason and the action_id of the page it was folded into, and
//     the admin dashboards get a live event.
//  5. The vendor's content filter ending a session is not, by itself, a page.
//     What the PARTICIPANT's risk was decides it (see pageVendorTermination).
//     With no risk signal there is no SMS at the cut, but there is a check
//     VENDOR_CUT_SILENCE_CHECK_MS later: if the participant has not spoken
//     again in any session, the on-call is paged then. The filter can end a
//     session before the participant's last words reach us, so "nothing was
//     flagged" plus "they never came back" is not a safe place to stop.
//     The check is owed by the stored row, not by this process: see
//     "the silence check" below (ai-therapist-362).
//
// FAIL TOWARD PAGING. Only a page that is known to have been DELIVERED can
// absorb a later one. A lookup that throws, a row that cannot be parsed, a
// pager that returned an error, a page that was skipped because paging is
// switched off: none of them suppresses anything.
//
// State: the paging decisions already written to intervention_actions (read
// per decision, so it survives a restart and spans sessions) plus a small
// in-process ledger that closes the gap between "send started" and "row
// written". Two events one second apart (22:29:32 and 22:29:33 in the stage
// test) would otherwise both find an empty table.
import { createLogger } from '../utils/logger.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  getPagingParticipantUserId,
  getRecentPagingRecords,
  getIncidentChainSessionIds,
  getParticipantFlagEvents,
  getParticipantAssessedRisk,
  participantSpokeSince,
  insertPagingRecord,
  getUnfinishedSilenceChecks,
  claimSilenceCheck,
  releaseSilenceCheck,
  finishSilenceCheck,
  INCIDENT_CHAIN_BACKSTOP_MS,
  type PagingRecordRow,
} from '../db/paging.queries.js';

const log = createLogger('crisisPaging');

/**
 * How long a delivered page absorbs same-or-lower events for the participant.
 * 15 minutes is the on-call's own acknowledgement target (docs/on-call-sop.md
 * section 3): inside it the on-call is already expected to be opening the
 * session, and a second text saying the same thing adds nothing. The window
 * is anchored on the last DELIVERED page and is not extended by folded
 * events, so a crisis that keeps producing events pages again every 15
 * minutes rather than going quiet.
 */
export const PAGE_FOLD_WINDOW_MS = 15 * 60 * 1000;

/**
 * How far back a crisis flag on one of the participant's OTHER sessions still
 * counts as "this incident" when a vendor termination has to be classified.
 *
 * This is the time bound for sessions that are not linked to this one. The
 * sessions that ARE linked, the recovery chain (each recovery session
 * continues the one before it), count however long the chain has run: a
 * participant flagged high whose recovery session is cut 2 h 20 min later is
 * the same incident, and a clock alone called it "no risk" (PR #64 review).
 * The chain walk has its own, longer backstop (INCIDENT_CHAIN_BACKSTOP_MS).
 */
export const INCIDENT_LOOKBACK_MS = 2 * 60 * 60 * 1000;

/**
 * A high-band score at or above this is its own, higher page level. It is the
 * stand-in for "attempt in progress / imminent": no detector reports that as
 * a separate fact today, and the assessor reserves the top of the range for
 * it. So 75 followed by 95 pages again (labelled as an escalation), while 75
 * followed by 86 is folded.
 */
export const CRITICAL_RISK_SCORE = 90;

/**
 * OWNER'S CLINICAL CALL, NOT YET MADE (ai-therapist-353). When a participant
 * the on-call was paged about minutes ago goes from ideation to a stated time
 * or plan ("tonight", "I have what I need") and the score stays below
 * CRITICAL_RISK_SCORE (it is typically 85), does that turn page again inside
 * the 15-minute window?
 *
 *   true  (the default: fail toward paging) a page that says what changed.
 *   false the turn is still flagged and recorded as an escalation, and is
 *         folded into the earlier page; only an attempt in progress or a
 *         score of 90 or more pages again.
 *
 * An attempt in progress always pages again; that is not behind this switch.
 */
export const REPAGE_ON_STATED_TIME_OR_PLAN = true;

/** What a high turn says is happening (crisisDetection `acute`). */
export type PageEscalation = 'plan_or_time' | 'attempt';

function asEscalation(value: unknown): PageEscalation | null {
  return value === 'attempt' || value === 'plan_or_time' ? value : null;
}

/**
 * How far along a risk page says things are: 0 ideation or unspecified, 1 a
 * stated time or plan, 2 an attempt in progress. A page covers a later one
 * only when it was at least as far along, so "stated intent tonight" is not
 * swallowed by the page about ideation ten minutes earlier, and an attempt is
 * never swallowed by anything short of a page about an attempt.
 */
export function pageStage(escalation: PageEscalation | null | undefined): 0 | 1 | 2 {
  if (escalation === 'attempt') return 2;
  if (escalation === 'plan_or_time') return REPAGE_ON_STATED_TIME_OR_PLAN ? 1 : 0;
  return 0;
}

/** The page's own words for what changed. No participant text, no PHI. */
export const ESCALATION_WORDS: Record<PageEscalation, string> = {
  plan_or_time: 'STATED INTENT WITH A TIME OR PLAN',
  attempt: 'ATTEMPT IN PROGRESS, or an act already taken',
};

/**
 * After a content-filter cut that was not paged (no risk signal), how long
 * the participant has to say something, in any session, before the on-call is
 * paged after all. In the 2026-11-18 stage test the participant spoke 12 s
 * into the recovery session; 3 minutes leaves room for two voice reconnection
 * attempts and the typed-chat fallback.
 */
export const VENDOR_CUT_SILENCE_CHECK_MS = 3 * 60 * 1000;

/**
 * A silence check that nobody ran by this age is not run at all. It is the
 * fold window on purpose: a check found later than this (a long outage) would
 * page about a cut the on-call can no longer act on as "just happened", and
 * a server that comes back after hours must not send a burst of old pages.
 * The row is marked expired and admins are told, so the miss is on record.
 */
export const SILENCE_CHECK_CEILING_MS = PAGE_FOLD_WINDOW_MS;

/**
 * A claimed check that has not reported back after this long is taken to
 * have died with its process and may be claimed again. A check takes a few
 * seconds at worst (three 2 s lookups and a 5 s send).
 */
export const SILENCE_CHECK_STALE_CLAIM_MS = 60 * 1000;

/** How far back the sweep looks for checks to mark expired. */
const SILENCE_CHECK_EXPIRY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Names this process on a claimed check (audit only; the claim itself is
 *  the row update). No participant data. */
const INSTANCE_ID = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/**
 * Longest any lookup may hold a page back. The lookups only ever decide
 * whether a page can be SPARED; one that is slow is treated like one that
 * failed, and the page goes out.
 */
export const PAGING_LOOKUP_TIMEOUT_MS = 2000;

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${PAGING_LOOKUP_TIMEOUT_MS} ms`)),
      PAGING_LOOKUP_TIMEOUT_MS,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export const PAGE_LEVEL = {
  /** Vendor termination of a session whose peak participant risk is medium,
   *  or could not be read. */
  mediumVendorCut: 1,
  /** High risk: a high flag, or a vendor termination during one. */
  high: 2,
  /** High risk with a score at or above CRITICAL_RISK_SCORE. */
  critical: 3,
} as const;
export type PageLevel = (typeof PAGE_LEVEL)[keyof typeof PAGE_LEVEL];

/** What a page is about. Stored as a list so a page can be about more than
 *  one thing; today each page has exactly one kind. */
export type PageKind = 'risk' | 'vendor_cut' | 'vendor_ceiling';

/**
 * WHO a high-risk page is about (PR 65): the participant ('own'), someone
 * else the participant is reporting on ('third_party', ai-therapist-326), or
 * a person the participant may harm ('harm_to_others', ai-therapist-330).
 * It is part of what a page tells the on-call, so it is part of what decides
 * whether an earlier page covers a later one: "THIRD PARTY AT RISK: ... not
 * their own" does not cover the participant's own disclosure ten minutes
 * later, whatever the two scores are.
 */
export type PageSubject = 'own' | 'third_party' | 'harm_to_others';

function asPageSubject(value: unknown): PageSubject {
  return value === 'third_party' || value === 'harm_to_others' ? value : 'own';
}

/** Second line of a page about someone other than the participant. The same
 *  wording as the dashboard alert (crisisIntervention subjectLabel). */
export const PAGE_SUBJECT_LABEL: Record<PageSubject, string | null> = {
  own: null,
  third_party: 'THIRD PARTY AT RISK: the participant is reporting someone else in crisis, not their own.',
  harm_to_others: 'RISK TO OTHERS: the participant is describing thoughts of harming another person, not self-harm.',
};

export type PageOutcome =
  /** An SMS was delivered. */
  | 'paged'
  /** A send was attempted and not delivered (pager error, disabled, not configured). */
  | 'not_delivered'
  /** Folded into an earlier delivered page for the same participant. */
  | 'folded'
  /** Sandbox-owned session: never pages (unchanged policy). */
  | 'sandbox'
  /** Recorded and shown to admins, deliberately not an SMS. */
  | 'no_page';

export interface PageDecision {
  outcome: PageOutcome;
  kind: PageKind;
  level: PageLevel | null;
  /** intervention_actions.action_id of the row this decision wrote, if any. */
  actionId: number | null;
  /** For 'folded': the page that absorbed it. */
  foldedIntoActionId?: number | null;
  foldedIntoSessionId?: string;
}

/** What one paging channel did with a page, as stored on the page's row. */
interface ChannelRecord {
  channel: string;
  ok: boolean;
  error: string | null;
  messageIds: string[];
  parts: number;
  partsAccepted: number;
  ms: number;
}

/** A page this participant's on-call has (or is about to have) received. */
interface PriorPage {
  actionId: number | null;
  sessionId: string;
  at: number;
  level: PageLevel;
  kinds: PageKind[];
  riskScore: number | null;
  /** Who a page was about: for a 'risk' page the person the flag concerned,
   *  for a vendor page the person the session's peak risk concerned. 'own'
   *  for rows written before the subject was recorded. */
  subject?: PageSubject;
  /** pageStage of a risk page; absent or 0 for vendor pages and older rows. */
  stage?: 0 | 1 | 2;
}

interface LedgerEntry extends PriorPage {
  /** Resolves true once the SMS is delivered, false if it was not. */
  delivery: Promise<boolean>;
  settled: boolean;
  delivered: boolean;
  /** Resolves with the action_id once the row is written. */
  recorded: Promise<number | null>;
}

interface PageRequest {
  sessionId: string;
  kind: PageKind;
  level: PageLevel;
  riskScore: number | null;
  /** Who the page is about (see PriorPage.subject). */
  subject?: PageSubject;
  /** What a risk turn says is happening, when it says so. */
  escalation?: PageEscalation | null;
  /** Free-form facts for the audit row (peak severity, cause, ...). */
  facts: Record<string, unknown>;
  /** One line for the admin dashboards and the audit row. No PHI. */
  summary: string;
  buildMessage: (ctx: MessageContext) => string;
}

interface MessageContext {
  /** Most recent delivered page for this participant inside the window. */
  previousPage: PriorPage | null;
  /** A vendor cut inside the window that nobody was paged about. */
  unpagedCut: { sessionId: string; at: number } | null;
  now: number;
}

// ---- in-process ledger -----------------------------------------------------

const ledger = new Map<string, LedgerEntry[]>();

function participantKey(sessionId: string, userId: number | null): string {
  return userId === null ? `session:${sessionId}` : `user:${userId}`;
}

function ledgerEntries(key: string, now: number): LedgerEntry[] {
  const live = (ledger.get(key) ?? []).filter((e) => now - e.at < PAGE_FOLD_WINDOW_MS);
  if (live.length > 0) ledger.set(key, live);
  else ledger.delete(key);
  return live;
}

function dropLedgerEntry(key: string, entry: LedgerEntry): void {
  const rest = (ledger.get(key) ?? []).filter((e) => e !== entry);
  if (rest.length > 0) ledger.set(key, rest);
  else ledger.delete(key);
}

/** Armed silence checks, by the action_id of the cut's row (or a private key
 *  when the row could not be written). One timer per check per process. */
const silenceTimers = new Map<number | string, ReturnType<typeof setTimeout>>();

/** Test hook. Also what a restart does to this process's memory: the ledger
 *  and every armed timer are gone, and only the stored rows remain. */
export function _resetPagingStateForTests(): void {
  ledger.clear();
  for (const timer of silenceTimers.values()) clearTimeout(timer);
  silenceTimers.clear();
}

// ---- pure rules (exported for tests) --------------------------------------

const KNOWN_KINDS: readonly PageKind[] = ['risk', 'vendor_cut', 'vendor_ceiling'];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The paging payload of an intervention_actions row, or null. */
function pagingPayload(row: PagingRecordRow): Record<string, unknown> | null {
  return asRecord(asRecord(row.action_details)?.['paging']);
}

/**
 * A stored row as a page that can absorb later ones: only a 'crisis_sms_alert'
 * row that says, in so many words, that it was delivered. Anything else
 * (rows written before this policy existed, undelivered attempts, a payload
 * that does not parse) is not a page as far as folding is concerned.
 */
export function priorPageFromRow(row: PagingRecordRow): PriorPage | null {
  if (row.action_type !== 'crisis_sms_alert') return null;
  const paging = pagingPayload(row);
  if (!paging || paging['delivered'] !== true) return null;
  const level = paging['level'];
  if (level !== PAGE_LEVEL.mediumVendorCut && level !== PAGE_LEVEL.high && level !== PAGE_LEVEL.critical) return null;
  const kinds = Array.isArray(paging['kinds'])
    ? (paging['kinds'] as unknown[]).filter((k): k is PageKind => KNOWN_KINDS.includes(k as PageKind))
    : [];
  if (kinds.length === 0) return null;
  const at = new Date(row.performed_at).getTime();
  if (!Number.isFinite(at)) return null;
  const score = paging['riskScore'];
  return {
    actionId: row.action_id,
    sessionId: row.session_id,
    at,
    level,
    kinds,
    riskScore: typeof score === 'number' ? score : null,
    subject: asPageSubject(paging['subject']),
    stage: paging['stage'] === 2 ? 2 : paging['stage'] === 1 ? 1 : 0,
  };
}

/**
 * Does an earlier page already tell the on-call what this one would?
 *
 * Same or higher level, inside the window. A vendor termination additionally
 * needs the earlier page to have been about a vendor termination: "risk is
 * high" does not say "and the conversation has just vanished". The reverse
 * holds: a page that the vendor ended a high-risk session covers a repeat
 * high flag, because it already says the participant is at high risk.
 */
export function pageCovers(
  prior: Pick<PriorPage, 'at' | 'level' | 'kinds'> & { subject?: PageSubject; stage?: 0 | 1 | 2 },
  request: { kind: PageKind; level: PageLevel; subject?: PageSubject; escalation?: PageEscalation | null },
  now: number,
): boolean {
  const age = now - prior.at;
  if (age < 0 || age >= PAGE_FOLD_WINDOW_MS) return false;
  if (prior.level < request.level) return false;
  if (request.kind !== 'risk') return prior.kinds.includes(request.kind);
  // A page that did not say "a time or plan" / "an attempt" has not told the
  // on-call that (ai-therapist-353).
  if ((prior.stage ?? 0) < pageStage(request.escalation)) return false;
  // A risk page is covered only by a page about the same person. A page that
  // said "third party, not their own" (or "risk to others, not self-harm")
  // has told the on-call nothing about the participant's own risk, and the
  // reverse. A vendor page carries subject 'own': it reports the
  // participant's own session.
  return (prior.subject ?? 'own') === (request.subject ?? 'own');
}

/** Page level of a high-severity risk flag: critical at 90 and up, and for an
 *  attempt in progress whatever the number. */
export function riskPageLevel(riskScore: number, escalation: PageEscalation | null = null): PageLevel {
  return riskScore >= CRITICAL_RISK_SCORE || escalation === 'attempt' ? PAGE_LEVEL.critical : PAGE_LEVEL.high;
}

export type PeakSeverity = 'none' | 'medium' | 'high' | 'unknown';

/** The peak risk of an incident and whom it concerned (resolveIncidentPeak). */
export interface IncidentPeak {
  severity: PeakSeverity;
  riskScore: number | null;
  /** Whom the peak was about. Absent or 'own': the participant. */
  subject?: PageSubject;
  /** The participant's OWN peak, when the overall peak was about someone else. */
  ownSeverity?: PeakSeverity;
}

/**
 * What a content-filter termination becomes, from the participant's peak risk
 * in this incident:
 *   none (or low)  no SMS at the cut. Recorded, admins notified, and checked
 *                  again later (runVendorCutSilenceCheck). The filter also
 *                  stops the assistant's own words (ai-therapist-349: it cut
 *                  the standard screening question); with nothing from the
 *                  participant to go with it, it is a platform event to review.
 *   medium         SMS, at the lowest level. See pageVendorTermination.
 *   high           SMS at the high level: the conversation vanished at the
 *                  worst moment.
 *   unknown        the risk could not be read: SMS at the lowest level and
 *                  the text says so. Not knowing is not "no risk".
 */
export function vendorCutLevel(peak: PeakSeverity): PageLevel | null {
  if (peak === 'high') return PAGE_LEVEL.high;
  if (peak === 'medium' || peak === 'unknown') return PAGE_LEVEL.mediumVendorCut;
  return null;
}

// ---- message copy (PHI-free: a session id prefix and numbers only) ---------

function adminLink(sessionId: string): string {
  const base = (process.env.APP_BASE_URL ?? 'https://ai-therapist.nathanblatter.com').trim().replace(/\/+$/, '');
  return `${base}/admin#session=${encodeURIComponent(sessionId)}`;
}

function shortId(sessionId: string): string {
  return `${sessionId.substring(0, 16)}...`;
}

function ago(now: number, at: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 90 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}

const KIND_LABEL: Record<PageKind, string> = {
  risk: 'high risk score',
  vendor_cut: 'vendor filter ended a session',
  vendor_ceiling: 'vendor session ceiling',
};

function followUpLine(ctx: Pick<MessageContext, 'previousPage' | 'now'>): string | null {
  if (!ctx.previousPage) return null;
  return (
    `Follow-up for the same participant: you were paged ${ago(ctx.now, ctx.previousPage.at)} ` +
    `(${ctx.previousPage.kinds.map((k) => KIND_LABEL[k]).join(' + ')}). This is new or more serious.`
  );
}

function lines(...parts: Array<string | null | false>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');
}

/**
 * Where a high flag came from. The risk pipeline scores the participant's own
 * words. The model's escalate_to_human tool at high urgency flags at a fixed
 * score that stands for "the assistant asked for a human": nothing the
 * participant said was scored to produce it, and the page must not claim so.
 */
export type RiskFlagSource = 'participant_turn' | 'model_escalation';

/** High-risk page (risk pipeline or the model's escalate_to_human at high). */
export function buildRiskPageMessage(
  sessionId: string,
  riskScore: number,
  ctx: Pick<MessageContext, 'previousPage' | 'unpagedCut' | 'now'>,
  source: RiskFlagSource = 'participant_turn',
  subject: PageSubject = 'own',
  extra: { escalation?: PageEscalation | null; alsoSubject?: PageSubject | null } = {},
): string {
  const escalation = extra.escalation ?? null;
  const critical = riskScore >= CRITICAL_RISK_SCORE || escalation === 'attempt';
  const previous = ctx.previousPage;
  // "Escalated" and "up from n" compare like with like: a third party's 95
  // after the participant's own 75 is a different person, not an escalation.
  const sameSubject = !!previous && (previous.subject ?? 'own') === subject;
  const previousScore = sameSubject ? previous?.riskScore : null;
  const who = subject === 'third_party' ? ' (third party)' : subject === 'harm_to_others' ? ' (risk to others)' : '';
  return lines(
    `URGENT: AI-Therapist HIGH crisis flag${who}${critical && sameSubject ? ' (ESCALATED)' : ''}`,
    PAGE_SUBJECT_LABEL[subject],
    // What changed, in words: the numbers alone do not say "tonight" or "an
    // attempt is under way" (ai-therapist-353). Kept short, and before the
    // Why line: a carrier SMS is split into parts of 300 characters, and the
    // headline, who is at risk, what changed and the Why line must all be in
    // part 1 (pinned in crisisEscalationLadder.test.ts).
    escalation ? `${sameSubject ? 'WHAT CHANGED' : 'WHAT IT SAYS'}: ${ESCALATION_WORDS[escalation]}.` : null,
    // Own risk and someone else in the same message (handled as own risk).
    subject === 'own' && extra.alsoSubject === 'harm_to_others'
      ? 'ALSO: the same message describes thoughts of harming another person.'
      : subject === 'own' && extra.alsoSubject === 'third_party'
        ? "ALSO: the same message reports someone else's crisis."
        : null,
    // The earlier page was about someone else: say that this one is not.
    subject === 'own' && previous && !sameSubject && previous.kinds.includes('risk')
      ? "PARTICIPANT'S OWN RISK: the earlier page was about someone else; this one is about the participant."
      : null,
    `Why: RISK SCORE ${riskScore}/100 ` +
      (source === 'model_escalation'
        ? 'set by the ASSISTANT asking for a human (escalate tool). It is the fixed score for that request, ' +
          "not a score of the participant's words"
        : `from what the participant ${subject === 'third_party' ? 'reported about someone else' : 'said'}`) +
      // With a WHAT CHANGED line the comparison is already made in words, and
      // the room in SMS part 1 goes to that line.
      (critical && !escalation && typeof previousScore === 'number' && previousScore < riskScore
        ? `, up from ${previousScore} at the last page.`
        : '.'),
    `Session ${shortId(sessionId)}`,
    ctx.unpagedCut
      ? `Also: the voice vendor's content filter ended this participant's session ${ago(ctx.now, ctx.unpagedCut.at)}.`
      : null,
    followUpLine(ctx),
    adminLink(sessionId),
  );
}

/** The vendor's content filter ended a voice session. */
export function buildVendorCutMessage(
  sessionId: string,
  peak: IncidentPeak,
  ctx: Pick<MessageContext, 'previousPage' | 'now'>,
): string {
  const score = peak.riskScore === null ? '' : ` (${peak.riskScore}/100)`;
  if (peak.severity === 'high') {
    const subject = peak.subject ?? 'own';
    return lines(
      'URGENT: AI-Therapist voice session ENDED BY THE VENDOR FILTER during a HIGH crisis flag' +
        (subject === 'third_party' ? ' (third party)' : subject === 'harm_to_others' ? ' (risk to others)' : ''),
      `Why: VENDOR CUT, not a new risk score. The participant lost the assistant mid-conversation; ` +
        whoseRiskBeforeCut(peak, score),
      `Session ${shortId(sessionId)}. The app tries to reconnect them under a new session id; ` +
        'further cuts in the next 15 minutes are recorded, not paged.',
      followUpLine(ctx),
      'Review the transcript and consider reaching out.',
      adminLink(sessionId),
    );
  }
  return lines(
    'AI-Therapist: voice session ended by the vendor filter',
    peak.severity === 'medium'
      ? `Why: VENDOR CUT, NOT a high risk score. Risk before the cut was MEDIUM${score}, below the paging ` +
          "threshold. The filter often cuts the assistant's screening question, so the participant's answer " +
          'may be what was lost.'
      : 'Why: VENDOR CUT. The risk level for this session could NOT be read, so treat it as possibly serious.',
    `Session ${shortId(sessionId)}. The participant lost the assistant mid-conversation; the app tries to ` +
      'reconnect them under a new session id. You are paged again at once if their risk rises.',
    followUpLine(ctx),
    'Review the transcript and consider reaching out.',
    adminLink(sessionId),
  );
}

/**
 * Whose risk was high when the vendor cut the session. "Their risk before the
 * cut was HIGH" is false, and sends the on-call to the wrong problem, when the
 * high flag was about someone the participant was reporting on or might harm.
 */
function whoseRiskBeforeCut(peak: IncidentPeak, score: string): string {
  const own =
    peak.ownSeverity === 'high' || peak.ownSeverity === 'medium'
      ? `The participant's own assessed risk was ${peak.ownSeverity.toUpperCase()}.`
      : "No risk of the participant's own was flagged.";
  if (peak.subject === 'third_party') {
    return `the HIGH flag${score} was about SOMEONE ELSE the participant was reporting on (third party at risk), not the participant. ${own}`;
  }
  if (peak.subject === 'harm_to_others') {
    return `the HIGH flag${score} was about thoughts of HARMING ANOTHER PERSON (risk to others), not self-harm. ${own}`;
  }
  return `the participant's own risk before the cut was HIGH${score}.`;
}

/**
 * A cut that was not paged at the time, and the participant has been silent
 * since. `peak` is their risk as it stands NOW, not at the cut: the turn the
 * filter cut on can be scored a second or two after the cut, so "nothing was
 * flagged" may no longer be true three minutes later, and the text must not
 * say it then.
 */
export function buildVendorCutSilenceMessage(
  sessionId: string,
  silentForMs: number,
  ctx: Pick<MessageContext, 'previousPage' | 'now'>,
  peak: IncidentPeak = { severity: 'none', riskScore: null },
): string {
  const minutes = Math.max(1, Math.round(silentForMs / 60_000));
  const score = peak.riskScore === null ? '' : ` (${peak.riskScore}/100)`;
  if (peak.severity === 'high') {
    const subject = peak.subject ?? 'own';
    return lines(
      'URGENT: AI-Therapist voice session ENDED BY THE VENDOR FILTER at HIGH risk' +
        (subject === 'third_party' ? ' (third party)' : subject === 'harm_to_others' ? ' (risk to others)' : '') +
        ', and the participant has NOT come back',
      `Why: VENDOR CUT, then ${minutes} min of silence. ` +
        (subject === 'own'
          ? `Their risk is HIGH${score}; `
          : `${whoseRiskBeforeCut(peak, score).replace(/\.$/, '')}; `) +
        'they have not spoken in any session since the cut.',
      `Session ${shortId(sessionId)}`,
      followUpLine(ctx),
      'Review the transcript and reach out.',
      adminLink(sessionId),
    );
  }
  return lines(
    'AI-Therapist: voice session ended by the vendor filter, and the participant has NOT come back',
    peak.severity === 'medium'
      ? `Why: VENDOR CUT, then ${minutes} min of silence. NOT a high risk score: risk was MEDIUM${score}, ` +
          'but the filter can end a session before their last words reach us, so those may not have been assessed.'
      : peak.severity === 'unknown'
        ? `Why: VENDOR CUT, then ${minutes} min of silence. Their risk level could NOT be read, so treat it as ` +
          'possibly serious.'
        : `Why: VENDOR CUT, then ${minutes} min of silence. NOT a high risk score: nothing they said was flagged, ` +
          'but the filter can end a session before their last words reach us, so those may not have been assessed.',
    `Session ${shortId(sessionId)}`,
    followUpLine(ctx),
    'Review the transcript and consider reaching out.',
    adminLink(sessionId),
  );
}

/** The vendor's session ceiling ended a session during a high flag. */
export function buildVendorCeilingMessage(
  sessionId: string,
  ctx: Pick<MessageContext, 'previousPage' | 'now'>,
): string {
  return lines(
    'URGENT: AI-Therapist voice session hit the vendor session ceiling during a HIGH crisis flag',
    'Why: VENDOR SESSION LIMIT, not a new risk score. The app is reconnecting them automatically.',
    `Session ${shortId(sessionId)}`,
    followUpLine(ctx),
    'Review the transcript and consider reaching out.',
    adminLink(sessionId),
  );
}

// ---- the decision ----------------------------------------------------------

async function isSandboxSession(sessionId: string): Promise<boolean> {
  // Only an affirmative sandbox=true suppresses; a throwing lookup pages.
  try {
    const { sessionSuppressesCrisisPaging } = await import('./suppression.js');
    return (await withTimeout(sessionSuppressesCrisisPaging(sessionId), 'sandbox check')) === true;
  } catch (err) {
    log.error({ err }, '[paging] sandbox check failed; paging anyway (fail toward paging)');
    return false;
  }
}

/** The participant and their recent paging decisions. Never rejects: with no
 *  history nothing can absorb the page, so it is sent. */
async function readPagingHistory(sessionId: string): Promise<{ userId: number | null; rows: PagingRecordRow[] }> {
  try {
    return await withTimeout(
      (async () => {
        const userId = await getPagingParticipantUserId(sessionId);
        const rows = await getRecentPagingRecords(sessionId, userId, new Date(Date.now() - PAGE_FOLD_WINDOW_MS));
        return { userId, rows: rows ?? [] };
      })(),
      'paging history lookup',
    );
  } catch (err) {
    log.error(
      { err },
      `[paging] could not read paging history for ${sessionId.substring(0, 12)}...; paging without it`,
    );
    return { userId: null, rows: [] };
  }
}

async function record(
  sessionId: string,
  actionType: 'crisis_sms_alert' | 'external_api_called',
  details: Record<string, unknown>,
  riskScore: number | null,
): Promise<number | null> {
  try {
    return await insertPagingRecord(sessionId, actionType, details, riskScore);
  } catch (err) {
    log.error({ err }, `[paging] failed to record a paging decision for ${sessionId.substring(0, 12)}...`);
    return null;
  }
}

/** Live copy for the admin dashboards, so a decision NOT to send is seen. */
function notifyAdmins(request: PageRequest, decision: PageDecision, summary: string): void {
  try {
    if (!global.io) return;
    void broadcastAdminEventForSession(
      global.io,
      'session:page-decision',
      {
        sessionId: request.sessionId,
        outcome: decision.outcome,
        kind: request.kind,
        level: decision.level,
        riskScore: request.riskScore,
        foldedIntoSessionId: decision.foldedIntoSessionId ?? null,
        foldedIntoActionId: decision.foldedIntoActionId ?? null,
        message: summary,
        at: new Date(),
      },
      request.sessionId,
    ).catch((err: unknown) => log.error({ err }, '[paging] admin broadcast failed'));
  } catch (err) {
    log.error({ err }, '[paging] admin broadcast failed');
  }
}

/**
 * Apply the rules to one event and send, fold or record it. Never throws.
 */
async function dispatchPage(request: PageRequest): Promise<PageDecision> {
  const { sessionId, kind, level } = request;
  const short = sessionId.substring(0, 12);

  // The sandbox check and the paging history are independent reads, each
  // bounded by PAGING_LOOKUP_TIMEOUT_MS. Run together, a database that has
  // stopped answering holds a first page back for one timeout, not two.
  const [sandbox, history] = await Promise.all([isSandboxSession(sessionId), readPagingHistory(sessionId)]);

  if (sandbox) {
    log.info(`[paging] SMS suppressed for sandbox session ${short}...`);
    // Out of the critical path, as before: the row is best effort.
    void record(
      sessionId,
      'external_api_called',
      {
        suppressed: 'crisis_sms_alert',
        reason: 'sandbox',
        riskScore: request.riskScore,
        paging: { decision: 'sandbox', kind, level, kinds: [kind], delivered: false, summary: request.summary },
      },
      request.riskScore,
    );
    return { outcome: 'sandbox', kind, level, actionId: null };
  }

  const { userId, rows } = history;
  const key = participantKey(sessionId, userId);
  const stored = rows.map(priorPageFromRow).filter((p): p is PriorPage => p !== null);

  // From here to the ledger claim below nothing awaits unless a covering page
  // is still in flight, so two near-simultaneous events cannot both conclude
  // "nobody has been paged".
  for (;;) {
    const now = Date.now();
    const inFlightOrSent = ledgerEntries(key, now);
    const delivered: PriorPage[] = [...stored, ...inFlightOrSent.filter((e) => e.settled && e.delivered)];
    const cover = delivered.filter((p) => pageCovers(p, request, now)).sort((a, b) => b.at - a.at)[0];
    if (cover) return await fold(request, cover, now);

    const pending = inFlightOrSent.find((e) => !e.settled && pageCovers(e, request, now));
    if (pending) {
      // The page that would absorb this one has not been confirmed yet. Wait
      // for it (bounded by the pager's own 5 s timeout) and decide again: if
      // it failed, this event must go out itself.
      await pending.delivery.catch(() => false);
      continue;
    }

    return await send(request, key, delivered, rows, now);
  }
}

async function fold(request: PageRequest, cover: PriorPage, now: number): Promise<PageDecision> {
  const { sessionId, kind, level } = request;
  // A ledger page may not have its row yet; wait for the id so the fold can
  // point at it.
  const coverActionId = cover.actionId ?? (await (cover as Partial<LedgerEntry>).recorded?.catch(() => null)) ?? null;
  const ageSeconds = Math.round((now - cover.at) / 1000);
  const summary =
    `Not paged: ${request.summary} On-call was already paged ${ageSeconds} s earlier for this participant ` +
    `(session ${cover.sessionId.substring(0, 12)}..., ${cover.kinds.map((k) => KIND_LABEL[k]).join(' + ')}).`;
  log.warn(
    `[paging] page for ${sessionId.substring(0, 12)}... (${kind}, level ${level}) folded into the page sent ` +
      `${ageSeconds}s ago for the same participant (action ${coverActionId ?? 'unrecorded'})`,
  );
  const actionId = await record(
    sessionId,
    'external_api_called',
    {
      suppressed: 'crisis_sms_alert',
      reason: 'folded_into_recent_page',
      riskScore: request.riskScore,
      paging: {
        decision: 'folded',
        kind,
        level,
        kinds: [kind],
        delivered: false,
        riskScore: request.riskScore,
        ...subjectAndStage(request),
        foldedIntoActionId: coverActionId,
        foldedIntoSessionId: cover.sessionId,
        foldedIntoLevel: cover.level,
        secondsAfterPage: ageSeconds,
        windowSeconds: PAGE_FOLD_WINDOW_MS / 1000,
        ...request.facts,
        summary,
      },
    },
    request.riskScore,
  );
  const decision: PageDecision = {
    outcome: 'folded',
    kind,
    level,
    actionId,
    foldedIntoActionId: coverActionId,
    foldedIntoSessionId: cover.sessionId,
  };
  notifyAdmins(request, decision, summary);
  return decision;
}

async function send(
  request: PageRequest,
  key: string,
  delivered: PriorPage[],
  rows: PagingRecordRow[],
  now: number,
): Promise<PageDecision> {
  const { sessionId, kind, level } = request;
  const previousPage = [...delivered].sort((a, b) => b.at - a.at)[0] ?? null;

  // A vendor cut inside the window that produced no SMS (the cut can land
  // before the turn that caused it has been scored): say so on the risk page.
  // The page stays a 'risk' page. It reports a cut that already happened; if
  // the vendor then cuts the session the on-call has just been told is high
  // risk, that is new and pages.
  let unpagedCut: MessageContext['unpagedCut'] = null;
  if (kind === 'risk' && !delivered.some((p) => p.kinds.includes('vendor_cut'))) {
    const cutRow = rows.find((row) => {
      const paging = pagingPayload(row);
      return paging?.['kind'] === 'vendor_cut' && paging['delivered'] !== true;
    });
    if (cutRow) unpagedCut = { sessionId: cutRow.session_id, at: new Date(cutRow.performed_at).getTime() };
  }
  const kinds: PageKind[] = [kind];

  let message: string;
  try {
    message = request.buildMessage({ previousPage, unpagedCut, now });
  } catch (err) {
    log.error({ err }, '[paging] building the page text failed; sending a minimal page');
    message = `URGENT: AI-Therapist crisis alert (${KIND_LABEL[kind]})\nSession ${shortId(sessionId)}\n${adminLink(sessionId)}`;
  }

  // Claim before sending, in the same tick as the decision above.
  let resolveDelivery: (ok: boolean) => void = () => undefined;
  let resolveRecorded: (id: number | null) => void = () => undefined;
  const entry: LedgerEntry = {
    actionId: null,
    sessionId,
    at: now,
    level,
    kinds,
    riskScore: request.riskScore,
    subject: request.subject ?? 'own',
    stage: request.kind === 'risk' ? pageStage(request.escalation) : 0,
    settled: false,
    delivered: false,
    delivery: new Promise<boolean>((resolve) => (resolveDelivery = resolve)),
    recorded: new Promise<number | null>((resolve) => (resolveRecorded = resolve)),
  };
  ledger.set(key, [...(ledger.get(key) ?? []), entry]);

  // Every configured channel at once (iMessage bridge, AWS SMS). DELIVERED,
  // for the folding rule, means at least one channel accepted the page: the
  // on-call has it, so a repeat may be folded. A page no channel accepted
  // absorbs nothing, exactly as an undelivered page did with one channel.
  let ok = false;
  let channels: ChannelRecord[] = [];
  let skipped: string | null = null;
  try {
    const { sendCrisisAlertDetailed } = await import('./crisisAlert.service.js');
    const delivery = await sendCrisisAlertDetailed(message);
    ok = delivery?.delivered === true;
    skipped = delivery?.skipped ?? null;
    channels = (delivery?.channels ?? []).map((c) => ({
      channel: c.channel,
      ok: c.ok === true,
      error: c.error ?? null,
      messageIds: c.messageIds ?? [],
      parts: c.parts,
      partsAccepted: c.partsAccepted,
      ms: c.ms,
    }));
  } catch (err) {
    log.error({ err }, `[paging] page failed for ${sessionId.substring(0, 12)}...`);
  }
  const failed = channels.filter((c) => !c.ok);
  const channelNote =
    failed.length === 0
      ? ''
      : ok
        ? ` Delivered by ${channels
            .filter((c) => c.ok)
            .map((c) => c.channel)
            .join(' + ')}; FAILED on ${failed.map((c) => `${c.channel} (${c.error ?? 'error'})`).join(', ')}.`
        : ` Every paging channel failed: ${failed.map((c) => `${c.channel} (${c.error ?? 'error'})`).join(', ')}.`;
  entry.settled = true;
  entry.delivered = ok;
  // An undelivered page absorbs nothing: hand the claim back.
  if (!ok) dropLedgerEntry(key, entry);
  resolveDelivery(ok);

  // The row is written whether or not the SMS was delivered (as before this
  // policy: the harness and CI run with no pager); `delivered` says which.
  const actionId = await record(
    sessionId,
    'crisis_sms_alert',
    {
      riskScore: request.riskScore,
      paging: {
        decision: ok ? 'paged' : 'not_delivered',
        kind,
        level,
        kinds,
        delivered: ok,
        riskScore: request.riskScore,
        ...subjectAndStage(request),
        followsActionId: previousPage?.actionId ?? null,
        ...request.facts,
        // Per channel: attempted, accepted or not, provider message ids. No
        // phone number and no message text. Empty when nothing was attempted
        // (`channelsSkipped` says why: paging disabled, or not configured).
        channels,
        channelsSkipped: skipped,
        summary: `${ok ? 'Paged on-call' : 'Page attempted, not delivered'}: ${request.summary}${channelNote}`,
      },
    },
    request.riskScore,
  );
  entry.actionId = actionId;
  resolveRecorded(actionId);

  const decision: PageDecision = { outcome: ok ? 'paged' : 'not_delivered', kind, level, actionId };
  // A channel that failed is shown on the dashboards for every kind of page,
  // risk pages included: with all of them down nobody was texted, and with
  // one down the redundancy is gone. (A risk page that went out cleanly has
  // its own dashboard alert and needs no notice here.)
  if (kind !== 'risk' || failed.length > 0)
    notifyAdmins(request, decision, `${ok ? 'On-call paged' : 'Page NOT delivered'}: ${request.summary}${channelNote}`);
  return decision;
}

/** What a stored paging row records about whom and how far along. */
function subjectAndStage(request: PageRequest): Record<string, unknown> {
  const subject = request.subject ?? 'own';
  if (request.kind !== 'risk') return subject === 'own' ? {} : { subject };
  return {
    subject,
    stage: pageStage(request.escalation),
    ...(request.escalation ? { escalation: request.escalation } : {}),
  };
}

// ---- entry points ----------------------------------------------------------

/**
 * A session was flagged HIGH: by the risk pipeline from what the participant
 * said, by the pipeline for a participant's first real high turn in a
 * recovery session (facts.trigger = 'high_turn_in_recovery_session', see
 * crisisPipeline.service), or by the model's escalate_to_human at high
 * urgency (facts.source = 'model_escalation', which changes the wording: no
 * participant words were scored). Never throws.
 */
export async function pageHighRisk(
  sessionId: string,
  riskScore: number,
  /** `source`: who raised the flag (#70). `subject`: who the flag is about
   *  when it is not the participant's own risk ('third_party' |
   *  'harm_to_others'). `escalation`: what the turn says is happening
   *  ('plan_or_time' | 'attempt'). `alsoSubject`: the turn is handled as own
   *  risk and also concerned someone else. Other keys are free-form facts for
   *  the audit row. */
  facts: Record<string, unknown> & { source?: RiskFlagSource } = {},
): Promise<PageDecision> {
  const escalation = asEscalation(facts['escalation']);
  const level = riskPageLevel(riskScore, escalation);
  const source: RiskFlagSource = facts.source === 'model_escalation' ? 'model_escalation' : 'participant_turn';
  const subject = asPageSubject(facts['subject']);
  const alsoSubject = facts['alsoSubject'] === undefined ? null : asPageSubject(facts['alsoSubject']);
  const about =
    subject === 'third_party' ? ' (third party at risk)' : subject === 'harm_to_others' ? ' (risk to others)' : '';
  const extra = { escalation, alsoSubject };
  try {
    return await dispatchPage({
      sessionId,
      kind: 'risk',
      level,
      riskScore,
      subject,
      escalation,
      facts: { severity: 'high', ...facts, source },
      summary:
        source === 'model_escalation'
          ? `high risk flag raised by the assistant's escalate tool (fixed score ${riskScore}/100).`
          : `high risk flag${about}, score ${riskScore}/100` +
            (escalation ? `; ${ESCALATION_WORDS[escalation].toLowerCase()}.` : '.'),
      buildMessage: (ctx) => buildRiskPageMessage(sessionId, riskScore, ctx, source, subject, extra),
    });
  } catch (err) {
    // dispatchPage is written not to throw; if it does, the page still goes.
    log.error({ err }, '[paging] high-risk paging failed unexpectedly; sending directly');
    return await sendDirect(
      sessionId,
      'risk',
      level,
      buildRiskPageMessage(sessionId, riskScore, bareContext(), source, subject, extra),
    );
  }
}

function bareContext(): MessageContext {
  return { previousPage: null, unpagedCut: null, now: Date.now() };
}

async function sendDirect(sessionId: string, kind: PageKind, level: PageLevel, message: string): Promise<PageDecision> {
  let ok = false;
  try {
    const { sendCrisisAlert } = await import('./crisisAlert.service.js');
    ok = (await sendCrisisAlert(message)) === true;
  } catch (err) {
    log.error({ err }, `[paging] direct page failed for ${sessionId.substring(0, 12)}...`);
  }
  return { outcome: ok ? 'paged' : 'not_delivered', kind, level, actionId: null };
}

// ---- the silence check (ai-therapist-362) ----------------------------------
//
// A no-risk vendor cut writes a row that says the on-call is paged in 3
// minutes if the participant stays silent. That promise used to be a
// setTimeout in the process that saw the cut: a restart or a deploy inside
// the 3 minutes (stage deploys on every merge) dropped it, and the row went
// on saying a page was coming.
//
// Now the row itself owes the check (action_details.paging.silenceCheck,
// states in db/paging.queries). Three things can run it, and they all go
// through the same claim, so it runs once:
//   - the timer armed by the process that recorded the cut (the normal case,
//     exactly 3 minutes after the cut);
//   - sweepSilenceChecks at startup, which reads every unfinished check: one
//     that is already due runs at once, one that is not is given a timer for
//     the time it has left. A restart therefore changes nothing the on-call
//     can see;
//   - sweepSilenceChecks on the periodic backstop tick, for a check whose
//     process died without a successor, or died after claiming it.
// The claim is one conditional UPDATE, so of two app instances (blue-green
// deploy) exactly one runs a given check. If a check does run twice (the
// first instance was only slow, and its claim was taken as stale), the second
// page folds into the first when that was delivered, like any repeat.

type SilenceCheckResult =
  | { outcome: 'participant_spoke'; decision: null }
  | { outcome: PageOutcome; decision: PageDecision };

/**
 * Has the participant spoken since the cut? If so the risk pipeline is
 * assessing them again and nothing is sent. If not, or it cannot be
 * determined (lookup failure, anonymous session: a recovery session cannot
 * be traced back to it), the on-call is paged, subject to the same folding
 * as any other page. Throws only on an unexpected error.
 */
async function performSilenceCheck(sessionId: string, cutAt: number): Promise<SilenceCheckResult> {
  const short = sessionId.substring(0, 12);
  let spoke = false;
  try {
    spoke = await withTimeout(
      (async () => {
        const userId = await getPagingParticipantUserId(sessionId);
        return userId !== null && (await participantSpokeSince(userId, new Date(cutAt))) === true;
      })(),
      'silence check',
    );
  } catch (err) {
    log.error({ err }, `[paging] silence check lookup failed for ${short}...; paging (fail toward paging)`);
  }
  if (spoke) {
    log.info(`[paging] participant of ${short}... spoke again after the vendor cut; no page needed`);
    return { outcome: 'participant_spoke', decision: null };
  }
  const silentForMs = Math.max(0, Date.now() - cutAt);
  // Their risk as it stands now. There was no flag at the cut, but the turn
  // the filter cut on may have been scored since (the assessor answers a
  // second or two after the vendor closes the session).
  const peak = await resolveIncidentPeak(sessionId, { flagged: false, severity: null });
  const decision = await dispatchPage({
    sessionId,
    kind: 'vendor_cut',
    level: vendorCutLevel(peak.severity) ?? PAGE_LEVEL.mediumVendorCut,
    riskScore: peak.riskScore,
    subject: peak.subject ?? 'own',
    facts: {
      cause: 'content_filter',
      peakSeverity: peak.severity,
      trigger: 'participant_silent_after_cut',
      ...(peak.subject && peak.subject !== 'own' ? { ownSeverity: peak.ownSeverity ?? 'none' } : {}),
    },
    summary:
      'the vendor content filter ended this voice session and the participant has not spoken in any session ' +
      `for ${Math.round(silentForMs / 1000)} s since; ${peakWords(peak, 'now')}.`,
    buildMessage: (ctx) => buildVendorCutSilenceMessage(sessionId, silentForMs, ctx, peak),
  });
  return { outcome: decision.outcome, decision };
}

/**
 * The silence check itself, with no claim: used when the cut's row could not
 * be written (so there is nothing to claim), and directly by tests. Returns
 * null when nothing needed sending. Never throws.
 */
export async function runVendorCutSilenceCheck(sessionId: string, cutAt: number): Promise<PageDecision | null> {
  try {
    return (await performSilenceCheck(sessionId, cutAt)).decision;
  } catch (err) {
    log.error({ err }, `[paging] silence check failed for ${sessionId.substring(0, 12)}...`);
    return null;
  }
}

/**
 * Run the silence check a stored 'no_page' row owes: claim it, run it, record
 * how it ended. Never throws.
 *
 *   'not_claimed'  another instance has it, or it already finished: nothing
 *                  was done here.
 *   'ran'          the check ran here and its result is on the row. When
 *                  its page was NOT delivered (no channel accepted it) the
 *                  check is handed back as still owed, with the attempt
 *                  counted, and the next sweep tries again until
 *                  SILENCE_CHECK_CEILING_MS, when it expires loudly. A page
 *                  the on-call never got is not a check that is done.
 *   'failed'       it was claimed and then failed unexpectedly. The claim is
 *                  left in place, goes stale after
 *                  SILENCE_CHECK_STALE_CLAIM_MS, and the next sweep retries.
 *   'unclaimed'    the claim itself could not be made (database trouble).
 *                  With `fallback` (the caller knows the session and the cut
 *                  time) the check is run anyway, unrecorded: not being able
 *                  to write "I have it" is no reason to stay silent. Without
 *                  it nothing ran; the sweep will come round again.
 */
export async function runStoredSilenceCheck(
  actionId: number,
  fallback?: { sessionId: string; cutAt: number },
): Promise<'not_claimed' | 'ran' | 'failed' | 'unclaimed'> {
  let claim: Awaited<ReturnType<typeof claimSilenceCheck>>;
  try {
    claim = await withTimeout(
      claimSilenceCheck(actionId, INSTANCE_ID, SILENCE_CHECK_STALE_CLAIM_MS / 1000),
      'silence check claim',
    );
  } catch (err) {
    log.error(
      { err },
      `[paging] could not claim silence check ${actionId}` +
        (fallback ? '; running it unclaimed (fail toward paging)' : '; left for the next sweep'),
    );
    if (fallback) await runVendorCutSilenceCheck(fallback.sessionId, fallback.cutAt);
    return 'unclaimed';
  }
  if (!claim) return 'not_claimed';

  let result: SilenceCheckResult;
  try {
    result = await performSilenceCheck(claim.sessionId, claim.cutAt.getTime());
  } catch (err) {
    log.error(
      { err },
      `[paging] silence check ${actionId} failed for ${claim.sessionId.substring(0, 12)}...; ` +
        'its claim will go stale and the check will be retried',
    );
    return 'failed';
  }
  // Not delivered: the on-call has not been told. Keep the check owed so the
  // next sweep retries it (a harness or demo session is never swept, so there
  // it is recorded as done, as before).
  if (result.outcome === 'not_delivered' && !claim.isDemo) {
    const attempts = claim.attempts + 1;
    log.error(
      `[paging] ON-CALL PAGE NOT DELIVERED for the silence check ${actionId} ` +
        `(${claim.sessionId.substring(0, 12)}..., attempt ${attempts}); still owed, retried on the next sweep`,
    );
    try {
      await releaseSilenceCheck(actionId, {
        attempts,
        lastOutcome: result.outcome,
        lastPageActionId: result.decision?.actionId ?? null,
        lastAttemptBy: INSTANCE_ID,
      });
    } catch (err) {
      // The claim stays 'running', goes stale, and is retried all the same.
      log.error({ err }, `[paging] silence check ${actionId}: could not hand back the undelivered check`);
    }
    return 'ran';
  }
  try {
    await finishSilenceCheck(actionId, 'done', {
      outcome: result.outcome,
      pageActionId: result.decision?.actionId ?? null,
      foldedIntoActionId: result.decision?.foldedIntoActionId ?? null,
      ranBy: INSTANCE_ID,
    });
  } catch (err) {
    // The check ran; only the note that it did is missing. A later sweep will
    // run it again, and the page then folds into this one if it was delivered.
    log.error({ err }, `[paging] silence check ${actionId} ran but could not be marked done`);
  }
  return 'ran';
}

/** Arm one in-process timer for a silence check. A second call for the same
 *  check is a no-op. Never keeps the process alive. */
function armSilenceCheck(key: number | string, delayMs: number, run: () => Promise<unknown>): void {
  if (silenceTimers.has(key)) return;
  const timer = setTimeout(
    () => {
      silenceTimers.delete(key);
      run().catch((err: unknown) => log.error({ err }, `[paging] silence check ${key} failed`));
    },
    Math.max(0, delayMs),
  );
  timer.unref?.();
  silenceTimers.set(key, timer);
}

/** Called when a no-risk cut has just been recorded (actionId null when the
 *  row could not be written: the check then lives in this process only). */
function scheduleSilenceCheck(sessionId: string, cutAt: number, actionId: number | null): void {
  if (actionId === null) {
    armSilenceCheck(`unrecorded:${sessionId}:${cutAt}`, VENDOR_CUT_SILENCE_CHECK_MS, () =>
      runVendorCutSilenceCheck(sessionId, cutAt),
    );
    return;
  }
  armSilenceCheck(actionId, VENDOR_CUT_SILENCE_CHECK_MS, () => runStoredSilenceCheck(actionId, { sessionId, cutAt }));
}

/**
 * Bring every unfinished silence check in the database up to date. Run at
 * startup and on the periodic safety backstop tick (messageSafety.service
 * startMessageScanSweeper); safe to run from any number of instances. For
 * each 'no_page' row whose check has not finished:
 *   - due, and younger than SILENCE_CHECK_CEILING_MS: run it now;
 *   - not yet due: arm a timer for the time it has left;
 *   - older than the ceiling: mark it expired, log an error and tell the
 *     admin dashboards. No SMS: see SILENCE_CHECK_CEILING_MS. A check whose
 *     page was attempted and never delivered expires the same way, and the
 *     notice says the on-call has NOT been told.
 * Never throws.
 */
export async function sweepSilenceChecks(): Promise<{ ran: number; armed: number; expired: number }> {
  const done = { ran: 0, armed: 0, expired: 0 };
  let rows: Awaited<ReturnType<typeof getUnfinishedSilenceChecks>>;
  try {
    rows = await getUnfinishedSilenceChecks(
      SILENCE_CHECK_EXPIRY_LOOKBACK_MS / 1000,
      SILENCE_CHECK_STALE_CLAIM_MS / 1000,
    );
  } catch (err) {
    log.error({ err }, '[paging] could not read unfinished silence checks; will retry on the next sweep');
    return done;
  }
  for (const row of rows) {
    try {
      const short = row.session_id.substring(0, 12);
      const fallback = { sessionId: row.session_id, cutAt: Date.now() - row.age_ms };
      if (row.age_ms > SILENCE_CHECK_CEILING_MS) {
        const minutes = Math.round(row.age_ms / 60_000);
        const undelivered = row.attempts > 0;
        const summary = undelivered
          ? `Silence check page NOT DELIVERED: the vendor content filter ended this voice session ${minutes} min ` +
            'ago with no participant risk signal, the participant stayed silent, and the page was attempted ' +
            `${row.attempts} time(s) without any paging channel accepting it. On-call has NOT been told. ` +
            'Contact the on-call and review the transcript now.'
          : `Silence check NOT run: the vendor content filter ended this voice session ${minutes} min ago with no ` +
            `participant risk signal, and the check owed ${VENDOR_CUT_SILENCE_CHECK_MS / 60_000} min later was not ` +
            `run within ${SILENCE_CHECK_CEILING_MS / 60_000} min (the server was down or restarting). On-call was ` +
            'not paged for it. Review the transcript.';
        const marked = await finishSilenceCheck(row.action_id, 'expired', {
          outcome: undelivered ? 'not_delivered' : 'not_run',
          reason: undelivered ? 'undelivered_until_ceiling' : 'older_than_ceiling',
          ageSeconds: Math.round(row.age_ms / 1000),
          summary,
        });
        if (marked) {
          done.expired++;
          log.error(
            `[paging] silence check ${row.action_id} for ${short}... expired after ${minutes} min ` +
              (undelivered ? `(${row.attempts} undelivered attempt(s))` : 'unrun'),
          );
          notifyAdmins(
            {
              sessionId: row.session_id,
              kind: 'vendor_cut',
              level: PAGE_LEVEL.mediumVendorCut,
              riskScore: null,
              facts: {},
              summary,
              buildMessage: () => '',
            },
            {
              outcome: undelivered ? 'not_delivered' : 'no_page',
              kind: 'vendor_cut',
              level: null,
              actionId: row.action_id,
            },
            summary,
          );
        }
      } else if (row.age_ms >= VENDOR_CUT_SILENCE_CHECK_MS) {
        // Whatever timer this process had for it is superseded.
        const timer = silenceTimers.get(row.action_id);
        if (timer) {
          clearTimeout(timer);
          silenceTimers.delete(row.action_id);
        }
        if ((await runStoredSilenceCheck(row.action_id)) === 'ran') done.ran++;
      } else if (!silenceTimers.has(row.action_id)) {
        armSilenceCheck(row.action_id, VENDOR_CUT_SILENCE_CHECK_MS - row.age_ms, () =>
          runStoredSilenceCheck(row.action_id, fallback),
        );
        done.armed++;
      }
    } catch (err) {
      log.error({ err }, `[paging] sweep could not handle silence check ${row.action_id}`);
    }
  }
  if (done.ran + done.armed + done.expired > 0) {
    log.warn(`[paging] silence-check sweep: ${done.ran} run, ${done.armed} re-armed, ${done.expired} expired unrun`);
  }
  return done;
}

const SEVERITY_ORDER: Record<string, number> = { none: 0, low: 0, medium: 1, high: 2 };

/** "participant risk before the cut: high (90/100)", or whose risk it was. */
function peakWords(peak: IncidentPeak, when: string): string {
  const score = peak.riskScore === null ? '' : ` (${peak.riskScore}/100)`;
  if (peak.subject === 'third_party' || peak.subject === 'harm_to_others') {
    return (
      `risk ${when}: ${peak.severity}${score}, about ` +
      (peak.subject === 'third_party' ? 'a third party the participant was reporting on' : 'harm to another person') +
      `; the participant's own risk: ${peak.ownSeverity ?? 'none'}`
    );
  }
  return `participant risk ${when}: ${peak.severity}${score}`;
}

/**
 * The participant's peak risk in this incident: the highest crisis flag
 * (including a member of staff raising the session's risk by hand), or the
 * highest score the assessor gave one of their turns, not counting the
 * automatic "recovery continuation" stamp. The incident is:
 *   - this session and the recovery chain behind it, however long that has
 *     been running (getIncidentChainSessionIds), and
 *   - any other session of the same participant in the last
 *     INCIDENT_LOOKBACK_MS, the time bound that remains as the backstop for
 *     sessions no chain links (a typed-chat fallback, a fresh session).
 * The assessed scores are read as well as the flags because a turn can score
 * high without a flag event (getParticipantAssessedRisk in db/paging.queries).
 * `sessionRow` is the caller's own read of the session row, used only where
 * the events cannot answer:
 *   - an anonymous session has no participant to follow back through a
 *     recovery chain, so its own flag (continuation stamp included) stands;
 *   - when the events cannot be read at all, a flagged row is believed and an
 *     unflagged one is 'unknown' (the row read may have failed too).
 */
export async function resolveIncidentPeak(
  sessionId: string,
  sessionRow: { flagged: boolean; severity: string | null },
): Promise<IncidentPeak> {
  const rowSeverity: PeakSeverity = !sessionRow.flagged
    ? 'none'
    : sessionRow.severity === 'high'
      ? 'high'
      : sessionRow.severity === 'medium'
        ? 'medium'
        : 'none';
  try {
    const { userId, events } = await withTimeout(
      (async () => {
        const now = Date.now();
        const [id, chain] = await Promise.all([
          getPagingParticipantUserId(sessionId),
          getIncidentChainSessionIds(sessionId, new Date(now - INCIDENT_CHAIN_BACKSTOP_MS)),
        ]);
        const sessionIds = chain && chain.length > 0 ? chain : [sessionId];
        const since = new Date(now - INCIDENT_LOOKBACK_MS);
        const [flags, assessed] = await Promise.all([
          getParticipantFlagEvents(sessionIds, id, since),
          getParticipantAssessedRisk(sessionIds, id, since),
        ]);
        return { userId: id, events: [...(flags ?? []), ...(assessed ?? [])] };
      })(),
      'incident risk lookup',
    );
    // Peak per person the risk concerned. The participant's own risk decides
    // when it is at least as high as anyone else's: a page must never read
    // "about someone else" while the participant is at the same level.
    const peaks = new Map<PageSubject, { severity: PeakSeverity; riskScore: number | null }>();
    for (const event of events) {
      const rank = SEVERITY_ORDER[event.severity ?? 'none'] ?? 0;
      if (rank === 0) continue;
      const who = asPageSubject(event.subject);
      const best = peaks.get(who) ?? { severity: 'none' as PeakSeverity, riskScore: null };
      if (rank > SEVERITY_ORDER[best.severity]) {
        peaks.set(who, { severity: rank === 2 ? 'high' : 'medium', riskScore: event.risk_score ?? null });
      } else if (rank === SEVERITY_ORDER[best.severity] && (event.risk_score ?? -1) > (best.riskScore ?? -1)) {
        peaks.set(who, { severity: best.severity, riskScore: event.risk_score ?? null });
      }
    }
    const own = peaks.get('own') ?? { severity: 'none' as PeakSeverity, riskScore: null };
    let subject: PageSubject = 'own';
    let top = own;
    for (const who of ['third_party', 'harm_to_others'] as const) {
      const other = peaks.get(who);
      if (other && SEVERITY_ORDER[other.severity] > SEVERITY_ORDER[top.severity]) {
        top = other;
        subject = who;
      }
    }
    if (userId === null && SEVERITY_ORDER[rowSeverity] > SEVERITY_ORDER[top.severity]) {
      return { severity: rowSeverity, riskScore: null };
    }
    return subject === 'own'
      ? { severity: top.severity, riskScore: top.riskScore }
      : { severity: top.severity, riskScore: top.riskScore, subject, ownSeverity: own.severity };
  } catch (err) {
    log.error({ err }, `[paging] could not read the incident's risk for ${sessionId.substring(0, 12)}...`);
    return { severity: rowSeverity === 'none' ? 'unknown' : rowSeverity, riskScore: null };
  }
}

/**
 * The voice vendor ended a session: its content filter ('content_filter') or
 * its session ceiling during a high flag ('expired'; the caller only reports
 * that case). `flagged` / `severity` are the caller's read of the session row.
 * Never throws.
 *
 * Content filter, by the participant's peak risk in the incident:
 *   high    one SMS per incident. A second cut (each recovery attempt is a new
 *           session) inside the window is folded and recorded.
 *   medium  one SMS per incident, at the lowest level, worded as "vendor cut,
 *           NOT a high risk score". Chosen over a dashboard-only record
 *           because at medium the assistant is typically mid-screening (the
 *           filter cuts the "are you having thoughts of ending your life"
 *           question itself), so the participant's answer is exactly what the
 *           cut removed, and whether the recovery session reaches them is not
 *           guaranteed. The cost of being wrong the other way is one text. A
 *           later high flag is a higher level and still pages at once.
 *   none    no SMS at the cut: a record for review and a live admin
 *           notification, then runVendorCutSilenceCheck 3 minutes later.
 */
export async function pageVendorTermination(input: {
  sessionId: string;
  cause: 'content_filter' | 'expired';
  flagged: boolean;
  severity: string | null;
}): Promise<PageDecision> {
  const { sessionId, cause } = input;
  try {
    if (cause === 'expired') {
      return await dispatchPage({
        sessionId,
        kind: 'vendor_ceiling',
        level: PAGE_LEVEL.high,
        riskScore: null,
        facts: { cause, peakSeverity: 'high' },
        summary: 'the voice session hit the vendor session ceiling during a high crisis flag.',
        buildMessage: (ctx) => buildVendorCeilingMessage(sessionId, ctx),
      });
    }

    const peak = await resolveIncidentPeak(sessionId, { flagged: input.flagged, severity: input.severity });
    const level = vendorCutLevel(peak.severity);
    if (level === null) {
      const summary =
        'Not paged: the vendor content filter ended this voice session, and the participant has no medium or ' +
        `high risk flag in this incident. On-call is paged in ${VENDOR_CUT_SILENCE_CHECK_MS / 60_000} min if the ` +
        'participant has not spoken again by then. Review the transcript.';
      const request: PageRequest = {
        sessionId,
        kind: 'vendor_cut',
        level: PAGE_LEVEL.mediumVendorCut,
        riskScore: null,
        facts: {},
        summary,
        buildMessage: () => '',
      };
      const actionId = await record(
        sessionId,
        'external_api_called',
        {
          suppressed: 'crisis_sms_alert',
          reason: 'vendor_cut_without_participant_risk',
          paging: {
            decision: 'no_page',
            kind: 'vendor_cut',
            level: null,
            kinds: ['vendor_cut'],
            delivered: false,
            cause,
            peakSeverity: peak.severity,
            silenceCheckSeconds: VENDOR_CUT_SILENCE_CHECK_MS / 1000,
            // The check is owed by this row from here on (ai-therapist-362).
            silenceCheck: { state: 'pending' },
            summary,
          },
        },
        null,
      );
      scheduleSilenceCheck(sessionId, Date.now(), actionId);
      log.warn(
        `[paging] vendor filter ended ${sessionId.substring(0, 12)}... with no participant risk signal: ` +
          'recorded for review, on-call not paged',
      );
      const decision: PageDecision = { outcome: 'no_page', kind: 'vendor_cut', level: null, actionId };
      notifyAdmins(request, decision, summary);
      return decision;
    }

    return await dispatchPage({
      sessionId,
      kind: 'vendor_cut',
      level,
      riskScore: peak.riskScore,
      subject: peak.subject ?? 'own',
      facts: {
        cause,
        peakSeverity: peak.severity,
        ...(peak.subject && peak.subject !== 'own' ? { ownSeverity: peak.ownSeverity ?? 'none' } : {}),
      },
      summary: `the vendor content filter ended this voice session; ${peakWords(peak, 'before the cut')}.`,
      buildMessage: (ctx) => buildVendorCutMessage(sessionId, peak, ctx),
    });
  } catch (err) {
    log.error({ err }, '[paging] vendor-termination paging failed unexpectedly; sending directly');
    return await sendDirect(
      sessionId,
      cause === 'expired' ? 'vendor_ceiling' : 'vendor_cut',
      PAGE_LEVEL.mediumVendorCut,
      cause === 'expired'
        ? buildVendorCeilingMessage(sessionId, bareContext())
        : buildVendorCutMessage(sessionId, { severity: 'unknown', riskScore: null }, bareContext()),
    );
  }
}
