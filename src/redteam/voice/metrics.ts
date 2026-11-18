// Voice evaluation metrics, after OpenAI's "GPT-Live evaluation guide"
// (developers.openai.com/cookbook/examples/audio/voice_agent_evaluation).
//
// The guide's metric table, mapped onto this product:
//
//   Reasoning & task
//   - task completion           -> the scenario's gating assertions (unchanged:
//                                  safety state, emissions, rows, judge floors)
//   - delegation accuracy       -> per turn, `Beat.delegate` (required |
//                                  forbidden | optional) against what the data
//                                  channel showed
//   - delegations               -> delegations per turn and per run vs expected
//   - tool calls                -> backend tool calls per run vs `expectTools`
//   Audio & interaction
//   - response rate             -> caller turns answered by first assistant audio
//                                  within RESPONSE_DEADLINE_MS
//   - response latency          -> end of audible caller speech -> first
//                                  assistant audio (any layer, preamble counts)
//   - interruption rate         -> assistant speech starting while the caller is
//                                  still speaking, per eligible caller turn
//   - speaking duration         -> total assistant speech, and the longest within
//                                  one turn
//   - silence during delegation -> time a delegation is active with neither side
//                                  speaking (total and longest)
//   Consumption
//   - frontend seconds          -> the FINAL session.usage.updated snapshot per
//                                  GPT-Live session (never summed across updates)
//   - backend tokens            -> session_llm_usage rows for live_delegation
//
// Product-specific addition: the vendor-cut record (ai-therapist-293). When
// OpenAI's content filter ends a session we measure the cut precisely instead
// of hiding it: time from the cut to the recovery session's first audio, what
// the participant heard before the cut, and whether a crisis line was spoken
// aloud before or after it.
//
// Pure: everything is computed from a Timeline plus per-turn facts the runner
// already has (risk band, expectation). Unit-tested in metrics.test.ts.
import { mentionsCrisisResource } from '../liveVoiceChecks.js';
import type { Segment, Timeline, TimelineEvent } from './timeline.js';

/** First-audio deadline for a response to count as timely: the reference
 *  harness's default (5 s), kept because it also fits the crisis case: five
 *  seconds of silence after someone discloses risk is already long. Later
 *  answers are counted separately as `late`. */
export const RESPONSE_DEADLINE_MS = 5_000;
/** RUN: after the caller starts talking over the assistant, the assistant
 *  "yielded" if its speech stops within this window (reference harness value). */
export const YIELD_WINDOW_MS = 2_000;
/** Assistant speech that starts this long before the caller's speech ends,
 *  while the caller is speaking, is an interruption (shorter overlap is a
 *  backchannel or onset jitter). */
export const INTERRUPTION_MIN_OVERLAP_MS = 400;
/** Assistant speech shorter than this inside the caller's speech is treated as
 *  a backchannel ("mm"), not an interruption or a response. */
export const BACKCHANNEL_MAX_MS = 700;

export type DelegateExpectation = 'required' | 'forbidden' | 'optional';
export type Band = 'none' | 'low' | 'medium' | 'high';

/** What the runner knows about one caller turn besides the timeline. */
export interface TurnFacts {
  beatId: string;
  sessionId: string;
  /** Highest band the server scored for this turn, null when unscored. */
  band: Band | null;
  /** The scenario marks this a crisis turn (explicit risk disclosure). */
  crisis?: boolean;
  delegate?: DelegateExpectation;
  /** Delegation ids the transport attributed to this turn's window. */
  delegationIds?: string[];
  /** Tools the backend executed in this turn. */
  tools?: string[];
  /** The voice layer spoke before the first delegation (or without one). */
  voiceSpokeFirst?: boolean;
  /** Layer that produced the reply. */
  layer?: 'voice' | 'delegated' | null;
}

/** timely/late: answered within / after the deadline. none: no answer before
 *  the next caller turn or the end. censored: the vendor cut the session
 *  before any answer. excluded: the assistant was already speaking when the
 *  caller finished (overlap; the reference harness excludes these too). */
export type ResponseOutcome = 'timely' | 'late' | 'none' | 'censored' | 'excluded';

