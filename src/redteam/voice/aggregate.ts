// Repeat aggregation for the GPT-Live evaluation metrics.
//
// OpenAI's "GPT-Live evaluation guide": voice models are nondeterministic, so
// run representative scenarios several times and report P50 and P90 of the
// per-run latency and duration metrics alongside task-completion rates and
// sample counts. The per-run latency is a mean over timely answers, so its
// percentiles are percentiles of run means, not of individual responses.
//
// The clinical breakdown is ours: a participant who has just disclosed risk
// and waits in silence is a harm, so latency and silence-during-delegation are
// ALSO pooled per turn (every turn of every run) by risk band and for crisis
// turns, where the unit is the individual response. Both views carry n.
import type { RunMetrics, TurnMetrics } from './metrics.js';

export interface Pct {
  n: number;
  p50: number | null;
  p90: number | null;
}

/** Linear-interpolated percentile over the non-null values. */
export function pct(values: Array<number | null | undefined>): Pct {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  const at = (q: number): number | null => {
    if (xs.length === 0) return null;
    const pos = (xs.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return Math.round((xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)) * 1000) / 1000;
  };
  return { n: xs.length, p50: at(0.5), p90: at(0.9) };
}

export interface ScenarioRunLike {
  id: string;
  passed: boolean;
  error?: string;
  voiceMetrics?: RunMetrics | null;
}

export interface ScenarioAggregate {
  scenario: string;
  runs: number;
  passed: number;
  errored: number;
  meanLatencyMs: Pct;
  responseRate: Pct;
  interruptionRate: Pct;
  assistantSpeechMs: Pct;
  longestTurnSpeechMs: Pct;
  delegationSilenceMs: Pct;
  longestDelegationSilenceMs: Pct;
  delegations: Pct;
  toolCalls: Pct;
  delegationAccuracy: Pct;
  frontendSeconds: Pct;
  backendTokens: Pct;
}

export interface TurnPool {
  latencyMs: Pct;
  delegationSilenceMs: Pct;
  longestDelegationSilenceMs: Pct;
  /** Longest silence after the participant spoke (all turns). */
  longestSilenceAfterMs: Pct;
  /** Turns by outcome. */
  outcomes: Record<string, number>;
}

export interface VoiceAggregate {
  scenarios: ScenarioAggregate[];
  /** Pooled over every turn of every run. */
  turns: {
    all: TurnPool;
    crisis: TurnPool;
    byBand: Record<string, TurnPool>;
  };
  delegation: { scored: number; correct: number; accuracy: number | null };
  vendorCuts: {
    count: number;
    cutToRecoveryAudioMs: Pct;
    disclosureToRecoveryAudioMs: Pct;
    crisisLineBeforeCut: number;
    crisisLineAfterCut: number;
  };
  bargeIns: { count: number; yielded: number };
}

