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
import {
  getPagingParticipantUserId,
  getRecentPagingRecords,
  getParticipantFlagEvents,
  getParticipantAssessedRisk,
  highFlagIsContinuationStampOnly,
  participantSpokeSince,
  insertPagingRecord,
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
 * How far back another session's crisis flag still counts as "this incident"
 * when a vendor termination has to be classified. Long on purpose: a recovery
 * session can run to the vendor ceiling without a new flag of its own, and
 * the error this guards against is calling a continuing crisis "no risk".
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
 * After a content-filter cut that was not paged (no risk signal), how long
 * the participant has to say something, in any session, before the on-call is
 * paged after all. In the 2026-11-18 stage test the participant spoke 12 s
 * into the recovery session; 3 minutes leaves room for two voice reconnection
 * attempts and the typed-chat fallback.
 */
export const VENDOR_CUT_SILENCE_CHECK_MS = 3 * 60 * 1000;

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

/** A page this participant's on-call has (or is about to have) received. */
interface PriorPage {
  actionId: number | null;
  sessionId: string;
  at: number;
  level: PageLevel;
  kinds: PageKind[];
  riskScore: number | null;
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

const silenceTimers = new Set<ReturnType<typeof setTimeout>>();

/** Test hook. */
export function _resetPagingStateForTests(): void {
  ledger.clear();
  for (const timer of silenceTimers) clearTimeout(timer);
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
  prior: Pick<PriorPage, 'at' | 'level' | 'kinds'>,
  request: { kind: PageKind; level: PageLevel },
  now: number,
): boolean {
  const age = now - prior.at;
  if (age < 0 || age >= PAGE_FOLD_WINDOW_MS) return false;
  if (prior.level < request.level) return false;
  return request.kind === 'risk' || prior.kinds.includes(request.kind);
}

/** Page level of a high-severity risk flag. */
export function riskPageLevel(riskScore: number): PageLevel {
  return riskScore >= CRITICAL_RISK_SCORE ? PAGE_LEVEL.critical : PAGE_LEVEL.high;
}

export type PeakSeverity = 'none' | 'medium' | 'high' | 'unknown';

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

/** High-risk page (risk pipeline or the model's escalate_to_human at high). */
export function buildRiskPageMessage(
  sessionId: string,
  riskScore: number,
  ctx: Pick<MessageContext, 'previousPage' | 'unpagedCut' | 'now'>,
): string {
  const critical = riskScore >= CRITICAL_RISK_SCORE;
  const previousScore = ctx.previousPage?.riskScore;
  return lines(
    `URGENT: AI-Therapist HIGH crisis flag${critical && ctx.previousPage ? ' (ESCALATED)' : ''}`,
    `Why: RISK SCORE ${riskScore}/100 from what the participant said` +
      (critical && typeof previousScore === 'number' && previousScore < riskScore
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
  peak: { severity: PeakSeverity; riskScore: number | null },
  ctx: Pick<MessageContext, 'previousPage' | 'now'>,
): string {
  const score = peak.riskScore === null ? '' : ` (${peak.riskScore}/100)`;
  if (peak.severity === 'high') {
    return lines(
      'URGENT: AI-Therapist voice session ENDED BY THE VENDOR FILTER during a HIGH crisis flag',
      `Why: VENDOR CUT, not a new risk score. The participant lost the assistant mid-conversation; ` +
        `their risk before the cut was HIGH${score}.`,
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
      ? `Why: VENDOR CUT, NOT a high risk score. Risk before the cut was MEDIUM${score}, below the paging threshold.`
      : 'Why: VENDOR CUT. The risk level for this session could NOT be read, so treat it as possibly serious.',
    `Session ${shortId(sessionId)}. The participant lost the assistant mid-conversation; the app tries to ` +
      'reconnect them under a new session id. You are paged again at once if their risk rises.',
    followUpLine(ctx),
    'Review the transcript.',
    adminLink(sessionId),
  );
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
  peak: { severity: PeakSeverity; riskScore: number | null } = { severity: 'none', riskScore: null },
): string {
  const minutes = Math.max(1, Math.round(silentForMs / 60_000));
  const score = peak.riskScore === null ? '' : ` (${peak.riskScore}/100)`;
  if (peak.severity === 'high') {
    return lines(
      'URGENT: AI-Therapist voice session ENDED BY THE VENDOR FILTER at HIGH risk, and the participant has NOT come back',
      `Why: VENDOR CUT, then ${minutes} min of silence. Their risk is HIGH${score}; they have not spoken in any ` +
        'session since the cut.',
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

  if (await isSandboxSession(sessionId)) {
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

  let userId: number | null = null;
  let rows: PagingRecordRow[] = [];
  try {
    const history = await withTimeout(
      (async () => {
        const id = await getPagingParticipantUserId(sessionId);
        const found = await getRecentPagingRecords(sessionId, id, new Date(Date.now() - PAGE_FOLD_WINDOW_MS));
        return { id, found: found ?? [] };
      })(),
      'paging history lookup',
    );
    userId = history.id;
    rows = history.found;
  } catch (err) {
    // No history means nothing can absorb this page: it is sent.
    log.error({ err }, `[paging] could not read paging history for ${short}...; paging without it`);
    rows = [];
  }
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
    settled: false,
    delivered: false,
    delivery: new Promise<boolean>((resolve) => (resolveDelivery = resolve)),
    recorded: new Promise<number | null>((resolve) => (resolveRecorded = resolve)),
  };
  ledger.set(key, [...(ledger.get(key) ?? []), entry]);

  let ok = false;
  try {
    const { sendCrisisAlert } = await import('./crisisAlert.service.js');
    ok = (await sendCrisisAlert(message)) === true;
  } catch (err) {
    log.error({ err }, `[paging] page failed for ${sessionId.substring(0, 12)}...`);
  }
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
        followsActionId: previousPage?.actionId ?? null,
        ...request.facts,
        summary: `${ok ? 'Paged on-call' : 'Page attempted, not delivered'}: ${request.summary}`,
      },
    },
    request.riskScore,
  );
  entry.actionId = actionId;
  resolveRecorded(actionId);

  const decision: PageDecision = { outcome: ok ? 'paged' : 'not_delivered', kind, level, actionId };
  if (kind !== 'risk')
    notifyAdmins(request, decision, `${ok ? 'On-call paged' : 'Page not delivered'}: ${request.summary}`);
  return decision;
}

// ---- entry points ----------------------------------------------------------

/**
 * A session was flagged HIGH (risk pipeline, or the model's escalate_to_human
 * at high urgency). Never throws.
 */
export async function pageHighRisk(
  sessionId: string,
  riskScore: number,
  facts: Record<string, unknown> = {},
): Promise<PageDecision> {
  const level = riskPageLevel(riskScore);
  try {
    return await dispatchPage({
      sessionId,
      kind: 'risk',
      level,
      riskScore,
      facts: { severity: 'high', ...facts },
      summary: `high risk flag, score ${riskScore}/100.`,
      buildMessage: (ctx) => buildRiskPageMessage(sessionId, riskScore, ctx),
    });
  } catch (err) {
    // dispatchPage is written not to throw; if it does, the page still goes.
    log.error({ err }, '[paging] high-risk paging failed unexpectedly; sending directly');
    return await sendDirect(sessionId, 'risk', level, buildRiskPageMessage(sessionId, riskScore, bareContext()));
  }
}

/**
 * A turn scored HIGH in a session that is already flagged high, and the
 * pipeline's re-flag rule did not fire (same severity, score not more than 10
 * above the stored one), so no flag and no page were produced for it.
 *
 * That is right when the stored flag came from the participant: the on-call
 * was paged for it. It is wrong in a recovery session. There the flag is the
 * automatic continuation stamp, written at the inherited score or at 100 when
 * the session it continues was never flagged, so a real disclosure can never
 * exceed it by 10 and would reach nobody: the cut that started the recovery
 * is no longer an SMS when the participant had no risk flag, and they "came
 * back", so the silence check stays quiet too.
 *
 * So: when the session's only high flag is that stamp, this turn is the first
 * the on-call would hear of the participant's risk, and a page is requested,
 * under the same folding as any other. A lookup that fails or is slow pages.
 * Returns null when the session has a real high flag. Never throws.
 */
export async function pageHighTurnWithoutReflag(sessionId: string, riskScore: number): Promise<PageDecision | null> {
  let stampOnly = true;
  try {
    stampOnly = (await withTimeout(highFlagIsContinuationStampOnly(sessionId), 'continuation stamp check')) !== false;
  } catch (err) {
    log.error(
      { err },
      `[paging] could not tell whether ${sessionId.substring(0, 12)}... is flagged only by the recovery stamp; ` +
        'paging (fail toward paging)',
    );
  }
  if (!stampOnly) return null;
  return await pageHighRisk(sessionId, riskScore, { trigger: 'high_turn_in_recovery_session' });
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

function scheduleSilenceCheck(sessionId: string, cutAt: number): void {
  const timer = setTimeout(() => {
    silenceTimers.delete(timer);
    void runVendorCutSilenceCheck(sessionId, cutAt);
  }, VENDOR_CUT_SILENCE_CHECK_MS);
  // In-process and best effort: a restart inside the 3 minutes loses the
  // check (the cut itself is already on record). Never keeps the process up.
  timer.unref?.();
  silenceTimers.add(timer);
}

/**
 * The follow-up to a vendor cut that was not paged. If the participant has
 * spoken since (any session), the risk pipeline is assessing them again and
 * nothing is sent. If they have not, or it cannot be determined (lookup
 * failure, anonymous session: a recovery session cannot be traced back to
 * it), the on-call is paged, subject to the same folding as any other page.
 * Returns null when nothing needed sending. Never throws. Exported for tests.
 */
export async function runVendorCutSilenceCheck(sessionId: string, cutAt: number): Promise<PageDecision | null> {
  const short = sessionId.substring(0, 12);
  try {
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
      return null;
    }
    const silentForMs = Date.now() - cutAt;
    // Their risk as it stands now. There was no flag at the cut, but the turn
    // the filter cut on may have been scored since (the assessor answers a
    // second or two after the vendor closes the session).
    const peak = await resolveIncidentPeak(sessionId, { flagged: false, severity: null });
    return await dispatchPage({
      sessionId,
      kind: 'vendor_cut',
      level: vendorCutLevel(peak.severity) ?? PAGE_LEVEL.mediumVendorCut,
      riskScore: peak.riskScore,
      facts: { cause: 'content_filter', peakSeverity: peak.severity, trigger: 'participant_silent_after_cut' },
      summary:
        'the vendor content filter ended this voice session and the participant has not spoken in any session ' +
        `for ${Math.round(silentForMs / 1000)} s since; participant risk now: ${peak.severity}` +
        `${peak.riskScore === null ? '' : ` (${peak.riskScore}/100)`}.`,
      buildMessage: (ctx) => buildVendorCutSilenceMessage(sessionId, silentForMs, ctx, peak),
    });
  } catch (err) {
    log.error({ err }, `[paging] silence check failed for ${short}...`);
    return null;
  }
}

const SEVERITY_ORDER: Record<string, number> = { none: 0, low: 0, medium: 1, high: 2 };

/**
 * The participant's peak risk in this incident: the highest crisis flag, or
 * the highest score the assessor gave one of their turns, on this session or
 * on any session of the same participant in the last INCIDENT_LOOKBACK_MS,
 * not counting the automatic "recovery continuation" stamp. The assessed
 * scores are read as well as the flags because a recovery session, being
 * stamped high already, does not get a flag event for a real disclosure (see
 * getParticipantAssessedRisk in db/paging.queries). `sessionRow` is the caller's own read of the session row, used only
 * where the events cannot answer:
 *   - an anonymous session has no participant to follow back through a
 *     recovery chain, so its own flag (continuation stamp included) stands;
 *   - when the events cannot be read at all, a flagged row is believed and an
 *     unflagged one is 'unknown' (the row read may have failed too).
 */
export async function resolveIncidentPeak(
  sessionId: string,
  sessionRow: { flagged: boolean; severity: string | null },
): Promise<{ severity: PeakSeverity; riskScore: number | null }> {
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
        const id = await getPagingParticipantUserId(sessionId);
        const since = new Date(Date.now() - INCIDENT_LOOKBACK_MS);
        const [flags, assessed] = await Promise.all([
          getParticipantFlagEvents(sessionId, id, since),
          getParticipantAssessedRisk(sessionId, id, since),
        ]);
        return { userId: id, events: [...(flags ?? []), ...(assessed ?? [])] };
      })(),
      'incident risk lookup',
    );
    let severity: PeakSeverity = 'none';
    let riskScore: number | null = null;
    for (const event of events) {
      const rank = SEVERITY_ORDER[event.severity ?? 'none'] ?? 0;
      if (rank === 0) continue;
      if (rank > SEVERITY_ORDER[severity]) {
        severity = rank === 2 ? 'high' : 'medium';
        riskScore = event.risk_score ?? null;
      } else if (rank === SEVERITY_ORDER[severity] && (event.risk_score ?? -1) > (riskScore ?? -1)) {
        riskScore = event.risk_score ?? null;
      }
    }
    if (userId === null && SEVERITY_ORDER[rowSeverity] > SEVERITY_ORDER[severity]) {
      return { severity: rowSeverity, riskScore: null };
    }
    return { severity, riskScore };
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
            summary,
          },
        },
        null,
      );
      scheduleSilenceCheck(sessionId, Date.now());
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
      facts: { cause, peakSeverity: peak.severity },
      summary:
        `the vendor content filter ended this voice session; participant risk before the cut: ${peak.severity}` +
        `${peak.riskScore === null ? '' : ` (${peak.riskScore}/100)`}.`,
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