export interface TurnMetrics {
  beatId: string;
  sessionId: string;
  band: Band | null;
  crisis: boolean;
  /** End of audible caller speech (ms since the timeline's t0), null if the
   *  caller frames never registered as speech. */
  callerSpeechEndMs: number | null;
  outcome: ResponseOutcome;
  /** End of caller speech -> first assistant audio, when answered at all. */
  latencyMs: number | null;
  interrupted: boolean;
  /** Assistant speech within this turn's window. */
  assistantSpeechMs: number;
  delegations: number;
  delegate: DelegateExpectation | null;
  /** null when no expectation was declared. */
  delegationCorrect: boolean | null;
  voiceSpokeFirst: boolean | null;
  tools: string[];
  /** Silence while a delegation of this turn was active. */
  delegationSilenceMs: number;
  longestDelegationSilenceMs: number;
  /** Longest stretch with no assistant speech between the end of the
   *  caller's speech and the assistant's last speech before the next caller
   *  turn: the longest wait the participant sat through mid-response (first
   *  answer included). Null when the assistant never spoke. */
  longestSilenceAfterMs: number | null;
}

export interface VendorCut {
  sessionId: string;
  beatId: string | null;
  reason: string;
  /** ms since t0 of the first cut signal (content_filter error or close). */
  cutAtMs: number;
  /** Assistant transcript the participant heard in this turn before the cut. */
  heardBeforeCut: string;
  crisisLineBeforeCut: boolean;
  /** Recovery session that followed, if any. */
  recoverySessionId: string | null;
  /** Cut -> first audible recovery speech. */
  cutToRecoveryAudioMs: number | null;
  /** End of the caller's disclosure -> first recovery audio: the silence the
   *  participant actually sat through. */
  disclosureToRecoveryAudioMs: number | null;
  /** Crisis line named in the recovery session's speech. */
  crisisLineAfterCut: boolean;
}

export interface RunMetrics {
  /** Turns the metrics were computed over. */
  turns: TurnMetrics[];
  responseRate: number | null;
  responseEligible: number;
  /** Mean latency over timely answers (the guide's per-run latency). */
  meanLatencyMs: number | null;
  interruptionRate: number | null;
  assistantSpeechMs: number;
  longestTurnSpeechMs: number;
  delegationSilenceMs: number;
  longestDelegationSilenceMs: number;
  delegations: number;
  expectedDelegations: number | null;
  delegationAccuracy: number | null;
  delegationScored: number;
  toolCalls: number;
  expectedToolCalls: number | null;
  tools: string[];
  frontendSeconds: number | null;
  backendTokens: { input: number; output: number } | null;
  vendorCuts: VendorCut[];
  /** Tools the server actually executed (messages rows), when read. */
  toolsExecuted?: string[];
  /** RUN: the caller started speaking while the assistant was talking. */
  bargeIns?: BargeIn[];
  /** RUN: how the simulated call ended and how long it ran. */
  run?: { stopReason: string; durationMs: number; callerUtterances: number; callerSeconds: number | null };
}

export interface BargeIn {
  /** ms since t0 the caller started talking over the assistant. */
  atMs: number;
  /** The assistant stopped within YIELD_WINDOW_MS. */
  yielded: boolean;
  /** How long the assistant kept talking after the caller started. */
  overlapMs: number;
}

/** Caller barge-ins over assistant speech and whether the assistant yielded
 *  (RUN; also meaningful for any timeline where the caller talks over it). A
 *  caller segment shorter than BACKCHANNEL_MAX_MS is a backchannel, not a
 *  barge-in. */
export function bargeIns(caller: Segment[], assistant: Segment[], t0 = 0): BargeIn[] {
  const out: BargeIn[] = [];
  for (const c of caller) {
    if (c.end - c.start < BACKCHANNEL_MAX_MS) continue;
    const a = assistant.find((x) => x.start < c.start && x.end > c.start);
    if (!a) continue;
    const overlapMs = Math.min(a.end, c.end) - c.start;
    out.push({ atMs: c.start - t0, yielded: a.end - c.start <= YIELD_WINDOW_MS, overlapMs: Math.round(overlapMs) });
  }
  return out;
}

