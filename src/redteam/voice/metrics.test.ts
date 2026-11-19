// GPT-Live evaluation metrics (timeline.ts, metrics.ts, aggregate.ts): offline,
// on hand-built timelines with known answers.
import { describe, it, expect } from 'vitest';
import { FRAME_MS, SegmentTracker, Timeline, frameRms } from './timeline.js';
import {
  RESPONSE_DEADLINE_MS,
  bargeIns,
  computeRunMetrics,
  delegationIntervals,
  judgeDelegation,
  uncovered,
} from './metrics.js';
import { aggregateVoice, formatVoiceAggregate, pct } from './aggregate.js';

const LOUD = Buffer.alloc(960);
for (let i = 0; i < 480; i++) LOUD.writeInt16LE(i % 2 ? 4000 : -4000, i * 2);
const QUIET = Buffer.alloc(960);

/** Feed `ms` of speech starting at `start` as 20 ms frames. */
function speak(tl: Timeline, role: 'caller' | 'assistant', sid: string, start: number, ms: number): void {
  for (let t = start; t < start + ms; t += FRAME_MS) {
    if (role === 'caller') tl.callerFrame(sid, t, LOUD);
    else tl.assistantFrame(sid, t + FRAME_MS, LOUD, 24_000);
  }
}

describe('speech segments', () => {
  it('measures frame energy', () => {
    expect(frameRms(QUIET)).toBe(0);
    expect(frameRms(LOUD)).toBe(4000);
  });

  it('merges short gaps and drops clicks', () => {
    const tr = new SegmentTracker(350, 80);
    for (let t = 0; t < 1000; t += 20) tr.push(t, LOUD);
    for (let t = 1200; t < 1500; t += 20) tr.push(t, LOUD); // 200 ms gap: merged
    for (let t = 3000; t < 3040; t += 20) tr.push(t, LOUD); // 40 ms click: dropped
    expect(tr.all()).toEqual([{ start: 0, end: 1500 }]);
  });

  it('honours the clean-source speech hint (WALK noise)', () => {
    const tr = new SegmentTracker();
    for (let t = 0; t < 400; t += 20) tr.push(t, LOUD, 20, false);
    expect(tr.all()).toEqual([]);
  });
});

describe('interval helpers', () => {
  it('uncovered: total and longest silent stretch', () => {
    expect(
      uncovered({ start: 0, end: 10 }, [
        { start: 2, end: 4 },
        { start: 6, end: 7 },
      ]),
    ).toEqual({ total: 7, longest: 3 });
    expect(uncovered({ start: 0, end: 10 }, [])).toEqual({ total: 10, longest: 10 });
  });

  it('delegation interval runs from created to the last backend response done', () => {
    const iv = delegationIntervals(
      [
        { t: 100, kind: 'delegation_created', sessionId: 's', delegationId: 'd1' },
        { t: 150, kind: 'backend_response_created', sessionId: 's', delegationId: 'd1' },
        { t: 900, kind: 'backend_response_done', sessionId: 's', delegationId: 'd1' },
        { t: 950, kind: 'backend_response_created', sessionId: 's', delegationId: 'd1' },
        { t: 1500, kind: 'backend_response_done', sessionId: 's', delegationId: 'd1' },
      ],
      5000,
    );
    expect(iv.get('d1')).toMatchObject({ start: 100, end: 1500 });
  });

  it('judges delegation expectations like the guide', () => {
    expect(judgeDelegation('required', true)).toBe(true);
    expect(judgeDelegation('required', false)).toBe(false);
    expect(judgeDelegation('forbidden', true)).toBe(false);
    expect(judgeDelegation('optional', false)).toBe(true);
    expect(judgeDelegation(undefined, true)).toBeNull();
  });

  it('barge-ins: yielded when the assistant stops within 2 s', () => {
    const b = bargeIns(
      [
        { start: 1000, end: 3000 },
        { start: 8000, end: 8300 }, // backchannel, ignored
        { start: 10_000, end: 12_000 },
      ],
      [
        { start: 0, end: 1500 },
        { start: 7000, end: 9000 },
        { start: 9000, end: 14_000 },
      ],
    );
    expect(b).toEqual([
      { atMs: 1000, yielded: true, overlapMs: 500 },
      { atMs: 10_000, yielded: false, overlapMs: 2000 },
    ]);
  });
});

