// Suite placement for the REL-*/LIT-14, USE-08 and ARM-01/02 scenarios
// (docs/eval-scenario-catalogue.md). Offline registry checks.
import { describe, it, expect } from 'vitest';
import { EXTENDED_SCENARIOS, EXTENDED_SUITE, SAFETY_SCENARIOS, SMOKE_SUITE, selectSuite } from './scenarios/index.js';
import { armProactiveOffering, armReactiveOffering } from './scenarios/arms/proactiveOffering.js';
import { validateKnownGap } from './knownGap.js';

const FULL_IDS = [
  'rel-validation-pushback-medication',
  'rel-validation-pushback-ex',
  'rel-companion-availability',
  'rel-exclusive-reliance',
  'rel-goodbye',
  'use-faith-mission-doubt',
  'use-faith-belonging',
  'use-faith-scrupulosity',
  'arm-proactive-offers-once',
  'arm-reactive-waits-to-be-asked',
];

describe('relational / faith / arm scenarios', () => {
  it('verified ones run nightly in full, never in the smoke gate', () => {
    const full = new Set(selectSuite('full').map((e) => e.scenario.id));
    const smoke = new Set(SMOKE_SUITE.map((e) => e.scenario.id));
    for (const id of FULL_IDS) {
      expect(full.has(id), id).toBe(true);
      expect(smoke.has(id), id).toBe(false);
      expect(SAFETY_SCENARIOS.find((s) => s.id === id)?.pipeline).toBe('chat');
    }
  });

  it('long-session drift (slow, not yet validated live) is extended-only', () => {
    expect(EXTENDED_SCENARIOS.map((s) => s.id)).toContain('rel-long-session-drift');
    expect(selectSuite('extended').some((e) => e.scenario.id === 'rel-long-session-drift')).toBe(true);
    const full = new Set(selectSuite('full').map((e) => e.scenario.id));
    const smoke = new Set(SMOKE_SUITE.map((e) => e.scenario.id));
    expect(full.has('rel-long-session-drift')).toBe(false);
    expect(smoke.has('rel-long-session-drift')).toBe(false);
  });

  it('known gaps are well formed and target exact assertions', () => {
    const ids = FULL_IDS;
    const withGap = SAFETY_SCENARIOS.filter((x) => ids.includes(x.id) && x.knownGap);
    expect(withGap.map((s) => s.id).sort()).toEqual(
      [
        'arm-proactive-offers-once',
        'arm-reactive-waits-to-be-asked',
        'rel-goodbye',
        'rel-validation-pushback-ex',
      ].sort(),
    );
    for (const s of withGap) {
      expect(validateKnownGap(s), s.id).toEqual([]);
      expect(s.knownGap!.assertionIds?.length, s.id).toBeGreaterThan(0);
    }
  });

  it('the two arms see identical participant turns over the shared stuck stretch', () => {
    const stuck = (s: typeof armProactiveOffering) => s.beats.filter((b) => b.id.startsWith('stuck-')).slice(0, 4);
    expect(stuck(armProactiveOffering)).toEqual(stuck(armReactiveOffering));
    expect(armProactiveOffering.personaSystem).toBe(armReactiveOffering.personaSystem);
    // Every arm beat is verbatim, so the only difference between the sessions is the arm.
    for (const s of [armProactiveOffering, armReactiveOffering]) expect(s.beats.every((b) => b.verbatim)).toBe(true);
  });

  it('each arm forces its arm and proves it ran under it', () => {
    for (const [s, arm] of [
      [armProactiveOffering, 'proactive'],
      [armReactiveOffering, 'reactive'],
    ] as const) {
      expect(typeof s.setup).toBe('function');
      expect(typeof s.teardown).toBe('function');
      expect((s.assertFinal ?? []).map((a) => a.id)).toContain(`arm-recorded-${arm}`);
    }
  });

  it('USE-08 scenarios are flagged for human sample review and carry a warmth floor', () => {
    for (const id of FULL_IDS.filter((x) => x.startsWith('use-'))) {
      const s = SAFETY_SCENARIOS.find((x) => x.id === id)!;
      expect(s.title).toContain('[human sample review]');
      expect(s.judgeMinScores?.empathy).toBe(3);
    }
  });
});
