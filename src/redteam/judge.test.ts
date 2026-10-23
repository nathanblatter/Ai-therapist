// Judge-floor gating policy (eval spec G4): floors always gate safety
// scenarios; on quality scenarios only with --gate-quality. Offline.
import { describe, it, expect } from 'vitest';
import { buildFloorAssertions, floorIsGating } from './judge.js';
import { QUALITY_SCENARIOS, SAFETY_SCENARIOS } from './scenarios/index.js';

const quality = QUALITY_SCENARIOS[0];
const safety = SAFETY_SCENARIOS.find((s) => s.judgeMinScores && Object.keys(s.judgeMinScores).length > 0)!;

describe('floorIsGating', () => {
  it('gates safety scenarios regardless of the flag', () => {
    expect(floorIsGating(safety, { gateQuality: false })).toBe(true);
    expect(floorIsGating(safety, { gateQuality: true })).toBe(true);
  });
  it('gates quality scenarios only with --gate-quality', () => {
    expect(floorIsGating(quality, { gateQuality: false })).toBe(false);
    expect(floorIsGating(quality, { gateQuality: true })).toBe(true);
  });
});

describe('buildFloorAssertions', () => {
  it('emits one judge-floor assertion per declared floor, failing below the floor', () => {
    const floors = Object.entries(quality.judgeMinScores ?? {});
    expect(floors.length).toBeGreaterThan(0);
    const [dim, floor] = floors[0] as [string, number];
    const scores = Object.fromEntries(floors.map(([d, f]) => [d, f])) as Record<string, number>; // exactly at floor
    scores[dim] = floor - 1; // one breach

    const { breaches, floorAssertions } = buildFloorAssertions(quality, scores, false);

    expect(floorAssertions).toHaveLength(floors.length);
    expect(breaches).toEqual([{ dimension: dim, score: floor - 1, floor }]);
    const failing = floorAssertions.find((a) => a.id === `judge-floor:${dim}`)!;
    expect(failing.passed).toBe(false);
    expect(failing.gating).toBe(false); // quality + no --gate-quality: visible, not gating
    expect(failing.detail).toBe(`${dim}=${floor - 1} (floor ${floor})`);
    for (const a of floorAssertions.filter((a) => a.id !== failing.id)) expect(a.passed).toBe(true);
  });

  it('marks an unscored dimension as failed with a clear detail', () => {
    const [dim, floor] = Object.entries(safety.judgeMinScores ?? {})[0] as [string, number];
    const { breaches, floorAssertions } = buildFloorAssertions(safety, {}, true);
    expect(breaches).toEqual([]); // no numeric score to report
    expect(floorAssertions.find((a) => a.id === `judge-floor:${dim}`)).toMatchObject({
      passed: false,
      gating: true,
      detail: `${dim} not scored (floor ${floor})`,
    });
  });
});
