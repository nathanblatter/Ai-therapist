// Suite placement for the REL-*/LIT-14, USE-08 and ARM-01/02 scenarios
// (docs/eval-scenario-catalogue.md). Offline registry checks.
import { describe, it, expect } from 'vitest';
import {
  EXTENDED_SCENARIOS,
  EXTENDED_SUITE,
  PENDING_LIVE_VERIFICATION,
  SAFETY_SCENARIOS,
  SMOKE_SUITE,
  selectSuite,
} from './scenarios/index.js';
import { armProactiveOffering, armReactiveOffering } from './scenarios/arms/proactiveOffering.js';

const FULL_IDS = ['arm-proactive-offers-once', 'arm-reactive-waits-to-be-asked'];
const PENDING_IDS = [
  'rel-validation-pushback-medication',
  'rel-validation-pushback-ex',
  'rel-companion-availability',
  'rel-exclusive-reliance',
  'rel-goodbye',
  'use-faith-mission-doubt',
  'use-faith-belonging',
  'use-honor-code-scrupulosity',
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

  it('long-session drift and the not-yet-live-verified ones are extended-only', () => {
    expect(PENDING_LIVE_VERIFICATION.map((s) => s.id)).toEqual(PENDING_IDS);
    expect(EXTENDED_SUITE.map((e) => e.scenario.id)).toEqual(['rel-long-session-drift', ...PENDING_IDS]);
    expect(selectSuite('extended')).toEqual(EXTENDED_SUITE);
    const full = new Set(selectSuite('full').map((e) => e.scenario.id));
    const smoke = new Set(SMOKE_SUITE.map((e) => e.scenario.id));
    for (const s of EXTENDED_SCENARIOS) {
      expect(full.has(s.id), s.id).toBe(false);
      expect(smoke.has(s.id), s.id).toBe(false);
      expect(s.pipeline).toBe('chat');
    }
  });

  it('known gaps name a tracking ref and a reason', () => {
    for (const s of [...SAFETY_SCENARIOS, ...EXTENDED_SCENARIOS].filter((x) => x.knownGap)) {
      expect(s.knownGap!.ref, s.id).toMatch(/^ai-therapist-\d+$/);
      expect(s.knownGap!.reason.length, s.id).toBeGreaterThan(20);
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
    for (const id of PENDING_IDS.filter((x) => x.startsWith('use-'))) {
      const s = EXTENDED_SCENARIOS.find((x) => x.id === id)!;
      expect(s.title).toContain('[human sample review]');
      expect(s.judgeMinScores?.empathy).toBe(3);
    }
  });
});
