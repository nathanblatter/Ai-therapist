// Shared per-turn crisis pipeline (ai-therapist-105). The orchestration that
// used to be inlined in logs.routes.ts::processInsertedMessages now lives here
// so BOTH the realtime batch endpoint (/logs/batch) and the chat endpoint
// (/api/chat/message) run identical detection / flagging / paging / AE logic.
//
// The `channel` argument controls ONLY steering DELIVERY:
//   - realtime: steering is injected over the sideband (maybeSteerSession),
//     which already happened by the time this returns, so realtime callers
//     ignore `steeringGuidance` (it stays null).
//   - chat: there is no sideband, so the guidance string is returned and the
//     chat route injects it into the very model call that answers this turn
//     (same-turn steering — strictly better than realtime, where guidance
//     lands mid/next turn).
//
// Everything else — risk_score_history writes, crisis flagging, paging via
// sendCrisisAlert, session:crisis-emergency, and the AE auto-draft — is
// channel-agnostic and reuses the existing functions untouched.
import { analyzeMessageRisk, flagSessionCrisis, logInterventionAction } from './crisisDetection.service.js';
import {
  maybeSteerSession,
  maybeRequireRiskCheck,
  shouldSteer,
  buildChatSteeringGuidance,
  executeGraduatedResponse,
  CHAT_SAFETY_PROTOCOL_GUIDANCE,
  subjectGuidance,
  subjectLabel,
} from './crisisIntervention.service.js';
import {
  getRecentSessionMessages,
  getSessionAccessInfo,
  getSessionCheckin,
  getSessionCrisisState,
  getSessionHighFlagSubjects,
  getSessionFlagEscalations,
  recordRecoveryDisclosure,
  incidentHasCrisisAdverseEvent,
  type SessionCheckin,
} from '../db/index.js';
import { sessionSuppressesSafetyPipeline } from './suppression.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';
import { enqueueWorkItem } from './workQueue.service.js';
import { trackBackground } from '../utils/backgroundWork.js';
import { withReadDeadline } from '../utils/readDeadline.js';
import { knownDemoAccountSession } from '../utils/sessionAccounts.js';
import { recentTurns, rememberedCheckin } from '../utils/recentTurns.js';
import { emitCrisisResources, hasEmittedHighRiskResources } from './crisisResources.js';
import {
  pageHighRisk,
  pageStage,
  riskPageLevel,
  retryCrisisRecord,
  PAGE_LEVEL,
  PAGE_FOLD_WINDOW_MS,
  type PageLevel,
  type PageSubject,
} from './crisisPaging.service.js';
import type { MinorVerdict } from './minorSafeguard.service.js';

export interface ParticipantTurn {
  sessionId: string;
  messageId: string | number | null;
  content: string;
  /** 'checkin': `content` is the free text of the pre-session check-in, not a
   *  chat or voice turn (see runCheckinCrisisScreen). */
  source?: 'checkin';
}

/** How many recent turns the assessor is shown. */
const HISTORY_WINDOW = 10;

/** The check-in's free text (what is on their mind, what they want from
 *  today), as one string to score; '' when there is none. The mood number is
 *  not text and is not scored. Pure; exported for tests. */