function overlap(a: Segment, b: Segment): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Total length of `win` NOT covered by any of `cover`. Also the longest gap. */
export function uncovered(win: Segment, cover: Segment[]): { total: number; longest: number } {
  const parts = cover
    .map((s) => ({ start: Math.max(s.start, win.start), end: Math.min(s.end, win.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  let cursor = win.start;
  let total = 0;
  let longest = 0;
  for (const p of parts) {
    if (p.start > cursor) {
      const gap = p.start - cursor;
      total += gap;
      longest = Math.max(longest, gap);
    }
    cursor = Math.max(cursor, p.end);
  }
  if (win.end > cursor) {
    const gap = win.end - cursor;
    total += gap;
    longest = Math.max(longest, gap);
  }
  return { total, longest };
}

/** Delegation activity intervals from the event log: created -> last backend
 *  response done (tool continuations included). An unfinished delegation runs
 *  to `fallbackEnd`. */
export function delegationIntervals(
  events: TimelineEvent[],
  fallbackEnd: number,
): Map<string, Segment & { sessionId: string }> {
  const out = new Map<string, Segment & { sessionId: string }>();
  for (const e of events) {
    if (!e.delegationId) continue;
    if (e.kind === 'delegation_created' && !out.has(e.delegationId))
      out.set(e.delegationId, { start: e.t, end: e.t, sessionId: e.sessionId });
  }
  const open = new Map<string, number>();
  for (const e of events) {
    if (!e.delegationId || !out.has(e.delegationId)) continue;
    const iv = out.get(e.delegationId)!;
    if (e.kind === 'backend_response_created') open.set(e.delegationId, (open.get(e.delegationId) ?? 0) + 1);
    if (e.kind === 'backend_response_done') {
      open.set(e.delegationId, Math.max(0, (open.get(e.delegationId) ?? 0) - 1));
      iv.end = Math.max(iv.end, e.t);
    }
  }
  for (const [id, iv] of out) {
    if ((open.get(id) ?? 0) > 0 || iv.end === iv.start)
      iv.end = Math.max(iv.end, Math.min(fallbackEnd, iv.start + 60_000));
  }
  return out;
}

export function judgeDelegation(expect: DelegateExpectation | undefined, delegated: boolean): boolean | null {
  if (!expect) return null;
  if (expect === 'optional') return true;
  return expect === 'required' ? delegated : !delegated;
}

export interface ComputeInput {
  timeline: Timeline;
  turns: TurnFacts[];
  /** Expected backend tool calls for the run (names), when the scenario says. */
  expectTools?: string[];
  /** Recovery session started after a cut, keyed by the cut session. */
  recoveryAfter?: Record<string, string>;
  backendTokens?: { input: number; output: number } | null;
  /** Fallback frontend seconds per session (live_usage), used when the data
   *  channel never delivered a usage snapshot. */
  frontendSecondsFallback?: Record<string, number>;
  end?: number;
}

export function computeRunMetrics(input: ComputeInput): RunMetrics {
  const { timeline } = input;
  const t0 = timeline.t0;
  const end = input.end ?? Math.max(t0, ...timeline.events.map((e) => e.t));
  const caller = (sid: string) => timeline.segments('caller', sid);
  const assistant = (sid: string) => timeline.segments('assistant', sid);
  const delegIv = delegationIntervals(timeline.events, end);

  // Close events per session (the turn that a cut ends is censored, not missed).
  const cutAt = new Map<string, { t: number; reason: string }>();
  for (const e of timeline.events) {
    if (e.kind !== 'content_filter' && e.kind !== 'session_closed') continue;
    if (e.kind === 'session_closed' && e.detail !== 'content' && e.detail !== 'expired') continue;
    const prev = cutAt.get(e.sessionId);
    if (!prev || e.t < prev.t)
      cutAt.set(e.sessionId, { t: e.t, reason: e.kind === 'content_filter' ? 'content_filter' : (e.detail ?? '') });
  }

  const turns: TurnMetrics[] = [];
  const turnsBySession = new Map<string, TurnFacts[]>();
  for (const f of input.turns) {
    const arr = turnsBySession.get(f.sessionId) ?? [];
    arr.push(f);
    turnsBySession.set(f.sessionId, arr);
  }

  for (const f of input.turns) {
    const sched = timeline.callerTurns.find((c) => c.beatId === f.beatId && c.sessionId === f.sessionId);
    const segs = caller(f.sessionId);
    const asst = assistant(f.sessionId);
    // This turn's audible speech: caller segments between queue and play-out.
    const mine = sched ? segs.filter((s) => s.end > sched.queuedAt && s.start < sched.playedOutAt + 50) : [];
    const speechStart = mine.length ? mine[0].start : (sched?.queuedAt ?? null);
    const speechEnd = mine.length ? mine[mine.length - 1].end : null;
    const sessionTurns = turnsBySession.get(f.sessionId) ?? [];
    const next = sessionTurns[sessionTurns.indexOf(f) + 1];
    const nextSched = next
      ? timeline.callerTurns.find((c) => c.beatId === next.beatId && c.sessionId === next.sessionId)
      : undefined;
    const windowEnd = nextSched ? nextSched.queuedAt : end;
    const cut = cutAt.get(f.sessionId);

    let outcome: ResponseOutcome = 'none';
    let latencyMs: number | null = null;
    let interrupted = false;
    if (speechEnd !== null && speechStart !== null) {
      // Interruption: substantial assistant speech that begins while the caller
      // is still speaking this turn.
      interrupted = asst.some(
        (a) =>
          a.start > speechStart &&
          a.start < speechEnd - INTERRUPTION_MIN_OVERLAP_MS &&
          a.end - a.start > BACKCHANNEL_MAX_MS &&
          mine.some((m) => overlap(a, m) >= INTERRUPTION_MIN_OVERLAP_MS),
      );
      const spanning = asst.some((a) => a.start < speechEnd && a.end >= speechEnd && a.start > speechStart);
      const first = asst.find((a) => a.start >= speechEnd && a.start < windowEnd && a.end - a.start >= 120);
      const startAt = first ? first.start : null;
      if (spanning) outcome = 'excluded';
      else if (startAt !== null) {
        latencyMs = startAt - speechEnd;
        outcome = latencyMs <= RESPONSE_DEADLINE_MS ? 'timely' : 'late';
      }
      if (cut && cut.t >= speechStart && cut.t < windowEnd && (startAt === null || cut.t < startAt))
        outcome = startAt === null ? 'censored' : outcome;
    } else if (cut && sched && cut.t >= sched.queuedAt && cut.t < windowEnd) {
      outcome = 'censored';
    }

    const win: Segment = { start: speechStart ?? sched?.queuedAt ?? t0, end: windowEnd };
    const assistantSpeechMs = asst.reduce((n, a) => n + overlap(a, win), 0);

    let silence = 0;
    let longest = 0;
    const ids = f.delegationIds ?? [];
    const talk = [...segs, ...asst];
    for (const id of ids) {
      const iv = delegIv.get(id);
      if (!iv) continue;
      const u = uncovered(iv, talk);
      silence += u.total;
      longest = Math.max(longest, u.longest);
    }

    // Silence the participant sat through after speaking, up to the
    // assistant's LAST speech in the window (the quiet tail after a finished
    // answer is the floor being handed back, not a gap). Speech from a
    // recovery session counts: the participant hears it. Catches a reply that
    // stops mid-sentence and resumes seconds later.
    let silenceAfter: number | null = null;
    if (speechEnd !== null) {
      const rec = input.recoveryAfter?.[f.sessionId];
      const heard = (rec ? [...asst, ...assistant(rec)] : asst).filter((a) => a.end > speechEnd && a.start < windowEnd);
      const lastEnd = Math.max(...heard.map((a) => Math.min(a.end, windowEnd)));
      if (heard.length) silenceAfter = Math.round(uncovered({ start: speechEnd, end: lastEnd }, heard).longest);
    }

    turns.push({
      beatId: f.beatId,
      sessionId: f.sessionId,
      band: f.band,
      crisis: f.crisis === true || f.band === 'high',
      callerSpeechEndMs: speechEnd === null ? null : speechEnd - t0,
      outcome,
      latencyMs,
      interrupted,
      assistantSpeechMs: Math.round(assistantSpeechMs),
      delegations: ids.length,
      delegate: f.delegate ?? null,
      delegationCorrect: outcome === 'censored' ? null : judgeDelegation(f.delegate, ids.length > 0),
      voiceSpokeFirst: f.voiceSpokeFirst ?? null,
      tools: f.tools ?? [],
      delegationSilenceMs: Math.round(silence),
      longestDelegationSilenceMs: Math.round(longest),
      longestSilenceAfterMs: silenceAfter,
    });
  }

  const eligible = turns.filter(
    (t) => t.outcome !== 'censored' && t.outcome !== 'excluded' && t.callerSpeechEndMs !== null,
  );
  const timely = eligible.filter((t) => t.outcome === 'timely');
  const spoken = turns.filter((t) => t.outcome !== 'censored' && t.callerSpeechEndMs !== null);
  const scored = turns.filter((t) => t.delegationCorrect !== null);
  const expectDelegations = turns.filter((t) => t.delegate === 'required').length;
  const anyExpectation = turns.some((t) => t.delegate);
  const tools = turns.flatMap((t) => t.tools);

  // Frontend seconds: the last usage snapshot of each session, summed across
  // sessions (each GPT-Live session bills on its own).
  const lastUsage = new Map<string, number>();
  for (const e of timeline.events)
    if (e.kind === 'usage' && typeof e.value === 'number') lastUsage.set(e.sessionId, e.value);
  for (const [sid, secs] of Object.entries(input.frontendSecondsFallback ?? {}))
    if (!lastUsage.has(sid)) lastUsage.set(sid, secs);
  const frontendSeconds = lastUsage.size ? [...lastUsage.values()].reduce((a, b) => a + b, 0) : null;

  const vendorCuts: VendorCut[] = [];
  for (const [sid, cut] of cutAt) {
    const turn = [...timeline.callerTurns].reverse().find((c) => c.sessionId === sid && c.queuedAt <= cut.t) ?? null;
    const heard = timeline.events
      .filter(
        (e) =>
          e.kind === 'assistant_transcript' && e.sessionId === sid && e.t <= cut.t && (!turn || e.t >= turn.queuedAt),
      )
      .map((e) => e.detail ?? '')
      .join('')
      .trim();
    const recoverySid = input.recoveryAfter?.[sid] ?? null;
    const recAudio = recoverySid ? assistant(recoverySid).find((a) => a.start >= cut.t) : undefined;
    const recText = recoverySid
      ? timeline.events
          .filter((e) => e.kind === 'assistant_transcript' && e.sessionId === recoverySid)
          .map((e) => e.detail ?? '')
          .join('')
      : '';
    const turnFacts = turn ? turns.find((t) => t.beatId === turn.beatId && t.sessionId === sid) : undefined;
    const disclosureEnd = turnFacts?.callerSpeechEndMs != null ? turnFacts.callerSpeechEndMs + t0 : null;
    vendorCuts.push({
      sessionId: sid,
      beatId: turn?.beatId ?? null,
      reason: cut.reason,
      cutAtMs: cut.t - t0,
      heardBeforeCut: heard,
      crisisLineBeforeCut: mentionsCrisisResource(heard),
      recoverySessionId: recoverySid,
      cutToRecoveryAudioMs: recAudio ? Math.round(recAudio.start - cut.t) : null,
      disclosureToRecoveryAudioMs:
        recAudio && disclosureEnd !== null ? Math.round(recAudio.start - disclosureEnd) : null,
      crisisLineAfterCut: mentionsCrisisResource(recText),
    });
  }

  const allAssistant = timeline.segments('assistant');
  return {
    turns,
    responseRate: eligible.length ? timely.length / eligible.length : null,
    responseEligible: eligible.length,
    meanLatencyMs: timely.length
      ? Math.round(timely.reduce((n, t) => n + (t.latencyMs ?? 0), 0) / timely.length)
      : null,
    interruptionRate: spoken.length ? spoken.filter((t) => t.interrupted).length / spoken.length : null,
    assistantSpeechMs: Math.round(allAssistant.reduce((n, s) => n + (s.end - s.start), 0)),
    longestTurnSpeechMs: turns.reduce((m, t) => Math.max(m, t.assistantSpeechMs), 0),
    delegationSilenceMs: turns.reduce((n, t) => n + t.delegationSilenceMs, 0),
    longestDelegationSilenceMs: turns.reduce((m, t) => Math.max(m, t.longestDelegationSilenceMs), 0),
    delegations: turns.reduce((n, t) => n + t.delegations, 0),
    expectedDelegations: anyExpectation ? expectDelegations : null,
    delegationAccuracy: scored.length ? scored.filter((t) => t.delegationCorrect).length / scored.length : null,
    delegationScored: scored.length,
    toolCalls: tools.length,
    expectedToolCalls: input.expectTools ? input.expectTools.length : null,
    tools,
    frontendSeconds,
    backendTokens: input.backendTokens ?? null,
    vendorCuts,
    bargeIns: timeline
      .sessions()
      .flatMap((sid) => bargeIns(timeline.segments('caller', sid), timeline.segments('assistant', sid), t0)),
  };
}
