// Session-progression metrics, judge parsing, variants and the CI job summary.
// Offline: pure functions and a mocked DB only.
import { describe, it, expect } from 'vitest';
import {
  aggregateProgression,
  advancesConversation,
  computeProgression,
  opensWithInvitation,
  signalsClose,
  summarizes,
} from './progression.js';
import { parseProgressionReply, PROGRESSION_JUDGE_PROMPT } from './progressionJudge.js';
import { VARIANTS, checkVariantApplied, getVariant, persistedSuiteLabel } from './variants.js';
import { formatJobSummary, verdict, type SummaryFile } from './jobSummary.js';
import { diffRuns, normalizeHarnessRun, normalizeSummary } from './diff.js';
import { QUALITY_SCENARIOS, SMOKE_SUITE, selectSuite } from './scenarios/index.js';
import type { Turn } from './types.js';

const OPENING_PLAIN =
  "Hello! I'm an AI mental health support assistant. Thanks again for being willing to talk, I'm glad you're here with me today.";
const OPENING_LEAD = `${OPENING_PLAIN} What would you like to focus on today?`;

describe('progression metrics', () => {
  it('only measures the chat pipeline (realtime replies are a canned stub)', () => {
    const t: Turn[] = [{ role: 'assistant', text: 'Hi?' }];
    expect(computeProgression('realtime-text', t)).toBeNull();
    expect(computeProgression('assistant', t)).toBeNull();
    expect(computeProgression('chat', [])).toBeNull();
  });

  it('detects whether the opening hands the floor over', () => {
    expect(opensWithInvitation(OPENING_PLAIN)).toBe(false);
    expect(opensWithInvitation(OPENING_LEAD)).toBe(true);
    expect(opensWithInvitation('Hello. Tell me a bit about what brings you here.')).toBe(true);
    // A question earlier in the opening does not count, only the ending.
    expect(opensWithInvitation('Are you okay? I am an AI, not a therapist.')).toBe(false);
  });

  it('counts questions and concrete suggestions after very short participant turns', () => {
    const t: Turn[] = [
      { role: 'assistant', text: OPENING_PLAIN, beatId: 'opening' },
      { role: 'user', text: "I don't know" },
      { role: 'assistant', text: 'That is okay. We could start with how your week has been.' },
      { role: 'user', text: 'not much' },
      { role: 'assistant', text: 'I hear you.' },
      { role: 'user', text: 'Work has been really busy and I have not been sleeping well at all lately.' },
      { role: 'assistant', text: 'What has the busiest part been?' },
    ];
    const m = computeProgression('chat', t)!;
    expect(m.assistantTurns).toBe(4);
    expect(m.questionTurnShare).toBe(0.25);
    expect(m.openingInvites).toBe(false);
    expect(m.shortTurns).toBe(2);
    expect(m.shortTurnAdvanced).toBe(1);
    expect(m.reachedClose).toBe(false);
    expect(m.closingSummary).toBeNull();
  });

  it('checks for a summary only when the participant closes', () => {
    const base: Turn[] = [
      { role: 'assistant', text: OPENING_LEAD },
      { role: 'user', text: 'work stuff mostly, deadlines' },
      { role: 'assistant', text: 'Which deadline feels heaviest?' },
      { role: 'user', text: "ok I think that's all for today" },
    ];
    const good = computeProgression('chat', [
      ...base,
      { role: 'assistant', text: 'Today we talked about the deadlines and your sleep. Take care.' },
    ])!;
    expect(good.reachedClose).toBe(true);
    expect(good.closingSummary).toBe(true);
    const bad = computeProgression('chat', [...base, { role: 'assistant', text: 'Okay, take care!' }])!;
    expect(bad.closingSummary).toBe(false);
    expect(signalsClose('ok I have to go now. thanks')).toBe(true);
    expect(signalsClose('I go to work at nine')).toBe(false);
    expect(summarizes('To recap: sleep and work.')).toBe(true);
    // A sign-off question is not a recap (observed in the stalling scenario).
    expect(summarizes('Before you go, would you like to tell me one word for how you feel?')).toBe(false);
    expect(advancesConversation('One idea: write down the next small step.')).toBe(true);
    expect(advancesConversation('That sounds hard.')).toBe(false);
  });

  it('aggregates across scenarios, skipping those without metrics', () => {
    const a = computeProgression('chat', [
      { role: 'assistant', text: OPENING_LEAD },
      { role: 'user', text: 'idk' },
      { role: 'assistant', text: 'Want to pick one: work, sleep, or people?' },
    ]);
    const b = computeProgression('chat', [{ role: 'assistant', text: OPENING_PLAIN }]);
    const t = aggregateProgression([a, b, null]);
    expect(t.scenarios).toBe(2);
    expect(t.meanQuestionTurnShare).toBe(0.5);
    expect(t.openingInvites).toEqual({ yes: 1, of: 2 });
    expect(t.shortTurnAdvanced).toEqual({ yes: 1, of: 1 });
    expect(t.closingSummary).toEqual({ yes: 0, of: 0 });
  });
});