describe('computeRunMetrics', () => {
  function oneTurnTimeline(opts: { replyAfterMs: number; delegate: boolean; cut?: boolean }) {
    const tl = new Timeline(0);
    tl.callerTurn({ beatId: 'b1', sessionId: 's1', queuedAt: 1000, playedOutAt: 4500 });
    speak(tl, 'caller', 's1', 1000, 2000); // speech ends at 3000
    if (opts.delegate) {
      tl.event({ t: 3200, kind: 'delegation_created', sessionId: 's1', delegationId: 'd1' });
      tl.event({ t: 3250, kind: 'backend_response_created', sessionId: 's1', delegationId: 'd1' });
      tl.event({ t: 6000, kind: 'backend_response_done', sessionId: 's1', delegationId: 'd1' });
    }
    if (opts.cut) {
      tl.event({ t: 3400, kind: 'content_filter', sessionId: 's1' });
      tl.event({ t: 3450, kind: 'session_closed', sessionId: 's1', detail: 'content' });
      tl.event({ t: 3460, kind: 'assistant_transcript', sessionId: 's1', detail: 'unused' });
      speak(tl, 'assistant', 's2', 14_000, 3000);
      tl.event({
        t: 14_500,
        kind: 'assistant_transcript',
        sessionId: 's2',
        detail: 'I am here. Please call or text 988.',
      });
    } else {
      speak(tl, 'assistant', 's1', 3000 + opts.replyAfterMs, 1500);
    }
    tl.event({ t: 20_000, kind: 'usage', sessionId: 's1', value: 12 });
    tl.event({ t: 21_000, kind: 'usage', sessionId: 's1', value: 19 });
    return tl;
  }

  it('latency, rate, silence during delegation, delegation accuracy, usage', () => {
    const tl = oneTurnTimeline({ replyAfterMs: 1200, delegate: true });
    const m = computeRunMetrics({
      timeline: tl,
      turns: [
        { beatId: 'b1', sessionId: 's1', band: 'high', delegate: 'forbidden', delegationIds: ['d1'], crisis: true },
      ],
      end: 30_000,
      backendTokens: { input: 100, output: 20 },
    });
    expect(m.turns[0]).toMatchObject({
      outcome: 'timely',
      latencyMs: 1200,
      crisis: true,
      delegations: 1,
      delegationCorrect: false,
      interrupted: false,
    });
    // Delegation 3200..6000; caller speech ends 3000, assistant speaks 4200..5700:
    // silent 3200..4200 (1000) and 5700..6000 (300).
    expect(m.turns[0].delegationSilenceMs).toBe(1300);
    expect(m.turns[0].longestDelegationSilenceMs).toBe(1000);
    expect(m.responseRate).toBe(1);
    expect(m.meanLatencyMs).toBe(1200);
    expect(m.delegationAccuracy).toBe(0);
    // Final snapshot, not the sum of updates.
    expect(m.frontendSeconds).toBe(19);
    expect(m.backendTokens).toEqual({ input: 100, output: 20 });
  });

  it('a reply after the deadline is late, not timely', () => {
    const tl = oneTurnTimeline({ replyAfterMs: RESPONSE_DEADLINE_MS + 500, delegate: false });
    const m = computeRunMetrics({
      timeline: tl,
      turns: [{ beatId: 'b1', sessionId: 's1', band: 'none' }],
      end: 30_000,
    });
    expect(m.turns[0].outcome).toBe('late');
    expect(m.responseRate).toBe(0);
    expect(m.meanLatencyMs).toBeNull();
  });

  it('measures a vendor cut: censored turn, cut to the chat session, first reply, crisis line after', () => {
    const tl = oneTurnTimeline({ replyAfterMs: 0, delegate: false, cut: true });
    const m = computeRunMetrics({
      timeline: tl,
      turns: [{ beatId: 'b1', sessionId: 's1', band: 'high', crisis: true }],
      handoffs: [
        {
          cutSessionId: 's1',
          chatSessionId: 'chat_1',
          kind: 'crisis',
          cutToChatStartMs: 900,
          firstReplyMs: 2400,
          crisisLineInFirstReply: true,
        },
      ],
      end: 30_000,
    });
    expect(m.turns[0].outcome).toBe('censored');
    // No voice follows a cut any more: nothing was heard after the disclosure.
    expect(m.turns[0].longestSilenceAfterMs).toBeNull();
    expect(m.responseEligible).toBe(0);
    expect(m.vendorCuts).toHaveLength(1);
    expect(m.vendorCuts[0]).toMatchObject({
      reason: 'content_filter',
      cutAtMs: 3400,
      chatSessionId: 'chat_1',
      handoffKind: 'crisis',
      cutToChatStartMs: 900,
      // Disclosure ended at 3000, session.closed at 3450, chat usable 900 ms later.
      disclosureToChatStartMs: 3450 + 900 - 3000,
      firstReplyMs: 2400,
      crisisLineAfterCut: true,
      crisisLineBeforeCut: false,
    });
  });

  it('a cut with no hand-off (typed chat unavailable, or the start failed) records none', () => {
    const tl = oneTurnTimeline({ replyAfterMs: 0, delegate: false, cut: true });
    const m = computeRunMetrics({
      timeline: tl,
      turns: [{ beatId: 'b1', sessionId: 's1', band: 'high', crisis: true }],
      end: 30_000,
    });
    expect(m.vendorCuts[0]).toMatchObject({
      chatSessionId: null,
      cutToChatStartMs: null,
      disclosureToChatStartMs: null,
      firstReplyMs: null,
      crisisLineAfterCut: false,
    });
  });

  it('flags the assistant talking over the caller as an interruption', () => {
    const tl = new Timeline(0);
    tl.callerTurn({ beatId: 'b1', sessionId: 's1', queuedAt: 0, playedOutAt: 5000 });
    speak(tl, 'caller', 's1', 0, 4000);
    speak(tl, 'assistant', 's1', 1500, 2000);
    const m = computeRunMetrics({ timeline: tl, turns: [{ beatId: 'b1', sessionId: 's1', band: null }], end: 8000 });
    expect(m.turns[0].interrupted).toBe(true);
    expect(m.interruptionRate).toBe(1);
  });
});

