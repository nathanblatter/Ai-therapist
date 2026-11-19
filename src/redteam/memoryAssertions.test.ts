// Offline tests for the memory and multi-session graders. The fixtures in
// memoryFixtures.ts carry the cases; this file runs them and checks that no
// assertion a memory scenario declares is without a case it must fail on.
import { describe, it, expect } from 'vitest';
import {
  MEMORY_DET_FIXTURES,
  MEMORY_RUBRIC_FIXTURES,
  PROMPT_WITHOUT_MEMORY,
  poolOf,
  promptWithMemory,
  rec,
  type DetCase,
} from './memoryFixtures.js';
import {
  builtForSession,
  expectedSummaryDates,
  findCanaries,
  leaksIn,
  longestSharedRun,
  memoryBlockOf,
  memoryCarriesSafetyContext,
  memoryDataLines,
  overFirstReplies,
  staffSignals,
  storedForUser,
} from './memoryAssertions.js';
import { declaredAssertions } from './multiSession.js';
import { MEMORY_SCENARIOS, MEMORY_EXTENDED_SCENARIOS } from './scenarios/memory/index.js';
import { riskHistoryPatterns } from './scenarios/memory/whatDoYouKnow.js';
import type { AssertionContext, AssertionSpec, ClassifyFn } from './types.js';

const ALL = [...MEMORY_SCENARIOS, ...MEMORY_EXTENDED_SCENARIOS];

function ctxOf(c: DetCase, classifyVerdict = false, onClassify?: () => void): AssertionContext {
  const current = c.sessions.find((s) => s.id === c.current) ?? c.sessions[c.sessions.length - 1];
  const classify: ClassifyFn = async () => {
    onClassify?.();
    return { verdict: classifyVerdict, evidence: 'mock' };
  };
  return {
    scenarioId: 'test',
    sessionId: current.sessionId,
    latestReply: current.transcript.at(-1)?.text ?? '',
    transcript: current.transcript,
    emissions: [],
    beatPostTimes: {},
    systemPromptCanaries: [],
    sessions: c.sessions,
    pool: c.pool ?? poolOf(),
    classify,
    dryRun: false,
  };
}

function specOf(scenarioId: string, assertionId: string): AssertionSpec {
  const scenario = ALL.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`no memory scenario '${scenarioId}'`);
  const spec = declaredAssertions(scenario).find((a) => a.id === assertionId);
  if (!spec) throw new Error(`${scenarioId} declares no assertion '${assertionId}'`);
  return spec;
}

describe('deterministic memory assertions against synthetic evidence', () => {
  for (const fx of MEMORY_DET_FIXTURES) {
    for (const c of fx.cases) {
      it(`${fx.assertionId}: ${c.expectPass ? 'passes' : 'FAILS'} on "${c.name}"`, async () => {
        const spec = specOf(fx.scenarioId, fx.assertionId);
        let classified = 0;
        // Whatever a classifier would say must not matter: these are
        // deterministic, and none of them may even ask.
        for (const verdict of [true, false]) {
          const r = await spec.run(ctxOf(c, verdict, () => classified++));
          expect(r.passed, r.detail).toBe(c.expectPass);
        }
        expect(classified).toBe(0);
      });
    }
  }

  it('every deterministic fixture has a passing case and a must-fail case', () => {
    for (const fx of MEMORY_DET_FIXTURES) {
      expect(
        fx.cases.some((c) => c.expectPass),
        `${fx.assertionId} needs a passing case`,
      ).toBe(true);
      expect(
        fx.cases.some((c) => !c.expectPass),
        `${fx.assertionId} needs a must-fail case`,
      ).toBe(true);
    }
  });

  it('skips in dry-run instead of failing on evidence that cannot exist offline', async () => {
    for (const fx of MEMORY_DET_FIXTURES) {
      const bad = fx.cases.find((c) => !c.expectPass)!;
      const r = await specOf(fx.scenarioId, fx.assertionId).run({ ...ctxOf(bad), dryRun: true });
      // The two that read only what /api/chat/start itself returned still run.
      if (['memory-block-absent', 'opening-discloses-ai'].includes(fx.assertionId)) continue;
      expect(r.passed, `${fx.assertionId}: ${r.detail}`).toBe(true);
      expect(r.detail).toContain('dry-run');
    }
  });
});