export const baseScenarioId = (id: string): string => id.replace(/#v\d+$/, '');

function pool(turns: TurnMetrics[]): TurnPool {
  const outcomes: Record<string, number> = {};
  for (const t of turns) outcomes[t.outcome] = (outcomes[t.outcome] ?? 0) + 1;
  const delegated = turns.filter((t) => t.delegations > 0);
  return {
    latencyMs: pct(turns.map((t) => t.latencyMs)),
    delegationSilenceMs: pct(delegated.map((t) => t.delegationSilenceMs)),
    longestDelegationSilenceMs: pct(delegated.map((t) => t.longestDelegationSilenceMs)),
    longestSilenceAfterMs: pct(turns.map((t) => t.longestSilenceAfterMs)),
    outcomes,
  };
}

export function aggregateVoice(runs: ScenarioRunLike[]): VoiceAggregate | null {
  const withMetrics = runs.filter((r) => r.voiceMetrics);
  if (withMetrics.length === 0) return null;
  const groups = new Map<string, ScenarioRunLike[]>();
  for (const r of runs) {
    const k = baseScenarioId(r.id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const scenarios: ScenarioAggregate[] = [];
  for (const [scenario, rs] of groups) {
    const ms = rs.map((r) => r.voiceMetrics).filter((m): m is RunMetrics => !!m);
    if (ms.length === 0) continue;
    scenarios.push({
      scenario,
      runs: rs.length,
      passed: rs.filter((r) => r.passed).length,
      errored: rs.filter((r) => r.error).length,
      meanLatencyMs: pct(ms.map((m) => m.meanLatencyMs)),
      responseRate: pct(ms.map((m) => m.responseRate)),
      interruptionRate: pct(ms.map((m) => m.interruptionRate)),
      assistantSpeechMs: pct(ms.map((m) => m.assistantSpeechMs)),
      longestTurnSpeechMs: pct(ms.map((m) => m.longestTurnSpeechMs)),
      delegationSilenceMs: pct(ms.map((m) => m.delegationSilenceMs)),
      longestDelegationSilenceMs: pct(ms.map((m) => m.longestDelegationSilenceMs)),
      delegations: pct(ms.map((m) => m.delegations)),
      toolCalls: pct(ms.map((m) => m.toolCalls)),
      delegationAccuracy: pct(ms.map((m) => m.delegationAccuracy)),
      frontendSeconds: pct(ms.map((m) => m.frontendSeconds)),
      backendTokens: pct(ms.map((m) => (m.backendTokens ? m.backendTokens.input + m.backendTokens.output : null))),
    });
  }
  const allMetrics = withMetrics.map((r) => r.voiceMetrics!);
  const turns = allMetrics.flatMap((m) => m.turns);
  const byBand: Record<string, TurnPool> = {};
  for (const band of ['none', 'low', 'medium', 'high', 'unscored']) {
    const ts = turns.filter((t) => (t.band ?? 'unscored') === band);
    if (ts.length) byBand[band] = pool(ts);
  }
  const scored = turns.filter((t) => t.delegationCorrect !== null);
  const cuts = allMetrics.flatMap((m) => m.vendorCuts);
  const barge = allMetrics.flatMap((m) => m.bargeIns ?? []);
  return {
    scenarios,
    turns: { all: pool(turns), crisis: pool(turns.filter((t) => t.crisis)), byBand },
    delegation: {
      scored: scored.length,
      correct: scored.filter((t) => t.delegationCorrect).length,
      accuracy: scored.length ? scored.filter((t) => t.delegationCorrect).length / scored.length : null,
    },
    vendorCuts: {
      count: cuts.length,
      cutToRecoveryAudioMs: pct(cuts.map((c) => c.cutToRecoveryAudioMs)),
      disclosureToRecoveryAudioMs: pct(cuts.map((c) => c.disclosureToRecoveryAudioMs)),
      crisisLineBeforeCut: cuts.filter((c) => c.crisisLineBeforeCut).length,
      crisisLineAfterCut: cuts.filter((c) => c.crisisLineAfterCut).length,
    },
    bargeIns: { count: barge.length, yielded: barge.filter((b) => b.yielded).length },
  };
}

function fmtMs(p: Pct): string {
  if (p.n === 0 || p.p50 === null) return 'n/a (n=0)';
  return `${(p.p50 / 1000).toFixed(2)} / ${((p.p90 ?? p.p50) / 1000).toFixed(2)} s (n=${p.n})`;
}

function fmtRate(p: Pct): string {
  if (p.n === 0 || p.p50 === null) return 'n/a';
  return `${Math.round(p.p50 * 100)}% / ${Math.round((p.p90 ?? p.p50) * 100)}%`;
}

function fmtNum(p: Pct, digits = 0): string {
  if (p.n === 0 || p.p50 === null) return 'n/a';
  return `${p.p50.toFixed(digits)} / ${(p.p90 ?? p.p50).toFixed(digits)}`;
}

/** Markdown section for the job summary (voiceSummary.ts). */
export function formatVoiceAggregate(a: VoiceAggregate): string {
  const out: string[] = [];
  out.push('### Voice interaction metrics (GPT-Live evaluation guide)');
  out.push('');
  out.push(
    'P50 / P90 across repeats with sample counts. Latency = end of audible participant speech to first ' +
      'assistant audio. Silence during delegation = time the backend was working with neither side speaking.',
  );
  out.push('');
  const row = (label: string, p: TurnPool) =>
    `| ${label} | ${fmtMs(p.latencyMs)} | ${fmtMs(p.delegationSilenceMs)} | ${fmtMs(p.longestDelegationSilenceMs)} | ` +
    `${fmtMs(p.longestSilenceAfterMs)} | ` +
    `${Object.entries(p.outcomes)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')} |`;
  out.push(
    '| Turns | Response latency | Silence during delegation (per turn) | Longest silent stretch in delegation | Longest silence after the participant spoke | Outcomes |',
  );
  out.push('|---|---|---|---|---|---|');
  out.push(row('all', a.turns.all));
  out.push(row('**crisis turns**', a.turns.crisis));
  for (const [band, p] of Object.entries(a.turns.byBand)) out.push(row(`risk ${band}`, p));
  out.push('');
  out.push(
    `Delegation accuracy: ${a.delegation.accuracy === null ? 'n/a' : `${Math.round(a.delegation.accuracy * 100)}%`} ` +
      `(${a.delegation.correct}/${a.delegation.scored} turns with an expectation).` +
      (a.bargeIns.count
        ? ` Participant barge-ins: ${a.bargeIns.count}, assistant yielded on ${a.bargeIns.yielded}.`
        : ''),
  );
  if (a.vendorCuts.count) {
    out.push('');
    out.push(
      `Vendor content-filter cuts: ${a.vendorCuts.count}. Cut to first recovery audio ${fmtMs(a.vendorCuts.cutToRecoveryAudioMs)}; ` +
        `participant's last words to first recovery audio ${fmtMs(a.vendorCuts.disclosureToRecoveryAudioMs)}. ` +
        `Crisis line spoken before the cut in ${a.vendorCuts.crisisLineBeforeCut}, by the recovery in ${a.vendorCuts.crisisLineAfterCut}.`,
    );
  }
  out.push('');
  out.push(
    '| Scenario | Runs (pass) | Mean latency | Response rate | Interruptions | Speech total | Delegation silence | Delegations | Tools | Deleg. accuracy | Frontend s | Backend tokens |',
  );
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of a.scenarios)
    out.push(
      `| ${s.scenario} | ${s.runs} (${s.passed}) | ${fmtMs(s.meanLatencyMs)} | ${fmtRate(s.responseRate)} | ` +
        `${fmtRate(s.interruptionRate)} | ${fmtMs(s.assistantSpeechMs)} | ${fmtMs(s.delegationSilenceMs)} | ` +
        `${fmtNum(s.delegations)} | ${fmtNum(s.toolCalls)} | ${fmtRate(s.delegationAccuracy)} | ` +
        `${fmtNum(s.frontendSeconds)} | ${fmtNum(s.backendTokens)} |`,
    );
  return out.join('\n') + '\n';
}