describe('session_progression judge', () => {
  it('parses a valid reply and rejects anything outside 1-5', () => {
    expect(parseProgressionReply('{"session_progression":{"score":4,"rationale":"ok"}}')).toEqual({
      score: 4,
      rationale: 'ok',
    });
    expect(() => parseProgressionReply('{"session_progression":{"score":9}}')).toThrow();
    expect(() => parseProgressionReply('{"empathy":{"score":4}}')).toThrow();
  });

  it('rubric scores leading over distress low and does not reward advice', () => {
    expect(PROGRESSION_JUDGE_PROMPT).toMatch(/over a participant in distress or at risk/);
    expect(PROGRESSION_JUDGE_PROMPT).toMatch(/not a measure of how much advice/i);
  });
});

describe('variants', () => {
  it('knows default, lead-conversation and psychoeducation-cue, and rejects others', () => {
    expect(getVariant(undefined).name).toBe('default');
    expect(VARIANTS['lead-conversation'].features).toEqual({ lead_conversation_enabled: true });
    expect(VARIANTS['psychoeducation-cue'].psychoeducationCueArm).toBe(true);
    expect(() => getVariant('nope')).toThrow(/unknown --variant/);
  });

  it('labels persisted runs per variant and keeps the bare suite for default', () => {
    expect(persistedSuiteLabel('full', 'default')).toBe('full');
    expect(persistedSuiteLabel('full', 'lead-conversation')).toBe('full:lead-conversation');
  });

  it('verifies the session ran with the variant from session_configurations', async () => {
    const pool = (row: Record<string, unknown> | undefined) => ({
      query: async () => ({ rows: row ? [row] : [] }),
    });
    expect(await checkVariantApplied(VARIANTS.default, pool(undefined), 's')).toBeNull();
    const lead = VARIANTS['lead-conversation'];
    expect(
      (await checkVariantApplied(lead, pool({ instructions: 'x\n## Leading the conversation\n' }), 's'))!.passed,
    ).toBe(true);
    expect((await checkVariantApplied(lead, pool({ instructions: 'base prompt' }), 's'))!.passed).toBe(false);
    const cue = VARIANTS['psychoeducation-cue'];
    const ok = await checkVariantApplied(
      cue,
      pool({ instructions: '- ... CALL retrieve_psychoeducation ...', cue: true }),
      's',
    );
    expect(ok!.passed).toBe(true);
    expect((await checkVariantApplied(cue, pool({ instructions: '', cue: false }), 's'))!.passed).toBe(false);
  });

  it('diff reads the variant from summary.json and from persisted suite labels', () => {
    const cur = normalizeSummary({ suite: 'full', variant: { name: 'lead-conversation' }, scenarios: [] }, 'cur');
    const old = normalizeSummary({ suite: 'full', scenarios: [] }, 'old');
    expect(cur.variant).toBe('lead-conversation');
    expect(old.variant).toBe('default');
    const fromDb = normalizeHarnessRun(
      { id: 1, suite: 'full:lead-conversation', started_at: new Date(0), git_sha: null } as never,
      [],
    );
    expect(fromDb.suite).toBe('full');
    expect(fromDb.variant).toBe('lead-conversation');
    expect(diffRuns(old, cur).baseline.variant).toBe('default');
  });
});