describe('memory rubric fixtures', () => {
  const deterministic = MEMORY_RUBRIC_FIXTURES.filter((x) => x.deterministic);
  const rubricCtx = (reply: string, classifyVerdict: boolean, onClassify?: () => void): AssertionContext =>
    ctxOf({ name: '', expectPass: true, sessions: [rec('s', { replies: [reply] })] }, classifyVerdict, onClassify);

  it('cover a must-fail and a passing reply for every rubric', () => {
    const ids = new Set(MEMORY_RUBRIC_FIXTURES.map((x) => x.assertion().id));
    for (const id of ids) {
      const mine = MEMORY_RUBRIC_FIXTURES.filter((x) => x.assertion().id === id);
      expect(
        mine.some((x) => !x.expectPass),
        `${id} needs a reply that must fail`,
      ).toBe(true);
      expect(
        mine.some((x) => x.expectPass),
        `${id} needs a reply that must pass`,
      ).toBe(true);
    }
  });

  for (const fx of deterministic) {
    const id = fx.assertion().id;
    it(`${id}: FAILS on "${fx.name}" whatever the classifier says`, async () => {
      expect(fx.expectPass).toBe(false);
      for (const verdict of [true, false]) {
        const r = await fx.assertion().run(rubricCtx(fx.reply, verdict));
        expect(r.passed, r.detail).toBe(false);
        expect(r.detail).toContain('tripwire');
      }
    });
  }

  it('the remaining fixtures reach the classifier, and its verdict decides them', async () => {
    for (const fx of MEMORY_RUBRIC_FIXTURES.filter((x) => !x.deterministic)) {
      let called = 0;
      const yes = await fx.assertion().run(rubricCtx(fx.reply, true, () => called++));
      const no = await fx.assertion().run(rubricCtx(fx.reply, false, () => called++));
      expect(called, `${fx.assertion().id} / ${fx.name}`).toBe(2);
      expect(yes.passed, `${fx.assertion().id} / ${fx.name}`).not.toBe(no.passed);
    }
  });

  it('an honest reply that says the study keeps a record is not tripped by the "nothing is stored" wire', async () => {
    const honest = MEMORY_RUBRIC_FIXTURES.find((x) => x.name.startsWith('starts fresh, and says the study'))!;
    let called = 0;
    await honest.assertion().run(rubricCtx(honest.reply, false, () => called++));
    expect(called).toBe(1);
  });
});

describe('every assertion a memory scenario declares has a must-fail fixture', () => {
  // Graders borrowed from other families, with their own fixtures and tests
  // (assertions.test.ts, relationalAssertions.test.ts, graderFixtures.ts).
  const BORROWED = new Set([
    'disclaimer-exactly-once-at-start',
    'no-medication-advice',
    'no-diagnosis',
    'no-romantic-role-play',
    'does-not-adopt-name',
    'crisis-severity-is-high',
  ]);
  const covered = new Set([
    ...MEMORY_DET_FIXTURES.filter((f) => f.cases.some((c) => !c.expectPass)).map((f) => f.assertionId),
    ...MEMORY_RUBRIC_FIXTURES.filter((f) => !f.expectPass).map((f) => f.assertion().id),
  ]);

  for (const s of ALL) {
    it(s.id, () => {
      const ids = declaredAssertions(s).map((a) => a.id);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        if (BORROWED.has(id)) continue;
        expect(covered.has(id), `${s.id}: '${id}' has no fixture it must fail on (memoryFixtures.ts)`).toBe(true);
      }
    });
  }

  it('the same assertion id means the same grader in every scenario that uses it', () => {
    // A fixture is tied to one scenario's spec; this keeps that honest for
    // the ids that scenarios share.
    const shared = ['memory-block-present', 'memory-block-absent', 'opening-discloses-ai', 'something-reached-staff'];
    for (const id of shared) {
      const users = ALL.filter((s) => declaredAssertions(s).some((a) => a.id === id));
      expect(users.length, id).toBeGreaterThan(1);
    }
  });
});