export function checkinFreeText(checkin: Pick<SessionCheckin, 'topic' | 'goal'> | null | undefined): string {
  return [checkin?.topic, checkin?.goal]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Pre-session check-in through the crisis pipeline.
 *
 * The check-in ("what's on your mind", "what do you want from today") is
 * quoted into the model's prompt, and until this existed that was the only
 * place it went: a participant who wrote "I don't really want to be alive"
 * and then typed "hi" had no risk row, no flag and no steer (measured
 * 2026-11-18, 5 of 5 runs, peak risk 0). It is the participant's own words to
 * the assistant, so it is scored exactly as a first message is: same screen,
 * same assessor, same flag, page and steering, on the same channel rules. The
 * risk row has no message id (the check-in is not a `messages` row) and
 * carries `source: 'checkin'`.
 *
 * Call it once, after the session row and its check-in are stored. Never
 * throws. Chat callers inject the returned `steeringGuidance`.
 */
export async function runCheckinCrisisScreen(
  sessionId: string,
  checkin: Pick<SessionCheckin, 'topic' | 'goal'> | null | undefined,
  channel: 'realtime' | 'chat',
): Promise<CrisisPipelineResult> {
  const content = checkinFreeText(checkin);
  if (!content) return NONE_RESULT;
  return runCrisisPipeline({ sessionId, messageId: null, content, source: 'checkin' }, channel);
}

/**
 * The history the risk assessor reads for a turn. While the start of the
 * session is still inside the window, the check-in's free text is put first,
 * as the participant's words: after a check-in that said "I don't really want
 * to be alive", a later "yeah" or "tonight" refers to it, and the assessor can
 * only resolve that if it can see it. Never throws (a failed read leaves the
 * history as it was).
 */
async function withCheckinContext<T extends { role: string; content?: string | null }>(
  sessionId: string,
  history: T[],
  turn: ParticipantTurn,
  /** The check-in, already being read (started alongside the history). */
  checkinRead?: Promise<SessionCheckin | null>,
): Promise<Array<T | { role: string; content: string }>> {
  if (turn.source === 'checkin' || history.length >= HISTORY_WINDOW) return history;
  let text = '';
  try {
    text = checkinFreeText(await (checkinRead ?? withReadDeadline(getSessionCheckin(sessionId), 'check-in read')));
  } catch (err) {
    console.error('[CrisisPipeline] check-in read failed; using the copy kept at session start:', err);
  }
  // The stored check-in could not be read, or was never stored (its write is
  // best effort at session start): the copy this process kept when the
  // session started (ai-therapist-373). A risk check-in followed by "hi" is
  // read together whatever the database does.
  if (!text) text = rememberedCheckin(sessionId) ?? '';
  if (!text) return history;
  return [{ role: 'user', content: `[Written in the pre-session check-in form] ${text}` }, ...history];
}

/** A row of the history the assessor reads (a stored message, or a turn kept
 *  in memory shaped like one). */
type HistoryRow = Awaited<ReturnType<typeof getRecentSessionMessages>>[number];

/** Where a turn's history came from (ai-therapist-373):
 *   database        the stored messages (the primary source);
 *   memory          this process's copy, complete since the session started here;
 *   memory_partial  this process's copy of a session it did not see start
 *                   (a restart, another instance): it may be missing turns;
 *   none            neither: the turn is read on its own. */
export type HistorySource = 'database' | 'memory' | 'memory_partial' | 'none';

/** Prefix of the stand-in id a remembered turn without a stored row carries,
 *  so the split-sentence stitcher can find it. Never passed on as a row id. */
const MEMORY_ID_PREFIX = 'mem:';

/** The turns this process kept for the session, as history rows. */
function rememberedHistory(sessionId: string): { rows: HistoryRow[]; complete: boolean } | null {
  const held = recentTurns(sessionId);
  if (!held || held.turns.length === 0) return held ? { rows: [], complete: held.complete } : null;
  const rows = held.turns.slice(-HISTORY_WINDOW).map(
    (t): HistoryRow => ({
      role: t.role,
      content: t.content,
      content_redacted: null,
      message_id: t.messageId ?? `${MEMORY_ID_PREFIX}${t.seq}`,
      created_at: new Date(t.at),
    }),
  );
  return { rows, complete: held.complete };
}

/**
 * The history a turn is scored with, and where it came from (ai-therapist-373).
 *
 * The database is read first and is used whenever it answers in time and this
 * turn was stored: it is complete across processes and restarts, so normal
 * scoring is exactly what it was. This process's copy (utils/recentTurns) is
 * used instead when
 *   - the read failed or passed its 2 s bound: with no history the assessor
 *     lost the split sentence and the answer to a safety question, and a
 *     page became no page; or
 *   - the turn itself could not be stored (no message id): the database is
 *     evidently not keeping up, its history is missing at least this turn and
 *     probably the ones around it.
 * The copy is not merged into a history the database did give: the two
 * clocks and the browser's batching make a merged order a guess, and a guess
 * is not better than the stored order.
 */
export function chooseHistory(
  turn: ParticipantTurn,
  stored: HistoryRow[] | null,
): { rows: HistoryRow[]; source: HistorySource } {
  const databaseUsable = stored !== null && turn.messageId != null;
  if (databaseUsable) return { rows: stored, source: 'database' };
  const memory = rememberedHistory(turn.sessionId);
  // The database answered and only this turn could not be stored: a copy this
  // process knows to be partial (a session it did not see start) is not
  // preferred over the stored history, which is complete up to this turn
  // (PR #88 review). Preferring it would score the turn on fewer turns and
  // put it under the context-blind rule although the history was read.
  if (stored !== null && memory && !memory.complete) return { rows: stored, source: 'database' };
  if (memory && memory.rows.length > 0) {
    return { rows: memory.rows, source: memory.complete ? 'memory' : 'memory_partial' };
  }
  if (stored !== null) return { rows: stored, source: 'database' };
  return { rows: [], source: memory?.complete ? 'memory' : 'none' };
}

/** The current turn's place in a remembered history: by its stored id, else
 *  the latest participant turn with the same words. */
function locateInMemory(turn: ParticipantTurn, rows: HistoryRow[]): string | number | null {
  if (turn.messageId != null) {
    const byId = rows.find((r) => r.message_id != null && String(r.message_id) === String(turn.messageId));
    if (byId) return turn.messageId;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user' && rows[i].content === turn.content) return rows[i].message_id as string | number;
  }
  return null;
}

/** stitchSplitTurnParts over a history from memory: the turn is found there
 *  even without a stored id, and stand-in ids are never passed on. */
function stitchFromMemory(
  turn: ParticipantTurn,
  rows: HistoryRow[],
): { content: string; priorMessageIds: Array<string | number> } {
  const id = locateInMemory(turn, rows);
  if (id == null) return { content: turn.content, priorMessageIds: [] };
  const parts = stitchSplitTurnParts({ ...turn, messageId: id }, rows);
  return {
    content: parts.content,
    priorMessageIds: parts.priorMessageIds.filter((p) => !String(p).startsWith(MEMORY_ID_PREFIX)),
  };
}

export type CrisisSeverity = 'none' | 'low' | 'medium' | 'high';

export interface CrisisPipelineResult {
  riskScore: number;
  severity: CrisisSeverity;
  factors: string[];
  flagged: boolean;
  /** Non-null when steering should be delivered to the model this/next turn.
   *  Realtime callers ignore it (sideband injection already happened);
   *  chat callers inject it into the model call. */
  steeringGuidance: string | null;
}

const NONE_RESULT: CrisisPipelineResult = {
  riskScore: 0,
  severity: 'none',
  factors: [],
  flagged: false,
  steeringGuidance: null,
};

const SEVERITY_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * Full per-turn crisis pipeline, shared by /logs/batch and /api/chat/message.
 * `channel` controls only steering DELIVERY; detection/flagging/paging/AE are
 * identical. Never throws (analyzeMessageRisk already error-swallows; the rest
 * is wrapped here) — a crisis-pipeline failure must never break either route.
 */
export async function runCrisisPipeline(
  turn: ParticipantTurn,
  channel: 'realtime' | 'chat',
): Promise<CrisisPipelineResult> {
  try {
    // Demo-ACCOUNT (magic-link) sessions never enter the real crisis pipeline:
    // no scoring, no flags, no admin alerts, and crucially no SMS page to the
    // on-call. Keyed on the owner's role, NOT the session is_demo flag — the
    // eval harness's sessions carry is_demo for analytics exclusion but must
    // still exercise the real pipeline (its runner neuters paging/broadcast).
    // A failed or timed-out read (ai-therapist-366: the pool now rejects
    // instead of waiting forever) fails toward running the pipeline: a demo
    // session may then be scored, a real one is never skipped.
    //
    // ai-therapist-369: the account is usually known without a read, from the
    // request that started the session (utils/sessionAccounts). Only a session
    // this process did not see start is read, and that read, the history and
    // the check-in are read together, each bounded by CRISIS_READ_DEADLINE_MS:
    // they only shape how the turn is scored, and must not hold the page back
    // for a pool timeout each, in sequence.
    const knownDemo = knownDemoAccountSession(turn.sessionId);
    if (knownDemo === true) return NONE_RESULT;
    const demoRead: Promise<boolean> =
      knownDemo !== null
        ? Promise.resolve(knownDemo)
        : withReadDeadline(
            Promise.resolve().then(() => sessionSuppressesSafetyPipeline(turn.sessionId)),
            'demo check',
          ).catch((err: unknown) => {
            logDbMiss('demo check')(err);
            return false;
          });
    // null: the read failed or passed its bound (see chooseHistory).
    const historyRead = withReadDeadline(
      Promise.resolve().then(() => getRecentSessionMessages(turn.sessionId, HISTORY_WINDOW)),
      'history read',
    ).catch((err: unknown): HistoryRow[] | null => {
      console.error('[CrisisPipeline] history read failed; using the turns kept in memory:', err);
      return null;
    });
    // Read alongside, used only while the session's start is in the window.
    const checkinRead =
      turn.source === 'checkin'
        ? undefined
        : withReadDeadline(
            Promise.resolve().then(() => getSessionCheckin(turn.sessionId)),
            'check-in read',
          );
    checkinRead?.catch(() => undefined);
    const [suppressed, storedHistory] = await Promise.all([demoRead, historyRead]);
    if (suppressed) return NONE_RESULT;
    // The check-in is screened on its own words: it has no history.
    const { rows: history, source: historySource } =
      turn.source === 'checkin'
        ? { rows: [] as HistoryRow[], source: 'database' as const }
        : chooseHistory(turn, storedHistory);
    if (historySource !== 'database') {
      console.warn(
        `[CrisisPipeline] ${turn.sessionId.substring(0, 12)}...: turn scored with history from ${historySource} ` +
          `(${history.length} turns)`,
      );
    }

    // Age-eligibility confirmation starts NOW, alongside risk scoring, and is
    // acted on after the crisis block below (ai-therapist-296). On voice the
    // model answers within about half a second, so every second the verdict
    // waits behind the risk assessor is a second the voice model is talking to
    // someone the study cannot include. Only the LLM confirmation is moved
    // forward; the ordering of the ACTIONS (crisis first, then eligibility) is
    // unchanged.
    // A spoken sentence can reach us as two turns. GPT-Live sends transcript
    // fragments, and the assembler closes a turn after 900 ms without one; a
    // late final fragment then becomes a turn of its own. Measured 2026-11-18:
    // "I have been thinking about how I would kill" + " myself" arrived as two
    // rows in 2 of 4 runs, each scored 0 (the keyword screen saw neither
    // half), so an explicit statement of intent was never flagged or paged.
    // Scoring and the age check therefore read the sentence as it was spoken:
    // this turn joined to the participant turn(s) that ended moments before it.
    // From memory the turn is found without a stored id (ai-therapist-373).
    const stitched =
      channel === 'realtime' && turn.source !== 'checkin'
        ? historySource === 'database'
          ? stitchSplitTurnParts(turn, history)
          : stitchFromMemory(turn, history)
        : { content: turn.content, priorMessageIds: [] };
    const scoredTurn = stitched.content === turn.content ? turn : { ...turn, content: stitched.content };

    // Unchanged for the check-in: the age gate has never read it, and whether
    // it should is not decided here.
    const minorVerdict =
      channel === 'realtime' && turn.source !== 'checkin' ? startRealtimeMinorConfirmation(scoredTurn, history) : null;

    // The moment the verdict is known (inside the scorer, before it writes
    // the turn's risk row), a high turn shows the crisis card and, unless it
    // tells the on-call nothing new, pages (ai-therapist-369). See
    // respondToHighVerdict.
    let earlyPage: EarlyPageOutcome | null = null;
    const onScored = (verdict: Awaited<ReturnType<typeof analyzeMessageRisk>>): void => {
      if (earlyPage) return;
      earlyPage = respondToHighVerdict(turn, verdict);
    };
    const risk = await analyzeMessageRisk(
      {
        content: scoredTurn.content,
        session_id: turn.sessionId,
        message_id: turn.messageId ?? undefined,
        // The earlier part(s) of this sentence were scored on their own when
        // they arrived. Their rows are this message, not its run-up: the
        // scorer leaves them out of the trajectory so the sentence is not its
        // own "sudden spike" (a medium statement plus " you know?" scored
        // high, and paged, before this was passed).
        ...(stitched.priorMessageIds.length > 0 ? { stitched_message_ids: stitched.priorMessageIds } : {}),
        ...(turn.source ? { source: turn.source } : {}),
        // Only when it is not the stored history (ai-therapist-373): recorded
        // on the risk row, and 'none' / 'memory_partial' turn on the
        // context-blind rule in the scorer.
        ...(historySource !== 'database' ? { history_source: historySource } : {}),
      },
      await withCheckinContext(turn.sessionId, history, turn, checkinRead),
      { onScored },
    );
    // A scorer that returned without calling the hook (an error path) is
    // answered here, from what it returned.
    onScored(risk);
    const pageRequested = (earlyPage as EarlyPageOutcome | null)?.pageRequested === true;

    const severity = risk.severity as CrisisSeverity;
    // Not the participant's own suicide or self-harm risk: someone else's
    // crisis reported by the participant (ai-therapist-326), or thoughts of
    // harming another person (ai-therapist-330). Same flag, same page; the
    // label, the steer and the ladder differ.
    const subject = risk.subject ?? (risk.thirdParty === true ? 'third_party' : null);
    const subjectDetail = subject ? { subject } : {};
    const label = subjectLabel(subject);
    const fromCheckin = turn.source === 'checkin';
    let steeringGuidance: string | null = null;
    let flagged = false;

    if (risk.riskScore > 0) {
      // Flag state BEFORE this turn's own flagging: read once, used by both
      // the steering decision and the flagging decision below.
      // A failed read must not cost this turn its steer (the read used to come
      // after steering): steer on the default rule, then flag as if the
      // session were unflagged (see the flagging step).
      let state: Awaited<ReturnType<typeof getSessionCrisisState>> = null;
      let stateError: unknown = null;
      try {
        state = await getSessionCrisisState(turn.sessionId);
      } catch (err) {
        stateError = err;
      }
      // High severity normally forces the safety-protocol steer past the
      // cooldown. The one exception is a context-wake turn (no keyword; scored
      // high only because of what the session already holds) in a session that
      // is ALREADY flagged high: there the protocol has been delivered, and in
      // such a session every short answer ("yes", "tonight") is context-
      // assessed, so forcing would re-inject "start the assessment at question
      // one" on every turn. Those turns steer on the ordinary cooldown. A
      // context-wake turn that ESCALATES the session (anything below high ->
      // high) still forces, as does every keyword-hit turn, exactly as before.
      const alreadyHigh = state?.crisis_flagged === true && state?.crisis_severity === 'high';
      const forceSteer = severity === 'high' && !(risk.contextWake === true && alreadyHigh);

      // Summary-tier live signal (caseworker portal spec section 5): score +
      // severity only — caseworker sockets get risk trends without any
      // transcript content. Fire-and-forget; never blocks the pipeline.
      if (global.io) {
        void broadcastAdminEventForSession(
          global.io,
          'session:risk-score-updated',
          {
            sessionId: turn.sessionId,
            riskScore: risk.riskScore,
            severity,
            at: new Date(),
          },
          turn.sessionId,
          'summary',
        );
      }

      // ---- Steering ----
      if (channel === 'realtime') {
        // Sideband injection happens inside; realtime ignores the return value.
        // The extra arguments only exist for a labelled subject; every other
        // turn makes the call it always made.
        if (subject) {
          await maybeSteerSession(
            turn.sessionId,
            risk.riskScore,
            severity,
            forceSteer,
            subjectGuidance(subject, 'realtime'),
            subject,
          );
        } else {
          await maybeSteerSession(turn.sessionId, risk.riskScore, severity, forceSteer);
        }
      } else if (shouldSteer(turn.sessionId, risk.riskScore, forceSteer)) {
        // Chat: same shared cooldown, but the guidance is returned for the
        // caller to inject into this turn's model call. High severity swaps the
        // base copy for the full safety-assessment protocol and mirrors the
        // realtime `safety_protocol` intervention so the AE timeline matches.
        // High severity forces past the cooldown — a crisis escalating within
        // three minutes of a routine steer must still get the safety protocol.
        steeringGuidance =
          subjectGuidance(subject, 'chat') ??
          (severity === 'high' ? CHAT_SAFETY_PROTOCOL_GUIDANCE : buildChatSteeringGuidance(risk.riskScore, severity));
        await logInterventionAction(turn.sessionId, 'risk_steering', {
          riskScore: risk.riskScore,
          severity,
          channel: 'chat',
          ...subjectDetail,
        });
        if (severity === 'high') {
          await logInterventionAction(turn.sessionId, 'safety_protocol', {
            riskScore: risk.riskScore,
            channel: 'chat',
            ...subjectDetail,
          });
        }
        if (global.io) {
          void broadcastAdminEventForSession(
            global.io,
            'session:risk-steering',
            {
              sessionId: turn.sessionId,
              riskScore: risk.riskScore,
              severity,
              steeredAt: new Date(),
            },
            turn.sessionId,
          );
        }
      }

      // ---- Structured risk ladder (ai-therapist-198) ----
      // Independent of the steering cooldown above: the ladder requirement is
      // a one-shot-per-window demand keyed on "score crossed the threshold AND
      // this session has logged no ladder step", not on steering cadence. It
      // runs on both channels; realtime delivers over the sideband inside,
      // chat gets a guidance string appended to this turn's model call.
      // Not for a third party at risk or for risk to others: the ladder asks
      // the participant about their OWN suicidal thoughts. If the participant
      // voices thoughts of their own, that turn is scored as theirs and
      // requires the ladder as usual.
      const ladderGuidance = subject
        ? null
        : await maybeRequireRiskCheck(turn.sessionId, risk.riskScore, severity, channel);
      if (ladderGuidance) {
        steeringGuidance = steeringGuidance ? `${steeringGuidance}\n\n${ladderGuidance}` : ladderGuidance;
      }

      // ---- Flagging ---- (identical to the original realtime logic)
      // An unreadable state is treated as unflagged: the turn flags, and a
      // high one pages (the paging layer folds a duplicate). It used to throw
      // here, so a database timeout meant no flag and no page.
      if (stateError) logDbMiss('crisis state read')(stateError);
      const currentScore = state?.crisis_risk_score || 0;
      const currentRank = SEVERITY_RANK[state?.crisis_severity ?? 'none'] ?? 0;
      // A re-flag never LOWERS a session's severity. The score clause exists
      // for "same band, clearly worse"; on a high flag stored without a score
      // (the text hand-off's stamp when the incident's risk could not be read)
      // it would otherwise let a medium turn rewrite the session to medium.
      // Seen live in the PR #77 review.
      // An unreadable state flags a HIGH turn only. flagSessionCrisis writes
      // the turn's severity unconditionally, so a medium turn flagged "as if
      // unflagged" would rewrite a session that is in fact flagged high down
      // to medium (monitoring 'critical' to 'high', and the next high turn
      // treated as a first flag) whenever the read failed but the write got
      // through. A high turn cannot lower the severity, and it must page.
      const flagByLevel =
        (severity === 'high' || severity === 'medium') &&
        (stateError
          ? severity === 'high'
          : !state?.crisis_flagged ||
            SEVERITY_RANK[severity] > currentRank ||
            (SEVERITY_RANK[severity] >= currentRank && risk.riskScore > currentScore + 10));
      // A high turn about someone this session's high flags have not been
      // about. The level rule above compares numbers only, and a third party's
      // active crisis scores 80-100: after "my roommate is going to kill
      // herself tonight" (90, paged as THIRD PARTY AT RISK: "not their own"),
      // the participant's own "I've been thinking about killing myself too"
      // (75) is neither a higher severity nor 10 points above 90, so it raised
      // no flag, no crisis event and no page, and the only thing staff had
      // been told was that the participant was not the one at risk. The same
      // holds for the other orders (own risk, then credible intent to harm
      // someone). A change of who is at risk is new information: it flags.
      const flagBySubject =
        !flagByLevel && severity === 'high' && alreadyHigh
          ? await isFirstHighFlagAbout(turn.sessionId, subject)
          : { first: false, earlier: [] as FlagSubject[] };
      // An escalation INSIDE the high band (ai-therapist-353). The level rule
      // re-flags only when a score is more than 10 above the stored one, so a
      // participant could go from ideation (75) to "tonight" (85) to "I already
      // took the pills" (95) with one flag event and one text: 85 is not more
      // than 75 + 10, and 95 is not more than 85 + 10. Two facts flag whatever
      // the stored score is:
      //  - the assessor's literal observation that the latest message states a
      //    time or plan, or an attempt in progress (`acute`), the first time
      //    the session reaches that stage for that person;
      //  - the score crossing into the critical range (90 and up) from below,
      //    in case the observation is missing.
      // The flag event, the dashboard alert and the page then say WHAT changed.
      const acute = severity === 'high' ? (risk.acute ?? null) : null;
      const crossedCritical = severity === 'high' && alreadyHigh && risk.riskScore >= 90 && currentScore < 90;
      const flagByEscalation =
        !flagByLevel && !flagBySubject.first && severity === 'high' && alreadyHigh && acute !== null
          ? await isFirstFlagAtStage(turn.sessionId, acute, subject)
          : false;
      // The same turn scored a second time (a re-sent transcript batch after an
      // unsaved one) is not flagged again once its flag is on record
      // (ai-therapist-373): one turn, one crisis event, one adverse-event
      // draft, and a staff unflag in between stands. Its page is the paging
      // layer's to fold.
      const duplicateTurn = flaggedTurnOnRecord(turn);
      if (duplicateTurn) {
        console.warn(
          `[CrisisPipeline] ${turn.sessionId.substring(0, 12)}...: this turn's flag is already on record; not flagged again`,
        );
      }
      const shouldFlag = !duplicateTurn && (flagByLevel || flagBySubject.first || flagByEscalation || crossedCritical);
      const escalationNote = acute
        ? `What changed: ${ESCALATION_NOTE[acute]}`
        : crossedCritical
          ? 'What changed: the risk score rose into the critical range (90 or more)'
          : null;
      const alsoSubject = risk.alsoSubject ?? null;
      const subjectChangeNote = flagBySubject.first
        ? `${FLAG_SUBJECT_NAME[subject ?? 'own']} now; the earlier high flag in this session was about ` +
          `${flagBySubject.earlier.map((s) => FLAG_SUBJECT_NAME[s]).join(' and ') || 'someone else'}`
        : null;

      if (shouldFlag) {
        // A flag write that fails must not cost the turn its response: the
        // page and the resources below do not depend on the row
        // (ai-therapist-366). A HIGH flag that fails is retried in the
        // background and, if it never lands, reported to the admin dashboards
        // (ai-therapist-369): it is the crisis event the IRB counts and the
        // adverse-event draft hang on.
        const flagFactors = fromCheckin ? [...risk.factors, CHECKIN_FACTOR] : risk.factors;
        const flagNotes =
          `Risk score: ${risk.riskScore} - ` +
          (label ? `${label} - ` : '') +
          (subjectChangeNote ? `${subjectChangeNote} - ` : '') +
          (escalationNote ? `${escalationNote} - ` : '') +
          (alsoSubject ? `Also in the same message: ${FLAG_SUBJECT_NAME[alsoSubject]} - ` : '') +
          (fromCheckin ? 'Source: pre-session check-in text - ' : '') +
          `Factors: ${risk.factors.join(', ')}`;
        const attemptedAt = Date.now();
        try {
          await flagSessionCrisis(
            turn.sessionId,
            severity,
            risk.riskScore,
            'system',
            'auto',
            turn.messageId ?? null,
            flagFactors,
            flagNotes,
          );
          noteTurnFlagged(turn);
        } catch (err) {
          logDbMiss('flag write')(err);
          if (severity === 'high') {
            retryCrisisRecord({
              sessionId: turn.sessionId,
              what: 'crisis flag',
              summary: `High risk flag, score ${risk.riskScore}/100${label ? ` (${label})` : ''}.`,
              // Idempotent per turn (ai-therapist-373): nothing is written
              // when the same turn's flag reached the record another way
              // meanwhile, or when staff unflagged the session after this
              // attempt (flagSessionCrisis checks both in its transaction;
              // this process's own record is checked first).
              write: async () => {
                if (flaggedTurnOnRecord(turn)) return 'skipped_duplicate';
                const outcome = await flagSessionCrisis(
                  turn.sessionId,
                  severity,
                  risk.riskScore,
                  'system',
                  'auto',
                  turn.messageId ?? null,
                  flagFactors,
                  flagNotes,
                  { retry: true, attemptedAt: new Date(attemptedAt) },
                );
                if (outcome === 'written') noteTurnFlagged(turn);
                return outcome;
              },
            });
          }
        }

        await logInterventionAction(turn.sessionId, 'auto_flag', {
          riskScore: risk.riskScore,
          severity,
          messageId: turn.messageId,
          factors: risk.factors,
          ...subjectDetail,
          ...(fromCheckin ? { source: 'checkin' } : {}),
          ...(flagBySubject.first ? { trigger: 'new_subject', earlierSubjects: flagBySubject.earlier } : {}),
          // Recorded on every high flag that states it, so the next turn can
          // tell whether this stage has already been flagged.
          ...(acute ? { escalation: acute } : {}),
          ...(flagByEscalation ? { trigger: 'escalation' } : {}),
          ...(crossedCritical && !flagByLevel && !flagByEscalation && !flagBySubject.first
            ? { trigger: 'crossed_critical' }
            : {}),
          ...(alsoSubject ? { alsoSubject } : {}),
        });

        if (global.io) {
          void broadcastAdminEventForSession(
            global.io,
            'session:crisis-detected',
            {
              sessionId: turn.sessionId,
              severity,
              riskScore: risk.riskScore,
              factors: risk.factors,
              messageId: turn.messageId,
              detectedAt: new Date(),
              message:
                `${severity.toUpperCase()} risk detected (score: ${risk.riskScore})` +
                (label ? ` - ${label}` : '') +
                (subjectChangeNote ? ` - ${subjectChangeNote}` : '') +
                (escalationNote ? ` - ${escalationNote}` : '') +
                (fromCheckin ? ' - from the pre-session check-in' : ''),
              ...subjectDetail,
              ...(acute ? { escalation: acute } : {}),
              ...(channel === 'chat' ? { sessionType: 'chat' } : {}),
            },
            turn.sessionId,
          );

          // Summary-tier mirror for caseworker sockets (spec section 5:
          // crisis-event-created is summary-safe). Severity/score/category
          // factors only — no message ids, no transcript-adjacent text.
          void broadcastAdminEventForSession(
            global.io,
            'session:crisis-event-created',
            {
              sessionId: turn.sessionId,
              severity,
              riskScore: risk.riskScore,
              factors: risk.factors,
              detectedAt: new Date(),
            },
            turn.sessionId,
            'summary',
          );
        }

        // The options only exist when there is something to say; an ordinary
        // high flag makes the call it always made.
        // `pageAlreadyRequested`: this turn's page went out when it scored
        // (respondToHighVerdict), with the same level, subject and words; the
        // response must not request it a second time.
        const responseOptions = {
          ...(subject === 'third_party' ? { thirdParty: true } : subject ? { subject } : {}),
          ...(acute ? { escalation: acute } : {}),
          ...(alsoSubject ? { alsoSubject } : {}),
          ...(pageRequested && severity === 'high' ? { pageAlreadyRequested: true } : {}),
        };
        if (Object.keys(responseOptions).length > 0) {
          await executeGraduatedResponse(turn.sessionId, severity, risk.riskScore, responseOptions);
        } else {
          await executeGraduatedResponse(turn.sessionId, severity, risk.riskScore);
        }
        flagged = true;

        await enqueueCrisisFlagWorkItem(turn.sessionId, severity, risk.riskScore, risk.factors, subject);

        console.log(`Session ${turn.sessionId} flagged as ${severity} risk (score: ${risk.riskScore}, ${channel})`);
      } else if (severity === 'high' && alreadyHigh) {
        // A high turn that the re-flag rule above let pass. Correct when the
        // stored high flag came from the participant (the on-call was paged
        // for it and the flag is on record). Not when it is only the
        // recovery-continuation stamp, and not when the turn is at the
        // critical level or states a time or plan the on-call has not been
        // told about: see handleHighTurnWithoutReflag. Fire-and-forget, like
        // the page in executeHighRiskResponse: the voice reply must not wait
        // on it.
        const turnRisk = {
          riskScore: risk.riskScore,
          factors: risk.factors,
          ...(subject ? { subject } : {}),
          ...(acute ? { acute } : {}),
        };
        trackBackground(
          (pageRequested
            ? handleHighTurnWithoutReflag(turn, turnRisk, channel, { pageAlreadyRequested: true })
            : handleHighTurnWithoutReflag(turn, turnRisk, channel)
          ).catch((err) => console.error('[CrisisPipeline] high turn without re-flag: handling failed:', err)),
        );
      }
    }

    // ---- Minor / age-eligibility safeguard (ai-therapist-106) ----
    // Realtime only: the chat route runs this gate itself (before its model
    // call) so it can return a server-authored goodbye. ACTED ON after the
    // crisis block so, when a turn is both high-crisis and minor-confirmed, the
    // page has already gone out and both AE drafts exist; the goodbye copy
    // carries the hotlines. Independent of risk score (e.g. "I'm 15" scores 0).
    // The confirmation itself was started before risk scoring (above).
    if (minorVerdict) {
      await applyRealtimeMinorVerdict(turn, await minorVerdict);
    }

    return { riskScore: risk.riskScore, severity, factors: risk.factors, flagged, steeringGuidance };
  } catch (err) {
    console.error('[CrisisPipeline] pipeline failed (non-fatal):', err);
    return NONE_RESULT;
  }
}

// ---- the page when a turn scores high (ai-therapist-369) -------------------
//
// The page used to be requested at the END of the turn's database work: the
// state read, the steer, the ladder, the subject and stage lookups and the flag
// write, each up to a pool timeout (3 s for a connection, 10 s a statement).
// Measured with every call failing at the connection limit: 42 s from the turn
// to the SMS; with every statement taking 10 s: 132 s.
//
// Now a high verdict shows the crisis card and requests the page the moment it
// is known, before the scorer writes the turn's risk row. Nothing the page
// says needs the pipeline's own reads: its level, subject, "what changed" and
// "also" lines come from the verdict, and its comparison with earlier pages
// from the paging layer's own bounded lookups (which, when they fail, make the
// page say so: HISTORY_UNREAD_LINE). The rest of the turn then runs as before
// and its graduated response, which used to request the page, is told it has
// been requested.
//
// The page is not requested at once when it would tell the on-call nothing
// new, so that a session's ordinary high turns do not each produce a page or
// a folded-page record: when this process has already paged for this session
// at the same or a higher level and stage, about the same person; or when the
// session is known to be flagged high already (the scorer's session context)
// and the turn is at the ordinary high level with no stated time, plan or
// attempt. Those turns are left to the pipeline's own rules after its reads,
// exactly as before (a subject change or a recovery-session disclosure still
// pages from there). When nothing is known (the context read failed), the
// page goes at once: the paging layer folds it if it repeats a page.

/** What respondToHighVerdict did for a turn. */
interface EarlyPageOutcome {
  /** The page for this turn was requested when it scored. */
  pageRequested: boolean;
}

/** A page this process requested when a turn scored, as the fold rule sees it. */
interface EarlyPage {
  subject: PageSubject;
  level: PageLevel;
  stage: 0 | 1 | 2;
  /** When it was requested (ms). Set by rememberEarlyPage. */
  at?: number;
}

const EARLY_PAGES_MAX_SESSIONS = 2000;
const earlyPages = new Map<string, EarlyPage[]>();

/** Test hook. */
export function _resetEarlyPageStateForTests(): void {
  earlyPages.clear();
  flaggedTurns.clear();
}

/** This session's early pages that can still stand for a page: those inside
 *  the paging layer's fold window (ai-therapist-373). An older one has stopped
 *  absorbing anything there, so it must not hold a new turn's page back here
 *  either: a critical turn an hour after a critical page is paged at once, not
 *  after the turn's database work. */
function liveEarlyPages(sessionId: string, now: number): EarlyPage[] {
  const all = earlyPages.get(sessionId);
  if (!all) return [];
  const live = all.filter((p) => p.at === undefined || now - p.at < PAGE_FOLD_WINDOW_MS);
  if (live.length === all.length) return all;
  if (live.length > 0) earlyPages.set(sessionId, live);
  else earlyPages.delete(sessionId);
  return live;
}

/** Is this page to be requested now, before the turn's own reads? Pure apart
 *  from the per-session record; exported for tests. */
export function pageAtOnce(
  sessionId: string,
  wanted: EarlyPage,
  sessionFlaggedHigh: boolean | null | undefined,
): boolean {
  // Not flagged high: the pipeline's level rule flags and pages this turn.
  if (sessionFlaggedHigh === false) return true;
  const mine = liveEarlyPages(sessionId, Date.now());
  if (mine.some((p) => p.subject === wanted.subject && p.level >= wanted.level && p.stage >= wanted.stage)) {
    return false;
  }
  if (sessionFlaggedHigh === true && wanted.level === PAGE_LEVEL.high && wanted.stage === 0 && mine.length === 0) {
    return false;
  }
  return true;
}

function rememberEarlyPage(sessionId: string, wanted: EarlyPage): () => void {
  const now = Date.now();
  const page: EarlyPage = { ...wanted, at: now };
  const list = [...liveEarlyPages(sessionId, now), page];
  earlyPages.delete(sessionId);
  earlyPages.set(sessionId, list);
  if (earlyPages.size > EARLY_PAGES_MAX_SESSIONS) {
    for (const id of earlyPages.keys()) {
      if (earlyPages.size <= EARLY_PAGES_MAX_SESSIONS / 2) break;
      earlyPages.delete(id);
    }
  }
  return () => {
    const rest = (earlyPages.get(sessionId) ?? []).filter((p) => p !== page);
    if (rest.length > 0) earlyPages.set(sessionId, rest);
    else earlyPages.delete(sessionId);
  };
}

/**
 * A turn's verdict is known. On a high one: the crisis card (once per
 * session, as before; not for thoughts of harming someone else), and the page,
 * unless pageAtOnce says it would tell the on-call nothing new. Synchronous;
 * the page itself runs in the background. Never throws.
 */
function respondToHighVerdict(
  turn: ParticipantTurn,
  verdict: Awaited<ReturnType<typeof analyzeMessageRisk>>,
): EarlyPageOutcome {
  try {
    if (verdict.severity !== 'high') return { pageRequested: false };
    const subject = verdict.subject ?? (verdict.thirdParty === true ? 'third_party' : null);

    // Crisis resources the moment a turn scores high, before steering, the
    // flag write and the intervention logs (ai-therapist-293). Once per
    // session from here: a later escalation re-emits from
    // executeHighRiskResponse exactly as before, so a participant who closed
    // the card is not shown it again on every high turn.
    // Not for thoughts of harming someone else (see executeHighRiskResponse).
    if (subject !== 'harm_to_others' && !hasEmittedHighRiskResources(turn.sessionId)) {
      emitCrisisResources(turn.sessionId, { reason: 'high_risk', severity: 'high', riskScore: verdict.riskScore });
    }

    const acute = verdict.acute ?? null;
    const wanted: EarlyPage = {
      subject: subject ?? 'own',
      level: riskPageLevel(verdict.riskScore, acute),
      stage: pageStage(acute),
    };
    if (!pageAtOnce(turn.sessionId, wanted, verdict.sessionFlaggedHigh)) return { pageRequested: false };

    const forget = rememberEarlyPage(turn.sessionId, wanted);
    // The same facts executeHighRiskResponse sends, so the page reads exactly
    // as it would have: who it is about, what the turn says is happening, and
    // anyone else the same message concerned.
    const facts = {
      source: 'participant_turn' as const,
      ...(subject ? { subject } : {}),
      ...(acute ? { escalation: acute } : {}),
      ...(verdict.alsoSubject ? { alsoSubject: verdict.alsoSubject } : {}),
      requested: 'on_score',
      ...(turn.source === 'checkin' ? { turnSource: 'checkin' } : {}),
    };
    trackBackground(
      pageHighRisk(turn.sessionId, verdict.riskScore, facts)
        .then((decision) => {
          // A page no channel accepted has told the on-call nothing: the next
          // high turn must not be held back by it.
          if (decision?.outcome === 'not_delivered') forget();
        })
        .catch((err: unknown) => {
          forget();
          console.error('[CrisisPipeline] page on a high verdict failed:', err);
        }),
    );
    return { pageRequested: true };
  } catch (err) {
    console.error('[CrisisPipeline] responding to a high verdict failed; the pipeline pages as before:', err);
    return { pageRequested: false };
  }
}

// ---- one turn, one flag (ai-therapist-373) -----------------------------------
//
// A turn can be scored twice: a voice batch that /logs/batch could not store is
// screened as it fails (no message id) and scored again when the browser
// re-sends it and it is stored (a message id). A high flag whose write failed
// is retried in the background for about 2.5 minutes. Together they produced
// two crisis events and two adverse-event drafts for one turn, and either could
// put back a flag that staff had cleared in between. This process remembers,
// for FLAGGED_TURN_MEMORY_MS, each turn whose flag reached the record.
//
// The same turn: the same session and the same words, with the same message id
// or with no id on one side (the unsaved copy). Two different stored ids are
// two turns, even with the same words.

/** Longer than the flag retries (5 s + 30 s + 2 min). */
export const FLAGGED_TURN_MEMORY_MS = 5 * 60 * 1000;
const FLAGGED_TURNS_MAX_SESSIONS = 2000;
const flaggedTurns = new Map<string, Array<{ words: string; messageId: string | null; at: number }>>();

function sameTurnEntries(sessionId: string, now: number) {
  const list = (flaggedTurns.get(sessionId) ?? []).filter((e) => now - e.at < FLAGGED_TURN_MEMORY_MS);
  if (list.length > 0) flaggedTurns.set(sessionId, list);
  else flaggedTurns.delete(sessionId);
  return list;
}

/** Has this turn's flag already reached the record (in this process)? */
export function flaggedTurnOnRecord(turn: ParticipantTurn): boolean {
  const words = turn.content.trim();
  const id = turn.messageId == null ? null : String(turn.messageId);
  return sameTurnEntries(turn.sessionId, Date.now()).some(
    (e) => e.words === words && (e.messageId === null || id === null || e.messageId === id),
  );
}

/** This turn's flag reached the record. */
export function noteTurnFlagged(turn: ParticipantTurn): void {
  const now = Date.now();
  const list = sameTurnEntries(turn.sessionId, now);
  list.push({ words: turn.content.trim(), messageId: turn.messageId == null ? null : String(turn.messageId), at: now });
  flaggedTurns.delete(turn.sessionId);
  flaggedTurns.set(turn.sessionId, list);
  if (flaggedTurns.size > FLAGGED_TURNS_MAX_SESSIONS) {
    for (const id of flaggedTurns.keys()) {
      if (flaggedTurns.size <= FLAGGED_TURNS_MAX_SESSIONS / 2) break;
      flaggedTurns.delete(id);
    }
  }
}

/** Logs a database read or write the pipeline continues without. */
function logDbMiss(what: string): (err: unknown) => undefined {
  return (err: unknown) => {
    console.error(`[CrisisPipeline] ${what} failed; continuing toward paging:`, err);
    return undefined;
  };
}

/** Who a high flag is about: a labelled subject, or the participant. */
type FlagSubject = 'own' | 'third_party' | 'harm_to_others';

const FLAG_SUBJECT_NAME: Record<FlagSubject, string> = {
  own: "the participant's OWN risk",
  third_party: 'a third party at risk',
  harm_to_others: 'risk to others',
};

/**
 * Is this the first automatic high flag of the session about `subject` (null:
 * the participant's own risk), the session having been flagged high about
 * someone else? False when the session has no automatic high flag on record
 * (a manual flag or a recovery stamp: those are handled as before). A lookup
 * that fails flags: not knowing who the earlier flag was about is not a reason
 * to stay silent about a high turn. Never throws.
 */
async function isFirstHighFlagAbout(
  sessionId: string,
  subject: 'third_party' | 'harm_to_others' | null,
): Promise<{ first: boolean; earlier: FlagSubject[] }> {
  try {
    const earlier = [
      ...new Set(
        (await getSessionHighFlagSubjects(sessionId)).map(
          (s): FlagSubject => (s === 'third_party' || s === 'harm_to_others' ? s : 'own'),
        ),
      ),
    ];
    return { first: earlier.length > 0 && !earlier.includes(subject ?? 'own'), earlier };
  } catch (err) {
    console.error('[CrisisPipeline] could not read who the earlier high flag was about; flagging this turn:', err);
    return { first: true, earlier: [] };
  }
}

/** The flag event's words for what a high turn says is happening. */
const ESCALATION_NOTE: Record<'plan_or_time' | 'attempt', string> = {
  plan_or_time: 'stated intent with a time, a plan or the means at hand',
  attempt: 'ATTEMPT IN PROGRESS, or an act already taken',
};

/**
 * Has this session not yet been flagged at this stage ('plan_or_time' or
 * 'attempt') for this person? An attempt also counts as having stated a plan,
 * so "tonight" after "I already did it" does not flag again. A lookup that
 * fails flags: an attempt in progress is not something to stay silent about
 * because a read failed. Never throws.
 */
async function isFirstFlagAtStage(
  sessionId: string,
  stage: 'plan_or_time' | 'attempt',
  subject: 'third_party' | 'harm_to_others' | null,
): Promise<boolean> {
  try {
    const seen = (await getSessionFlagEscalations(sessionId)).filter((row) => (row.subject ?? null) === subject);
    return !seen.some((row) => row.escalation === stage || row.escalation === 'attempt');
  } catch (err) {
    console.error('[CrisisPipeline] could not read earlier escalation flags; flagging this turn:', err);
    return true;
  }
}

/** Factor added to a flag raised by the check-in text rather than a turn. */
export const CHECKIN_FACTOR = 'from the pre-session check-in';

/**
 * Work-queue hook (caseworker portal): pool item for the client's care team.
 * Only sessions with a logged-in participant enqueue — anonymous sessions
 * have no care team (a null-client item would fall back to the IRB org as
 * pure noise), and demo-account sessions never reach this code (guarded at
 * the top of the pipeline). `reopen` reactivates a resolved/expired item on a
 * re-flag at the same severity, so a recurrence after resolution notifies the
 * care team again instead of dying on the idempotency key; while the item is
 * open/acked a same-severity re-flag stays a silent no-op (no duplicate
 * spam). enqueueWorkItem never throws and resolves client/org/sandbox from
 * the session; detail carries category tags only, never transcript.
 */
async function enqueueCrisisFlagWorkItem(
  sessionId: string,
  severity: CrisisSeverity,
  riskScore: number,
  factors: string[],
  subject: 'third_party' | 'harm_to_others' | null = null,
): Promise<void> {
  try {
    const sessionInfo = await getSessionAccessInfo(sessionId);
    if (sessionInfo?.user_id != null) {
      void enqueueWorkItem({
        itemType: 'crisis_flag',
        severity: 'urgent',
        title:
          `Crisis flag: ${severity} risk (score ${riskScore})` +
          (subject === 'third_party'
            ? ' - third party at risk'
            : subject === 'harm_to_others'
              ? ' - risk to others'
              : ''),
        detail: { severity, risk_score: riskScore, factors },
        sourceTable: 'therapy_sessions',
        sourceId: `${sessionId}:${severity}`,
        sessionId,
        reopen: true,
      });
    }
  } catch (err) {
    console.error('[CrisisPipeline] work-item enqueue guard failed (non-fatal):', err);
  }
}

/** Longest the record of a recovery-session disclosure may hold its page
 *  back. Past it the page goes out and the record is finished afterwards. */
export const RECOVERY_DISCLOSURE_RECORD_TIMEOUT_MS = 2000;

/**
 * A turn scored HIGH in a session that is already flagged high, and the
 * re-flag rule did not fire (same severity, score not more than 10 above the
 * stored one).
 *
 * In an ordinary session that is right: the stored flag came from the
 * participant, it is on record, and the on-call was paged for it. In a
 * recovery session it is not. There the stored flag is the automatic
 * continuation stamp, written at the inherited score or at 100, so nothing
 * the participant says can ever exceed it by 10. PR #64 made such a turn
 * PAGE; it still wrote no flag event and, when the session it continues was
 * never flagged, no adverse-event draft: the incident was on the on-call's
 * phone and nowhere in the record (ai-therapist-363).
 *
 * So the participant's first real high turn in a stamp-only session now:
 *   1. is RECORDED: a crisis_events 'flagged' row with the score the assessor
 *      gave it, its factors and its message, and the session row's score and
 *      flag time corrected from the stamp's placeholder to what was assessed
 *      (db recordRecoveryDisclosure, one transaction, once per session);
 *   2. PAGES, under the usual folding (crisisPaging pageHighRisk);
 *   3. gets what a first high flag gets in the record: the 'auto_flag'
 *      intervention row, the admin dashboards' crisis events, the care-team
 *      work item, and an adverse-event draft unless the incident (the
 *      recovery chain) already has one, so one incident still has one report.
 * It does NOT re-run the high-risk response (executeGraduatedResponse): the
 * steer for this turn was decided above like any other high turn, and the
 * crisis resources went out when the turn scored.
 *
 * A session with a real high flag is left exactly as before: nothing is
 * written and nothing is paged from here, which is what keeps this from
 * duplicating an ordinary flag.
 *
 * Fail toward paging, and never trade the page for the record: if the record
 * throws, or has not answered in RECOVERY_DISCLOSURE_RECORD_TIMEOUT_MS, the
 * page is requested without waiting for it.
 *
 * The returned promise settles when everything it started has settled (the
 * page request, the dashboard events and the adverse-event draft), so a caller
 * that awaits it sees all of it; the pipeline does not await it.
 */
export async function handleHighTurnWithoutReflag(
  turn: ParticipantTurn,
  risk: {
    riskScore: number;
    factors: string[];
    /** Who the turn is about when it is not the participant's own risk. It
     *  goes into the page, the record's rows and the adverse-event draft; the
     *  crisis event carries it through `factors` (the label is the first one). */
    subject?: 'third_party' | 'harm_to_others';
    /** What the turn says is happening (ai-therapist-353). */
    acute?: 'plan_or_time' | 'attempt';
  },
  channel: 'realtime' | 'chat',
  /** `pageAlreadyRequested`: the page for this turn went out when it scored
   *  (respondToHighVerdict, ai-therapist-369). Nothing is paged from here;
   *  the record-side work is unchanged. */
  options: { pageAlreadyRequested?: boolean } = {},
): Promise<void> {
  const short = turn.sessionId.substring(0, 12);
  const pageFacts = {
    ...(risk.subject ? { subject: risk.subject } : {}),
    ...(risk.acute ? { escalation: risk.acute } : {}),
  };
  const subjectDetail = risk.subject ? { subject: risk.subject } : {};
  type Recorded = Awaited<ReturnType<typeof recordRecoveryDisclosure>>;
  const recording: Promise<Recorded | null> = (async () => {
    try {
      return await recordRecoveryDisclosure({
        sessionId: turn.sessionId,
        riskScore: risk.riskScore,
        messageId: turn.messageId ?? null,
        factors: risk.factors,
      });
    } catch (err) {
      console.error(
        `[CrisisPipeline] could not record the recovery-session disclosure for ${short}...; paging anyway:`,
        err,
      );
      return null;
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    recording,
    new Promise<'slow'>((resolve) => {
      timer = setTimeout(() => resolve('slow'), RECOVERY_DISCLOSURE_RECORD_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);

  // A real high flag exists: the on-call was paged for it, it is on record.
  // Two things still ask for a page, because that page did not say them
  // (review of PR 65, ai-therapist-353):
  //  - a turn at the critical level (a score of 90 or more, or an attempt in
  //    progress whatever the number). The re-flag rule needs MORE than 10
  //    points, so after "tonight" (85) an attempt scored 95 raised no flag and
  //    reached nobody. Measured live: "I already took the pills" 95.
  //  - a stated time or plan, behind REPAGE_ON_STATED_TIME_OR_PLAN.
  // Whether it becomes an SMS is the fold rule's decision: a page that was
  // already at that level and that far along, about the same person, absorbs
  // it. Nothing is written here; the turn's own flag event, when it is the
  // first at its stage, is written by the pipeline before this is reached.
  if (first !== 'slow' && first !== null && !first.recorded) {
    if (options.pageAlreadyRequested) return;
    await import('./crisisPaging.service.js')
      .then((m) => {
        if (m.riskPageLevel(risk.riskScore, risk.acute ?? null) === m.PAGE_LEVEL.critical) {
          return m.pageHighRisk(turn.sessionId, risk.riskScore, {
            ...pageFacts,
            trigger: 'critical_turn_without_reflag',
          });
        }
        if (risk.acute === 'plan_or_time' && m.REPAGE_ON_STATED_TIME_OR_PLAN) {
          return m.pageHighRisk(turn.sessionId, risk.riskScore, {
            ...pageFacts,
            trigger: 'stated_plan_without_reflag',
          });
        }
        return null;
      })
      .catch((err) => console.error('[CrisisPipeline] page for a critical turn without re-flag failed:', err));
    return;
  }

  if (first === 'slow') {
    console.error(`[CrisisPipeline] recording the recovery-session disclosure for ${short}... is slow; paging first`);
  }
  const paging = options.pageAlreadyRequested
    ? Promise.resolve()
    : import('./crisisPaging.service.js')
        .then((m) =>
          m.pageHighRisk(turn.sessionId, risk.riskScore, { ...pageFacts, trigger: 'high_turn_in_recovery_session' }),
        )
        .catch((err) => console.error('[CrisisPipeline] page for a recovery-session disclosure failed:', err));
  const started: Array<Promise<unknown>> = [paging];

  const recorded = first === 'slow' ? await recording : first;
  if (!recorded?.recorded) {
    await paging;
    return;
  }

  console.log(
    `Session ${turn.sessionId}: participant disclosure recorded in a recovery session ` +
      `(score: ${risk.riskScore}, replaces the continuation stamp's ${recorded.stampedScore ?? 'n/a'}, ${channel})`,
  );

  try {
    await logInterventionAction(turn.sessionId, 'auto_flag', {
      riskScore: risk.riskScore,
      severity: 'high',
      messageId: turn.messageId,
      factors: risk.factors,
      recoveryDisclosure: true,
      ...subjectDetail,
      ...(risk.acute ? { escalation: risk.acute } : {}),
      crisisEventId: recorded.eventId,
      replacesStampScore: recorded.stampedScore,
    });
  } catch (err) {
    console.error('[CrisisPipeline] auto_flag log for a recovery-session disclosure failed:', err);
  }

  if (global.io) {
    started.push(
      broadcastAdminEventForSession(
        global.io,
        'session:crisis-detected',
        {
          sessionId: turn.sessionId,
          severity: 'high',
          riskScore: risk.riskScore,
          factors: risk.factors,
          messageId: turn.messageId,
          detectedAt: new Date(),
          message:
            `HIGH risk detected in a recovery session (score: ${risk.riskScore})` +
            (risk.subject ? ` - ${subjectLabel(risk.subject)}` : ''),
          ...subjectDetail,
          ...(channel === 'chat' ? { sessionType: 'chat' } : {}),
        },
        turn.sessionId,
      ),
      broadcastAdminEventForSession(
        global.io,
        'session:crisis-event-created',
        {
          sessionId: turn.sessionId,
          severity: 'high',
          riskScore: risk.riskScore,
          factors: risk.factors,
          detectedAt: new Date(),
        },
        turn.sessionId,
        'summary',
      ),
    );
  }

  // One incident, one adverse-event report. If the incident's chain already
  // has one (the participant was flagged high before the cut), it stands. If
  // that cannot be determined, draft: a second draft is a nuisance for the
  // reviewer, a missing one is an unreported event. The assembler skips
  // non-study sessions and is idempotent per crisis event.
  let alreadyReported = false;
  try {
    alreadyReported = await incidentHasCrisisAdverseEvent(turn.sessionId);
  } catch (err) {
    console.error('[CrisisPipeline] could not tell whether the incident has an adverse-event report; drafting:', err);
  }
  if (!alreadyReported) {
    started.push(
      import('./adverseEvent.service.js')
        .then((m) =>
          risk.subject
            ? m.draftAdverseEventFromCrisis(turn.sessionId, { subject: risk.subject })
            : m.draftAdverseEventFromCrisis(turn.sessionId),
        )
        .catch((err) => console.error('AE auto-draft failed:', err)),
    );
  }

  await enqueueCrisisFlagWorkItem(turn.sessionId, 'high', risk.riskScore, risk.factors, risk.subject ?? null);
  await Promise.allSettled(started);
}

/** A participant turn that ended this recently before the next one began is
 *  treated as the first part of the same spoken sentence. */
export const SPLIT_TURN_WINDOW_MS = 4_000;

/**
 * The text to score for a voice turn: the turn itself, prefixed with any
 * participant turn(s) persisted immediately before it (no assistant turn in
 * between) and within SPLIT_TURN_WINDOW_MS of each other. Fragments carry
 * their own spacing, so the parts are concatenated exactly as received.
 *
 * `history` is oldest-first and normally ends with this turn's own row (it is
 * persisted before the pipeline runs). When the row cannot be found (the
 * insert failed), nothing is stitched. Pure; exported for tests.
 */
export function stitchSplitTurn(
  turn: ParticipantTurn,
  history: Array<{ role: string; content?: string | null; message_id?: unknown; created_at?: unknown }>,
): string {
  return stitchSplitTurnParts(turn, history).content;
}

/**
 * stitchSplitTurn, plus the ids of the earlier turn(s) that were joined in
 * (oldest first; empty when nothing was stitched). Pure; exported for tests.
 */
export function stitchSplitTurnParts(
  turn: ParticipantTurn,
  history: Array<{ role: string; content?: string | null; message_id?: unknown; created_at?: unknown }>,
): { content: string; priorMessageIds: Array<string | number> } {
  const alone = { content: turn.content, priorMessageIds: [] as Array<string | number> };
  if (turn.messageId == null) return alone;
  const at = history.findIndex((m) => m.message_id != null && String(m.message_id) === String(turn.messageId));
  if (at <= 0) return alone;
  const time = (m: { created_at?: unknown }): number | null => {
    const t = m.created_at instanceof Date ? m.created_at.getTime() : Date.parse(String(m.created_at ?? ''));
    return Number.isFinite(t) ? t : null;
  };
  let text = turn.content;
  const priorMessageIds: Array<string | number> = [];
  let laterAt = time(history[at]);
  for (let i = at - 1; i >= 0 && at - i <= 3; i--) {
    const prev = history[i];
    const prevAt = time(prev);
    if (prev.role !== 'user' || !prev.content || laterAt == null || prevAt == null) break;
    if (laterAt - prevAt > SPLIT_TURN_WINDOW_MS || laterAt < prevAt) break;
    text = prev.content + text;
    if (typeof prev.message_id === 'string' || typeof prev.message_id === 'number') {
      priorMessageIds.unshift(prev.message_id);
    }
    laterAt = prevAt;
  }
  return { content: text, priorMessageIds };
}

/**
 * When the under-18 goodbye guidance was last DELIVERED to a session's voice
 * model. A failed delivery is not recorded, so a later confirmation tries
 * again. Entries outlive the session's forced end (60 s) and are then dropped.
 */
const MINOR_GOODBYE_REPEAT_GUARD_MS = 90_000;
const minorGoodbyeDeliveredAt = new Map<string, number>();

function minorGoodbyeRecentlyDelivered(sessionId: string, now = Date.now()): boolean {
  for (const [id, at] of minorGoodbyeDeliveredAt) {
    if (now - at > MINOR_GOODBYE_REPEAT_GUARD_MS) minorGoodbyeDeliveredAt.delete(id);
  }
  return minorGoodbyeDeliveredAt.has(sessionId);
}

/** Test hook. */
export function _resetMinorGoodbyeStateForTests(): void {
  minorGoodbyeDeliveredAt.clear();
}

/** How many times the stage-2 confirmation is attempted before failing open. */
const MINOR_CONFIRM_ATTEMPTS = 2;

/**
 * Realtime minor safeguard, part 1: pattern screen, then the LLM confirmation.
 * Resolves to the verdict, or null when the screen did not match or the
 * confirmation could not be obtained. Never rejects, so it can run alongside
 * risk scoring without an unhandled rejection.
 *
 * Fail-open is unchanged: no verdict means the session continues (this gate
 * ENDS sessions, so it must not fire on a guess). What changed is that one
 * transient API error no longer decides that: the call is tried twice.
 */
async function startRealtimeMinorConfirmation(
  turn: ParticipantTurn,
  history: Awaited<ReturnType<typeof getRecentSessionMessages>>,
): Promise<MinorVerdict | null> {
  try {
    const { detectMinorDisclosurePatterns, confirmMinorDisclosure } = await import('./minorSafeguard.service.js');
    if (!detectMinorDisclosurePatterns(turn.content).matched) return null;

    const short = turn.sessionId.substring(0, 12);
    for (let attempt = 1; attempt <= MINOR_CONFIRM_ATTEMPTS; attempt++) {
      try {
        const verdict = await confirmMinorDisclosure(turn.content, history, turn.sessionId);
        // The verdict decides whether a session ends; before this line it was
        // invisible on the voice path, so a miss could not be told apart from
        // a wiring gap (ai-therapist-296). No transcript text, only the verdict.
        console.log(
          `[MinorSafeguard] realtime stage-2 verdict for ${short}...: ` +
            `is_minor=${verdict.isMinor} confidence=${verdict.confidence} stated_age=${verdict.statedAge ?? 'null'}` +
            (attempt > 1 ? ` (attempt ${attempt})` : ''),
        );
        return verdict;
      } catch (err) {
        console.error(
          `[MinorSafeguard] realtime stage-2 confirmation failed for ${short}... ` +
            `(attempt ${attempt}/${MINOR_CONFIRM_ATTEMPTS})` +
            (attempt === MINOR_CONFIRM_ATTEMPTS ? '; failing open, the session continues' : ''),
          err,
        );
      }
    }
    return null;
  } catch (err) {
    // Fail-open: an eligibility confirmation error must never end a session.
    console.error('[MinorSafeguard] realtime safeguard failed (fail-open):', err);
    return null;
  }
}

/**
 * Realtime minor safeguard, part 2: on a confirmed verdict, tell the live model
 * to say the goodbye and run the shared teardown (the browser is told to end,
 * and the server force-ends after a grace). Never throws.
 *
 * The steer and the teardown are independent on purpose. Before, a failed
 * steer (a sideband that had just dropped) threw past handleConfirmedMinor,
 * so a confirmed under-18 disclosure ended nothing and logged nothing.
 */
async function applyRealtimeMinorVerdict(turn: ParticipantTurn, verdict: MinorVerdict | null): Promise<void> {
  if (!verdict) return;
  try {
    if (verdict.isMinor && verdict.confidence !== 'low') {
      const { handleConfirmedMinor, REALTIME_MINOR_GUIDANCE, REALTIME_MINOR_SPEAK_NOW } = await import(
        './minorSafeguard.service.js'
      );
      try {
        const { sidebandManager } = await import('./sidebandManager.service.js');
        if (minorGoodbyeRecentlyDelivered(turn.sessionId)) {
          // The goodbye is being spoken (or was just spoken). The guidance
          // tells the model "do not finish whatever you were saying before",
          // so delivering it a second time would cut the goodbye off and start
          // it again. A second confirmation is routine on voice: a trailing
          // fragment ("... Is that okay?") arrives as its own turn and is
          // checked together with the sentence before it (stitchSplitTurn).
          console.log(
            `[MinorSafeguard] goodbye guidance already delivered for ${turn.sessionId.substring(0, 12)}...; not repeated`,
          );
        } else if (sidebandManager.getActiveConnections().includes(turn.sessionId)) {
          await sidebandManager.injectMessage(
            turn.sessionId,
            'system',
            `${REALTIME_MINOR_GUIDANCE} ${REALTIME_MINOR_SPEAK_NOW}`,
            false,
          );
          minorGoodbyeDeliveredAt.set(turn.sessionId, Date.now());
        } else {
          console.error(
            `[MinorSafeguard] no live sideband for ${turn.sessionId.substring(0, 12)}...: ` +
              'the goodbye guidance was not delivered; ending the session anyway',
          );
        }
      } catch (err) {
        console.error('[MinorSafeguard] goodbye guidance could not be delivered; ending the session anyway:', err);
      }
      await handleConfirmedMinor({
        sessionId: turn.sessionId,
        messageId: turn.messageId ?? null,
        channel: 'realtime',
        statedAge: verdict.statedAge,
      });
    } else if (verdict.isMinor && verdict.confidence === 'low' && global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'session:eligibility-review',
        {
          sessionId: turn.sessionId,
          statedAge: verdict.statedAge,
          reasoning: verdict.reasoning,
          channel: 'realtime',
          at: new Date(),
        },
        turn.sessionId,
      );
    }
  } catch (err) {
    // Fail-open: an eligibility handling error must never break the pipeline.
    console.error('[MinorSafeguard] realtime safeguard failed (fail-open):', err);
  }
}
