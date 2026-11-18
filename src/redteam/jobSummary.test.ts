// summary.json cost totals and the GitHub job summary's cost section, from a
// fixture run: the nightly must show the corrected total with its recorded /
// estimated split and caveats.
import { describe, expect, it } from 'vitest';
import { CostTracker } from './config.js';
import { buildSummaryJson, type RunSummary } from './report.js';
import { formatCost, formatJobSummary, verdict, type SummaryFile } from './jobSummary.js';
import type { ScenarioResult } from './types.js';

function result(id: string, build: (c: CostTracker) => void, extra: Partial<ScenarioResult> = {}): ScenarioResult {
  const cost = new CostTracker();
  build(cost);
  return {
    id,
    title: id,
    pipeline: 'chat',
    variation: 0,
    passed: true,
    assertions: [{ id: 'a', passed: true, gating: true, detail: 'ok' }],
    judge: null,
    costUsd: cost.usd,
    cost: cost.breakdown(),
    durationMs: 1000,
    ...extra,
  };
}

const run: RunSummary = {
  startedAt: '2026-11-18T08:00:00Z',
  finishedAt: '2026-11-18T08:30:00Z',
  suite: 'full',
  seed: 42,
  judgeModel: 'ensemble(gpt-4o-mini,gpt-5-mini)',
  scenarios: [
    result('crisis-ladder', (c) => {
      c.addRecorded('gpt-5.2', 25_800, 1_120, 'chat-reply', 4);
      c.addRecorded('gpt-5', 4_200, 3_600, 'post-session', 2);
      c.estimate('gpt-4o-mini', 4_000, 400, 'judge');
    }),
    result('medication', (c) => {
      c.addRecorded('gpt-5.2', 19_000, 800, 'chat-reply', 3);
      c.add('gpt-4o-mini', { prompt_tokens: 900, completion_tokens: 60 }, 'persona');
    }),
  ],
  costNotes: {
    appUsageRead: true,
    postSessionWaitMs: 4_000,
    estimated: ['judge: estimated from prompt length'],
    excluded: ['session naming after redaction (the app does not record its usage)'],
  },
};

describe('summary.json cost totals', () => {
  it('carries the breakdown behind estCostUsd plus its caveats', () => {
    const json = buildSummaryJson(run) as {
      totals: { estCostUsd: number; cost: Record<string, unknown> & { byCategory: Record<string, { usd: number }> } };
      scenarios: Array<{ cost: unknown }>;
    };
    const total = run.scenarios.reduce((n, s) => n + s.costUsd, 0);
    expect(json.totals.estCostUsd).toBeCloseTo(total, 6);
    expect(json.totals.cost.totalUsd).toBeCloseTo(total, 6);
    expect((json.totals.cost.recordedUsd as number) + (json.totals.cost.estimatedUsd as number)).toBeCloseTo(total, 6);
    expect(Object.keys(json.totals.cost.byCategory).sort()).toEqual(['chat-reply', 'judge', 'persona', 'post-session']);
    expect(json.totals.cost.estimated).toEqual(['judge: estimated from prompt length']);
    expect(json.scenarios[0].cost).toBeTruthy();
  });
});

describe('job summary cost section', () => {
  it('shows the corrected total, the split per category and the caveats', () => {
    const md = formatJobSummary({ summary: buildSummaryJson(run) as SummaryFile, title: 'Red-team nightly' });
    const total = run.scenarios.reduce((n, s) => n + s.costUsd, 0);
    expect(md).toContain(`cost $${total.toFixed(2)}`);
    expect(md).toContain('### Cost');
    expect(md).toMatch(/\| Chat replies \(therapy model\) \| \$\d+\.\d{4} \| \$\d+\.\d{4} \| \$0\.0000 \| 7 \|/);
    expect(md).toMatch(/\| Post-session jobs \(redaction, insights\) \|/);
    expect(md).toContain('- Estimated: judge: estimated from prompt length');
    expect(md).toContain('- Not included: session naming after redaction');
  });

  it('renders older summaries without a breakdown unchanged', () => {
    expect(formatCost({ totals: { estCostUsd: 1.23 } })).toEqual([]);
    expect(formatJobSummary({ summary: { suite: 'full', totals: { estCostUsd: 1.23 } } })).toContain('cost $1.23');
  });
});

describe('verdict and generated variants', () => {
  it('a failing non-gating generated variant does not turn the run red; a gating one does', () => {
    const base: SummaryFile = { scenarios: [{ id: 'crisis-ladder', passed: true, assertions: [] }] };
    const miss = {
      id: 'gen:crisis-ladder:paraphrase:s42',
      passed: false,
      assertions: [{ id: 'x', passed: false, gating: true }],
    };
    expect(verdict({ scenarios: [...base.scenarios!, { ...miss, generated: { gating: false } }] }).red).toBe(false);
    expect(verdict({ scenarios: [...base.scenarios!, { ...miss, generated: { gating: true } }] }).red).toBe(true);
  });
});
