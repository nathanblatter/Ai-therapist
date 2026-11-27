// A run's results must say which yes/no judge answered each assertion:
// summary.json, the JUnit file and the GitHub job summary. Offline.
import { describe, expect, it } from 'vitest';
import { buildJUnit, buildSummaryJson, type RunSummary } from './report.js';
import { formatJobSummary, type SummaryFile } from './jobSummary.js';
import {
  dedupePairs,
  judgedAssertionIds,
  pairsFor,
  summarise,
  type JudgedPair,
  type JudgePair,
} from './judgeAgreement.js';
import type { AssertionResult, AssertionSpec, ScenarioResult } from './types.js';

const assertions: AssertionResult[] = [
  { id: 'regex-only', passed: true, gating: true, detail: 'matched' },
  { id: 'by-decisions', passed: true, gating: true, detail: 'held ([decisions p=0.03 no])', judge: 'decisions' },
  { id: 'by-llm', passed: false, gating: true, detail: 'breach ([3/3 yes] quoted)', judge: 'llm' },
  {
    id: 'fell-back',
    passed: false,
    gating: true,
    detail: 'breach ([decisions refused; llm answered] [2/3 yes] quoted)',
    judge: 'llm-fallback',
    judgeFallback: 'refused',
  },
];

const scenario: ScenarioResult = {
  id: 'boundary-testing',
  title: 'boundary-testing',
  pipeline: 'chat',
  variation: 0,
  passed: false,
  assertions,
  judge: null,
  costUsd: 0,
  durationMs: 1000,
};

const run: RunSummary = {
  startedAt: '2026-11-27T08:00:00Z',
  finishedAt: '2026-11-27T08:10:00Z',
  suite: 'full',
  seed: 42,
  judgeModel: 'gpt-4o-mini',
  yesNoJudge: 'auto',
  scenarios: [scenario],
};

describe('summary.json', () => {
  const json = buildSummaryJson(run) as unknown as SummaryFile & {
    totals: { yesNoJudges: Record<string, unknown> };
  };

  it('records the run-wide mode and a tally of who answered', () => {
    expect(json.yesNoJudge).toBe('auto');
    expect(json.totals.yesNoJudges).toEqual({
      judged: 3,
      llm: 1,
      decisions: 1,
      llmFallback: 1,
      mixed: 0,
      fallbackReasons: { refused: 1 },
    });
  });

  it('keeps the judge on each assertion, and none where no judge was asked', () => {
    const out = json.scenarios![0].assertions!;
    expect(out.map((a) => a.judge)).toEqual([undefined, 'decisions', 'llm', 'llm-fallback']);
    expect(out[3].judgeFallback).toBe('refused');
  });

  it('a summary without the mode is reported as auto', () => {
    expect((buildSummaryJson({ ...run, yesNoJudge: undefined }) as { yesNoJudge: string }).yesNoJudge).toBe('auto');
  });
});

describe('JUnit', () => {
  const xml = buildJUnit(run);

  it('a judged case carries the judge as a property, passing or failing', () => {
    expect(xml).toContain(
      '    <testcase classname="boundary-testing" name="by-decisions">\n' +
        '      <properties>\n        <property name="judge" value="decisions"/>\n      </properties>\n' +
        '    </testcase>',
    );
    expect(xml).toMatch(
      /name="by-llm">\n\s+<properties>\n\s+<property name="judge" value="llm"\/>\n\s+<\/properties>\n\s+<failure/,
    );
    expect(xml).toContain('<property name="judge-fallback" value="refused"/>');
  });

  it('a case no judge answered is unchanged', () => {
    expect(xml).toContain('    <testcase classname="boundary-testing" name="regex-only"/>');
  });
});

describe('job summary', () => {
  const md = formatJobSummary({ summary: buildSummaryJson(run) as SummaryFile });

  it('says which judge answered across the run', () => {
    expect(md).toContain(
      'Yes/no judge (`auto`): 3 judged assertions: LLM 1, Decisions 1, LLM after Decisions gave no answer 1 (refused 1).',
    );
  });

  it('tags each failing assertion with its judge', () => {
    expect(md).toContain('| `boundary-testing` | `by-llm` | [judge: llm] breach');
    expect(md).toContain('| `boundary-testing` | `fell-back` | [judge: llm-fallback, Decisions refused] breach');
  });

  it('an older summary is described as LLM-judged, not left blank', () => {
    const old = buildSummaryJson(run) as SummaryFile;
    delete old.yesNoJudge;
    expect(formatJobSummary({ summary: old })).toContain('this summary predates the judge record');
  });
});

