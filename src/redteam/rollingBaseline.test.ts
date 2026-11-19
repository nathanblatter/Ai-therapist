// Rolling baseline (rollingBaseline.ts) and the diff on a sampled night: each
// scenario is compared with its own most recent prior result, and scenarios
// that were not scheduled tonight are neither "missing" nor regressions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffRuns, formatDiffMarkdown, normalizeSummary, type SummaryJsonLike } from './diff.js';
import {
  baseScenarioId,
  lastRunById,
  loadRollingBaseline,
  mergeRolling,
  rollingFromSummary,
  rollingToNormalized,
  ROLLING_BASELINE_FILE,
} from './rollingBaseline.js';

type S = NonNullable<SummaryJsonLike['scenarios']>[number];
const pass = (id: string, judge = 5): S => ({
  id,
  passed: true,
  assertions: [{ id: 'safe', passed: true, gating: true }],
  judge: { scores: { empathy: judge } },
});
const fail = (id: string): S => ({
  id,
  passed: false,
  assertions: [{ id: 'safe', passed: false, gating: true, detail: 'unsafe reply' }],
  judge: { scores: { empathy: 5 } },
});
const night = (date: string, scenarios: S[]): SummaryJsonLike => ({
  suite: 'full',
  variant: { name: 'default' },
  startedAt: `${date}T17:00:00.000Z`,
  gitSha: `sha-${date}`,
  scenarios,
});

const SUITE = new Set(['a', 'b', 'c', 'd']);

/** Three sampled nights: Mon runs a+b, Tue runs c+d, Wed runs a+c. */
function chain() {
  const mon = mergeRolling(null, normalizeSummary(night('2026-11-16', [pass('a'), pass('b')]), 'mon'), SUITE);
  const tue = mergeRolling(mon, normalizeSummary(night('2026-11-17', [pass('c'), pass('d', 4)]), 'tue'), SUITE);
  return { mon, tue };
}

describe('mergeRolling', () => {
  it('keeps every scenario at its most recent result with the night it ran', () => {
    const { tue } = chain();
    expect(Object.keys(tue.scenarios).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(tue.scenarios.a.ranAt).toBe('2026-11-16T17:00:00.000Z');
    expect(tue.scenarios.d.ranAt).toBe('2026-11-17T17:00:00.000Z');
    expect(tue.scenarios.d.gitSha).toBe('sha-2026-11-17');
    expect(lastRunById(tue)).toEqual({
      a: '2026-11-16T17:00:00.000Z',
      b: '2026-11-16T17:00:00.000Z',
      c: '2026-11-17T17:00:00.000Z',
      d: '2026-11-17T17:00:00.000Z',
    });
  });

  it('prunes scenarios that left the suite and never mixes variants or suites', () => {
    const { tue } = chain();
    const wed = mergeRolling(tue, normalizeSummary(night('2026-11-18', [pass('a')]), 'wed'), new Set(['a', 'c']));
    expect(Object.keys(wed.scenarios).sort()).toEqual(['a', 'c']);
    const lead = normalizeSummary({ ...night('2026-11-18', [pass('a')]), variant: { name: 'lead-conversation' } }, 'x');
    expect(Object.keys(mergeRolling(tue, lead, SUITE).scenarios)).toEqual(['a']);
  });

  it('variation labels map back to their scenario', () => {
    expect(baseScenarioId('crisis-ladder#v2')).toBe('crisis-ladder');
    expect(baseScenarioId('crisis-ladder')).toBe('crisis-ladder');
  });
});

describe('diff on a sampled night', () => {
  it('compares each scenario with its own most recent prior result', () => {
    const { tue } = chain();
    // Wednesday runs a (last run Monday) and d (last run Tuesday): a regresses,
    // d's judge drops. b and c were not scheduled.
    const wed = normalizeSummary(night('2026-11-18', [fail('a'), pass('d', 2)]), 'wed');
    const diff = diffRuns(rollingToNormalized(tue, 'prev/rolling-baseline.json'), wed, undefined, {
      notRunByDesign: (label) => SUITE.has(baseScenarioId(label)),
    });
    expect(diff.newlyFailing.map((f) => f.scenario)).toEqual(['a']); // Monday's result, not "new"
    expect(diff.judgeDrops.map((j) => [j.scenario, j.before, j.after])).toEqual([['d', 4, 2]]);
    expect(diff.newScenarios).toEqual([]);
    expect(diff.missingScenarios).toEqual([]);
    expect(diff.notSampled?.sort()).toEqual(['b', 'c']);
    expect(diff.hasRegressions).toBe(true);
    const md = formatDiffMarkdown(diff);
    expect(md).toContain('2 scenario result(s) in the baseline were not scheduled tonight');
    expect(md).not.toContain('not run this time');
  });

  it('a clean sampled night reports no regressions and no missing scenarios', () => {
    const { tue } = chain();
    const wed = normalizeSummary(night('2026-11-18', [pass('b')]), 'wed');
    const diff = diffRuns(rollingToNormalized(tue, 'r'), wed, undefined, {
      notRunByDesign: (label) => SUITE.has(baseScenarioId(label)),
    });
    expect(diff.hasRegressions).toBe(false);
    expect(diff.missingScenarios).toEqual([]);
    expect(diff.notSampled?.length).toBe(3);
  });

  it('a scenario that left the suite still shows as missing, and a brand-new one as new', () => {
    const { tue } = chain();
    const wed = normalizeSummary(night('2026-11-18', [pass('e')]), 'wed');
    const suiteNow = new Set(['a', 'b', 'c', 'e']); // d retired, e added
    const diff = diffRuns(rollingToNormalized(tue, 'r'), wed, undefined, {
      notRunByDesign: (label) => suiteNow.has(baseScenarioId(label)),
    });
    expect(diff.missingScenarios).toEqual(['d']);
    expect(diff.newScenarios).toEqual(['e']);
  });

  it('the naive previous-night baseline would have lost the comparison (why the rolling file exists)', () => {
    const tueOnly = normalizeSummary(night('2026-11-17', [pass('c'), pass('d')]), 'tue');
    const wed = normalizeSummary(night('2026-11-18', [fail('a')]), 'wed');
    const diff = diffRuns(tueOnly, wed);
    expect(diff.newlyFailing).toEqual([]); // a reads as "new", its regression unseen
    expect(diff.newScenarios).toEqual(['a']);
  });
});

describe('loadRollingBaseline', () => {
  it('prefers rolling-baseline.json next to summary.json and falls back to summary.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-rolling-'));
    try {
      const summaryPath = path.join(dir, 'summary.json');
      fs.writeFileSync(summaryPath, JSON.stringify(night('2026-11-17', [pass('c')])));
      expect(Object.keys(loadRollingBaseline(summaryPath)!.rolling.scenarios)).toEqual(['c']);
      const { tue } = chain();
      fs.writeFileSync(path.join(dir, ROLLING_BASELINE_FILE), JSON.stringify(tue));
      const loaded = loadRollingBaseline(summaryPath)!;
      expect(loaded.file).toBe(path.join(dir, ROLLING_BASELINE_FILE));
      expect(Object.keys(loaded.rolling.scenarios).sort()).toEqual(['a', 'b', 'c', 'd']);
      expect(loadRollingBaseline(path.join(dir, 'nope', 'summary.json'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a summary.json-only baseline keeps the old behaviour (every scenario from that run)', () => {
    const r = rollingFromSummary(night('2026-11-17', [pass('c'), fail('d')]));
    expect(r.scenarios.d.passed).toBe(false);
    expect(r.scenarios.c.ranAt).toBe('2026-11-17T17:00:00.000Z');
  });
});
