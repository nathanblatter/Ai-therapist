// Known-gap policy: a filed product bug is reported loudly on every run and
// never fails the gate, and it can never hide a different failure.
import { describe, it, expect } from 'vitest';
import { applyKnownGap, collectKnownGaps, formatKnownGaps, validateKnownGap, type KnownGap } from './knownGap.js';
import type { AssertionResult, AssertionSpec, Scenario } from './types.js';

const gap: KnownGap = {
  flightdeck: 'ai-therapist-999',
  reason: 'A keyword-free statement of intent is never sent to the assessor.',
  assertionIds: ['crisis-severity-is-high@imminent'],
};

const res = (id: string, passed: boolean, gating = true): AssertionResult => ({
  id,
  passed,
  gating,
  detail: `detail of ${id}`,
});
const spec = (id: string): AssertionSpec => ({ id, run: async () => res(id, true) });

/** What cli.ts runEntry computes from the assertions. */
const gateFails = (assertions: AssertionResult[]): boolean => assertions.some((a) => !a.passed && a.gating);

describe('applyKnownGap', () => {
  it('leaves a scenario without knownGap untouched', () => {
    const assertions = [res('a', false)];
    expect(applyKnownGap({}, assertions)).toBe(assertions);
  });

  it('a failing known gap stops gating and is labelled with the reference', () => {
    const out = applyKnownGap({ knownGap: [gap] }, [
      res('crisis-severity-is-high@imminent', false),
      res('other', true),
    ]);
    expect(out[0].passed).toBe(false);
    expect(out[0].gating).toBe(false);
    expect(out[0].knownGap).toBe('ai-therapist-999');
    expect(out[0].detail).toMatch(/^KNOWN GAP ai-therapist-999: /);
    expect(gateFails(out)).toBe(false);
  });

  it('MUST STILL FAIL the gate when a different assertion in the same scenario fails', () => {
    const out = applyKnownGap({ knownGap: [gap] }, [
      res('crisis-severity-is-high@imminent', false),
      res('session-flagged-true@passive-ideation', false),
    ]);
    expect(out[1].gating).toBe(true);
    expect(out[1].knownGap).toBeUndefined();
    expect(gateFails(out)).toBe(true);
  });

  it('a known gap that passes stays gating-clean and is flagged as stale', () => {
    const out = applyKnownGap({ knownGap: [gap] }, [res('crisis-severity-is-high@imminent', true)]);
    expect(out[0].passed).toBe(true);
    expect(out[0].knownGap).toBe('ai-therapist-999');
    expect(out[0].detail).toContain('PASSED THIS RUN');
  });

  it('supports several bugs on one scenario', () => {
    const second: KnownGap = { ...gap, flightdeck: 'ai-therapist-1000', assertionIds: ['x'] };
    const out = applyKnownGap({ knownGap: [gap, second] }, [
      res('crisis-severity-is-high@imminent', false),
      res('x', false),
    ]);
    expect(out.map((a) => a.knownGap)).toEqual(['ai-therapist-999', 'ai-therapist-1000']);
  });
});

describe('collectKnownGaps / formatKnownGaps', () => {
  it('prints nothing when the run touched no known gap', () => {
    expect(formatKnownGaps(collectKnownGaps([{ id: 's', assertions: [res('a', false)] }]))).toBe('');
  });

  it('lists every failing gap with scenario, assertion, reference and evidence', () => {
    const assertions = applyKnownGap({ knownGap: [gap] }, [res('crisis-severity-is-high@imminent', false)]);
    const block = formatKnownGaps(collectKnownGaps([{ id: 'crisis-imminent-intent', assertions }]));
    expect(block).toContain('KNOWN GAPS: 1 assertion(s) FAILING');
    expect(block).toContain('crisis-imminent-intent / crisis-severity-is-high@imminent  [ai-therapist-999]');
    expect(block).toContain('detail of crisis-severity-is-high@imminent');
  });

  it('says so when a known gap passed, so the marker gets removed', () => {
    const assertions = applyKnownGap({ knownGap: [gap] }, [res('crisis-severity-is-high@imminent', true)]);
    const block = formatKnownGaps(collectKnownGaps([{ id: 'crisis-imminent-intent', assertions }]));
    expect(block).toContain('0 assertion(s) FAILING');
    expect(block).toContain('1 passed this run');
    expect(block).toContain('remove this id');
  });
});

describe('validateKnownGap', () => {
  const scenario = (knownGap: KnownGap[]): Pick<Scenario, 'id' | 'knownGap' | 'beats' | 'assertFinal'> => ({
    id: 'demo',
    knownGap,
    beats: [{ id: 'imminent', personaGoal: 'x', assertAfter: [spec('crisis-severity-is-high@imminent')] }],
    assertFinal: [spec('final-check')],
  });

  it('accepts a well-formed declaration', () => {
    expect(validateKnownGap(scenario([gap]))).toEqual([]);
    expect(validateKnownGap(scenario([{ ...gap, assertionIds: ['final-check'] }]))).toEqual([]);
  });

  it('requires a Flightdeck reference, a real reason and at least one assertion', () => {
    expect(validateKnownGap(scenario([{ ...gap, flightdeck: 'see slack' }]))).toHaveLength(1);
    expect(validateKnownGap(scenario([{ ...gap, reason: 'broken' }]))).toHaveLength(1);
    expect(validateKnownGap(scenario([{ ...gap, assertionIds: [] }]))).toHaveLength(1);
  });

  it('rejects an id the scenario does not declare (a typo would silently gate nothing)', () => {
    expect(validateKnownGap(scenario([{ ...gap, assertionIds: ['crisis-severity-is-high'] }]))).toHaveLength(1);
  });

  it('rejects judge floors, which the runner gates separately', () => {
    expect(validateKnownGap(scenario([{ ...gap, assertionIds: ['judge-floor:safety_protocol'] }]))).toHaveLength(1);
  });
});
