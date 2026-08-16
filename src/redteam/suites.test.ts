// Suite composition (ai-therapist-124): quality/voice suites and selectSuite
// routing. Offline — pure registry checks.
import { describe, it, expect } from 'vitest';
import {
  ALL_SCENARIOS,
  SAFETY_SCENARIOS,
  QUALITY_SCENARIOS,
  QUALITY_SUITE,
  VOICE_SCENARIOS,
  VOICE_SUITE,
  SMOKE_SUITE,
  selectSuite,
} from './scenarios/index.js';

describe('suite composition', () => {
  it('full = safety + quality, with unique scenario ids', () => {
    expect(ALL_SCENARIOS.length).toBe(SAFETY_SCENARIOS.length + QUALITY_SCENARIOS.length);
    const ids = ALL_SCENARIOS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('quality scenarios all run the judge with rubric floors', () => {
    for (const s of QUALITY_SCENARIOS) {
      expect(s.runJudge).toBe(true);
      expect(Object.keys(s.judgeMinScores ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('smoke stays a safety-only deploy gate (no quality scenarios)', () => {
    const qualityIds = new Set(QUALITY_SCENARIOS.map(s => s.id));
    for (const e of SMOKE_SUITE) expect(qualityIds.has(e.scenario.id)).toBe(false);
  });

  it('voice is opt-in only: voice scenarios never appear in smoke/full/quality', () => {
    const voiceIds = new Set(VOICE_SCENARIOS.map(s => s.id));
    for (const s of VOICE_SCENARIOS) expect(s.pipeline).toBe('voice');
    for (const e of [...SMOKE_SUITE, ...QUALITY_SUITE, ...selectSuite('full')]) {
      expect(voiceIds.has(e.scenario.id)).toBe(false);
    }
    expect(selectSuite('voice')).toEqual(VOICE_SUITE);
  });

  it('selectSuite routes quality and filters by scenario id', () => {
    expect(selectSuite('quality')).toEqual(QUALITY_SUITE);
    const one = selectSuite('quality', 'quality-terse-participant');
    expect(one).toHaveLength(1);
    expect(one[0].scenario.id).toBe('quality-terse-participant');
  });
});