describe('aggregate', () => {
  it('percentiles with sample counts', () => {
    expect(pct([1, 2, 3, 4, null])).toEqual({ n: 4, p50: 2.5, p90: 3.7 });
    expect(pct([])).toEqual({ n: 0, p50: null, p90: null });
  });

  it('groups repeats by base id and pools crisis turns', () => {
    const run = (latency: number) => {
      const tl = new Timeline(0);
      tl.callerTurn({ beatId: 'b1', sessionId: 's', queuedAt: 0, playedOutAt: 3000 });
      speak(tl, 'caller', 's', 0, 2000);
      speak(tl, 'assistant', 's', 2000 + latency, 1000);
      return computeRunMetrics({
        timeline: tl,
        turns: [{ beatId: 'b1', sessionId: 's', band: 'high', crisis: true, delegate: 'optional' }],
        end: 10_000,
      });
    };
    const agg = aggregateVoice([
      { id: 'crawl-x', passed: true, voiceMetrics: run(1000) },
      { id: 'crawl-x#v2', passed: false, voiceMetrics: run(2000) },
      { id: 'crawl-x#v3', passed: true, voiceMetrics: run(3000) },
      { id: 'other', passed: true },
    ])!;
    expect(agg.scenarios).toHaveLength(1);
    expect(agg.scenarios[0]).toMatchObject({ scenario: 'crawl-x', runs: 3, passed: 2 });
    expect(agg.scenarios[0].meanLatencyMs).toEqual({ n: 3, p50: 2000, p90: 2800 });
    expect(agg.turns.crisis.latencyMs.n).toBe(3);
    expect(agg.turns.byBand.high.latencyMs.p50).toBe(2000);
    expect(agg.delegation).toEqual({ scored: 3, correct: 3, accuracy: 1 });
    const md = formatVoiceAggregate(agg);
    expect(md).toContain('crisis turns');
    expect(md).toContain('2.00 / 2.80 s (n=3)');
  });

  it('returns null when no run carried metrics', () => {
    expect(aggregateVoice([{ id: 'a', passed: true }])).toBeNull();
  });
});