describe('judge agreement tool', () => {
  const pair = (over: Partial<JudgePair> = {}): JudgePair => ({
    source: 'fixture',
    origin: 'test',
    assertionId: 'a',
    name: 'n',
    version: 'r.v1',
    question: 'q',
    text: 't',
    votes: 3,
    expected: true,
    ...over,
  });
  const judged = (over: Partial<JudgedPair>): JudgedPair => ({
    ...pair(),
    llm: [{ verdict: true, yes: 3 }],
    decisions: [{ probability: 0.99 }],
    ...over,
  });
  const band = (p: number) => p > 0.2 && p < 0.8;

  it('recovers the question and the verdict a fixture requires', async () => {
    const mustBeNo: AssertionSpec = {
      id: 'no-x',
      run: async (ctx) => {
        const r = await ctx.classify({ version: 'no-x.v1', question: 'Does it X?', text: ctx.latestReply, votes: 3 });
        return { id: 'no-x', passed: !r.verdict, detail: '', gating: true };
      },
    };
    const ctx = {
      scenarioId: 's',
      sessionId: 's',
      latestReply: 'the reply',
      transcript: [],
      emissions: [],
      beatPostTimes: {},
      systemPromptCanaries: [],
      pool: { query: async () => ({ rows: [] }) },
      dryRun: false,
    };
    const meta = { source: 'fixture' as const, origin: 'test', name: 'n' };
    const passing = await pairsFor(mustBeNo, ctx, meta, true);
    expect(passing).toHaveLength(1);
    expect(passing[0]).toMatchObject({ version: 'no-x.v1', text: 'the reply', votes: 3, expected: false });
    expect((await pairsFor(mustBeNo, ctx, meta, false))[0].expected).toBe(true);
    expect((await pairsFor(mustBeNo, ctx, meta, null))[0].expected).toBeNull();
  });

  it('an assertion a regex decides yields no pair, and one that throws yields none either', async () => {
    const regex: AssertionSpec = { id: 'r', run: async () => ({ id: 'r', passed: true, detail: '', gating: true }) };
    const throws: AssertionSpec = {
      id: 't',
      run: async () => {
        throw new Error('needs a database');
      },
    };
    const ctx = {
      scenarioId: 's',
      sessionId: 's',
      latestReply: '',
      transcript: [],
      emissions: [],
      beatPostTimes: {},
      systemPromptCanaries: [],
      pool: { query: async () => ({ rows: [] }) },
      dryRun: false,
    };
    const meta = { source: 'run' as const, origin: 'test', name: 'n' };
    expect(await pairsFor(regex, ctx, meta, true)).toEqual([]);
    expect(await pairsFor(throws, ctx, meta, null)).toEqual([]);
  });

  it('replays only the recorded assertions a judge answered', () => {
    const ids = judgedAssertionIds({
      id: 's',
      assertions: [
        { id: 'db-row', detail: 'crisis_flagged=true' },
        { id: 'llm-judged', detail: 'held ([0/3 yes] quoted)' },
        { id: 'decisions-judged', detail: 'held ([decisions p=0.02 no])' },
        { id: 'probe' },
      ],
    });
    expect([...ids]).toEqual(['llm-judged', 'decisions-judged']);
  });

  it('dedupes on question and text, keeping the labelled copy', () => {
    const out = dedupePairs([
      pair({ expected: null, source: 'run' }),
      pair({ expected: false }),
      pair({ text: 'other' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].expected).toBe(false);
  });

  it('counts agreement, correctness, refusals, unsure answers and flips per rubric', () => {
    const [a] = summarise(
      [
        judged({}),
        judged({ decisions: [{ probability: 0.01 }] }), // disagrees with the LLM and the label
        judged({ expected: false, llm: [{ verdict: true, yes: 2 }], decisions: [{ probability: 0.05 }] }), // LLM wrong
        judged({ decisions: [{ unknown: 'refused' }] }),
        judged({ decisions: [{ probability: 0.5 }] }),
        judged({ decisions: [{ unknown: 'error: 503' }] }),
        judged({
          expected: null,
          llm: [
            { verdict: true, yes: 2 },
            { verdict: false, yes: 1 },
          ],
        }),
        judged({ expected: null, decisions: [{ probability: 0.9 }, { probability: 0.1 }] }),
      ],
      band,
    );
    expect(a).toEqual({
      version: 'r.v1',
      n: 8,
      definite: 5,
      refused: 1,
      unsure: 1,
      errors: 1,
      agree: 3,
      labelled: 6,
      llmRight: 5,
      decisionsLabelled: 3,
      decisionsRight: 2,
      llmFlips: 1,
      decisionsFlips: 1,
    });
  });
});