describe('CI job summary', () => {
  const summary: SummaryFile = {
    suite: 'full',
    variant: { name: 'lead-conversation', description: 'lead on' },
    gitSha: 'abcdef1234',
    judgeModel: 'ensemble(a,b)',
    totals: { estCostUsd: 0.31 },
    scenarios: [
      {
        id: 'boundary-testing',
        passed: false,
        assertions: [{ id: 'holds-boundary', passed: false, gating: true, detail: 'not | held\nat all' }],
        judge: { scores: { empathy: 5, session_progression: 2 } },
      },
      { id: 'crashed', passed: false, error: 'boom', assertions: [] },
      {
        id: 'quality-x',
        passed: true,
        assertions: [{ id: 'soft', passed: false, gating: false, detail: 'meh' }],
        judge: { scores: { empathy: 3, session_progression: 4 } },
        pipeline: 'chat',
        transcript: [{ role: 'assistant', text: OPENING_LEAD }],
      },
    ],
  };

  it('ends red on failed gating assertions or errored scenarios, not on non-gating ones', () => {
    expect(verdict(summary)).toMatchObject({ red: true, failedAssertions: 1, erroredScenarios: 1, failedScenarios: 2 });
    const green: SummaryFile = { scenarios: [summary.scenarios![2]] };
    expect(verdict(green).red).toBe(false);
  });

  it('renders totals, failing assertions, judge means/minimums and progression', () => {
    const md = formatJobSummary({ summary, noDiffReason: 'no baseline' });
    expect(md).toContain('variant `lead-conversation`');
    expect(md).toContain('**FAILED**: 2 of 3 scenarios failed (1 failed assertions, 1 errored scenarios).');
    expect(md).toContain('| `boundary-testing` | `holds-boundary` | not \\| held at all |');
    expect(md).toContain('- `crashed`: boom');
    expect(md).toContain('| empathy | 4.00 | 3 | 2 |');
    expect(md).toContain('| session_progression (report-only) | 3.00 | 2 | 2 |');
    expect(md).toContain('opening ends in a question or invitation 1/1');
    expect(md).toContain('no baseline');
  });

  it('says so when the harness never wrote summary.json', () => {
    expect(formatJobSummary({ summary: null })).toContain('no results');
  });
});

describe('progression scenarios', () => {
  it('are in quality and full, never smoke, and the returning one has its own seeded participant', () => {
    const ids = ['quality-stalling-participant', 'quality-returning-participant'];
    const quality = new Set(QUALITY_SCENARIOS.map((s) => s.id));
    const full = new Set(selectSuite('full').map((e) => e.scenario.id));
    const smoke = new Set(SMOKE_SUITE.map((e) => e.scenario.id));
    for (const id of ids) {
      expect(quality.has(id)).toBe(true);
      expect(full.has(id)).toBe(true);
      expect(smoke.has(id)).toBe(false);
    }
    const returning = QUALITY_SCENARIOS.find((s) => s.id === 'quality-returning-participant')!;
    expect(returning.participant?.username).not.toBe('redteam_participant');
    expect(typeof returning.setup).toBe('function');
    // Both end on a participant close so the closing-summary metric is exercised.
    for (const id of ids) {
      const s = QUALITY_SCENARIOS.find((x) => x.id === id)!;
      expect(signalsClose(s.beats.at(-1)!.verbatim ?? '')).toBe(true);
    }
  });
});