describe('memory block helpers', () => {
  const prompt = `${promptWithMemory(['- 2026-11-10 ("A"): topics: x', '- Their dog is called Rex.'])}\n\n## Today's check-in (provided by the participant just now)\n- Current mood: 2/10`;

  it('memoryBlockOf takes the block and stops at the next section', () => {
    const block = memoryBlockOf(prompt);
    expect(block.startsWith('## Returning participant')).toBe(true);
    expect(block).toContain('Their dog is called Rex.');
    expect(block).not.toContain("Today's check-in");
    expect(memoryBlockOf(PROMPT_WITHOUT_MEMORY)).toBe('');
  });

  it('memoryDataLines keeps the participant data and drops the fixed instructions', () => {
    const lines = memoryDataLines(memoryBlockOf(prompt));
    expect(lines).toEqual(['- 2026-11-10 ("A"): topics: x', '- Their dog is called Rex.']);
  });

  it('findCanaries ignores case, curly quotes and line breaks', () => {
    expect(findCanaries('the QUILLFEATHER\n bakery', ['Quillfeather bakery', 'Zephyrwick'])).toEqual([
      'Quillfeather bakery',
    ]);
    expect(findCanaries('nothing here', ['Quillfeather'])).toEqual([]);
  });

  it('leaksIn names the surface', () => {
    expect(leaksIn([{ where: 'b2: reply', text: 'Brambleknock' }], ['Brambleknock'])).toEqual([
      'b2: reply contains "Brambleknock"',
    ]);
  });

  it('longestSharedRun finds the longest verbatim run', () => {
    expect(
      longestSharedRun('I heard: started tense, ended a little calmer today', 'started tense, ended a little calmer'),
    ).toBe('started tense ended a little calmer');
    expect(longestSharedRun('completely different words', 'started tense')).toBe('');
  });

  it('expectedSummaryDates allows for a run that crosses midnight', () => {
    const now = new Date('2026-11-18T00:00:05.000Z');
    expect(expectedSummaryDates(8, now)).toEqual(['2026-11-10', '2026-11-09']);
  });

  it('memoryCarriesSafetyContext reads data lines, not the fixed text around them', () => {
    expect(memoryCarriesSafetyContext(promptWithMemory(['- 2026-11-10: topics: suicidal thoughts']))).toBe(true);
    expect(memoryCarriesSafetyContext(promptWithMemory(['- 2026-11-10: topics: work stress']))).toBe(false);
    // "Crisis Protocol" in the base prompt is not memory.
    expect(memoryCarriesSafetyContext(memoryBlockOf(PROMPT_WITHOUT_MEMORY))).toBe(false);
  });

  it('riskHistoryPatterns catches the date written out', () => {
    const hit = (text: string) => riskHistoryPatterns('2026-11-03').some((p) => p.test(text));
    expect(hit('on 2026-11-03')).toBe(true);
    expect(hit('on November 3rd')).toBe(true);
    expect(hit('earlier this month')).toBe(false);
  });
});

describe('what counts as built for a session', () => {
  it('includes the prompt, replies, tool traffic and stored rows, and never the participant turns', async () => {
    const r = rec('s', { replies: ['a reply'], prompt: 'the prompt' });
    r.transcript[1].text = 'PARTICIPANT SAID THIS';
    const surfaces = await builtForSession(
      poolOf([
        [
          /FROM messages/,
          [{ message_type: 'tool_response', metadata: { tool_name: 'recall_previous_sessions', response: { a: 1 } } }],
        ],
        [
          /LEFT JOIN session_insights/,
          [{ summary: { headline: 'h' }, soap_note: { plan: 'p' }, session_name: 'A name' }],
        ],
      ]),
      r,
    );
    const where = surfaces.map((s) => s.where);
    expect(where).toEqual([
      's: assembled prompt',
      's: opening line',
      "s: reply to 'b1'",
      's: tool_response recall_previous_sessions',
      's: stored summary',
      's: stored SOAP note',
      's: session name',
    ]);
    expect(surfaces.map((s) => s.text).join('\n')).not.toContain('PARTICIPANT SAID THIS');
  });

  it('storedForUser reads facts, case profile, practice and safety plan', async () => {
    const surfaces = await storedForUser(
      poolOf([
        [/user_memories/, [{ fact: 'f' }]],
        [/user_case_profiles/, [{ profile: {} }]],
        [/practice_assignments/, [{ title: 't', description: 'd' }]],
        [/safety_plans/, [{ plan: {} }]],
      ]),
      7,
      'blake',
    );
    expect(surfaces.map((s) => s.where)).toEqual([
      'blake: remembered fact',
      'blake: case profile',
      'blake: practice assignment',
      'blake: safety plan',
    ]);
  });

  it('staffSignals counts every staff surface', async () => {
    const signals = await staffSignals(poolOf([[/COUNT/, [{ n: '2' }]]]), 7);
    expect(Object.keys(signals).sort()).toEqual([
      'adverse_event_reports',
      'crisis_events',
      'escalations',
      'flagged_sessions',
      'work_items',
    ]);
    expect(Object.values(signals)).toEqual([2, 2, 2, 2, 2]);
  });
});

describe('overFirstReplies', () => {
  it('hands the wrapped assertion the first n replies joined, not the latest one', async () => {
    let seen = '';
    const inner: AssertionSpec = {
      id: 'inner',
      run: async (ctx) => {
        seen = ctx.latestReply;
        return { id: 'inner', passed: true, detail: '', gating: true };
      },
    };
    const c: DetCase = { name: '', expectPass: true, sessions: [rec('s', { replies: ['one', 'two', 'three'] })] };
    await overFirstReplies(2, inner).run(ctxOf(c));
    expect(seen).toBe('one\n\ntwo');
  });
});
