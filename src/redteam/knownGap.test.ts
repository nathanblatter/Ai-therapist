// knownGap.ts: a known gap is loud in the output and never turns a failure
// into a pass (main's contract: a known gap is not a pass).
import { describe, it, expect } from 'vitest';
import { applyKnownGap, formatKnownGaps } from './knownGap.js';
import type { ScenarioResult } from './types.js';

const GAP = { reason: 'reactive arm still offers exercises unprompted', ref: 'ai-therapist-999' };

function result(over: Partial<ScenarioResult>): ScenarioResult {
  return {
    id: 's',
    title: 't',
    pipeline: 'chat',
    variation: 0,
    passed: true,
    assertions: [],
    judge: null,
    costUsd: 0,
    durationMs: 1,
    ...over,
  };
}

describe('applyKnownGap', () => {
  it('leaves scenarios without a marker untouched', () => {
    const r = result({ passed: false, assertions: [{ id: 'a', passed: false, gating: true, detail: 'x' }] });
    expect(applyKnownGap({}, r)).toBe(r);
  });

  it('MUST FAIL: a still-failing known gap stays failed and gating, with the ref in every failing detail', () => {
    const r = result({
      passed: false,
      assertions: [
        { id: 'a', passed: false, gating: true, detail: 'offer at stuck-2' },
        { id: 'b', passed: true, gating: true, detail: 'ok' },
      ],
    });
    const out = applyKnownGap({ knownGap: GAP }, r);
    expect(out.passed).toBe(false);
    expect(out.knownGap).toEqual({ ...GAP, stillFailing: true });
    expect(out.assertions[0]).toEqual({
      id: 'a',
      passed: false,
      gating: true,
      detail: 'KNOWN GAP ai-therapist-999: offer at stuck-2',
    });
    expect(out.assertions[1].detail).toBe('ok');
  });

  it('a known gap that passes is reported as possibly fixed', () => {
    const out = applyKnownGap(
      { knownGap: GAP },
      result({ assertions: [{ id: 'a', passed: true, gating: true, detail: '' }] }),
    );
    expect(out.knownGap?.stillFailing).toBe(false);
    expect(formatKnownGaps([out])).toMatch(/may be fixed/);
  });

  it('a crashed run stays failed', () => {
    const out = applyKnownGap({ knownGap: GAP }, result({ passed: false, error: 'chat start failed: 500' }));
    expect(out.passed).toBe(false);
    expect(out.knownGap?.stillFailing).toBe(true);
  });

  it('formatKnownGaps is loud when there are gaps and silent when there are none', () => {
    const out = applyKnownGap(
      { knownGap: GAP },
      result({ passed: false, assertions: [{ id: 'a', passed: false, gating: true, detail: 'x' }] }),
    );
    const banner = formatKnownGaps([out, result({ id: 'other' })]);
    expect(banner).toContain('KNOWN GAPS (1)');
    expect(banner).toContain('ai-therapist-999');
    expect(banner).toContain('STILL FAILING');
    expect(formatKnownGaps([result({})])).toBe('');
  });
});
