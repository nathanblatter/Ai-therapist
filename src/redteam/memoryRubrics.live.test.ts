// Live rubric check for the memory assertions. OPT-IN: skipped in the normal
// `npm test` and in CI. It calls the real temp-0 classifier (gpt-4o-mini, 3
// votes) on every synthetic reply in memoryFixtures.ts and requires the
// declared outcome, so a rubric question that misreads a clear reply is caught
// before it gates anything.
//
//   REDTEAM_LIVE_OPENAI_KEY="$OPENAI_API_KEY" npx vitest run src/redteam/memoryRubrics.live.test.ts
//
// The key comes in under its own name because vitest.config.ts pins
// OPENAI_API_KEY to a fake value for every test. Costs about a cent. Run it
// after changing any rubric question (and bump that rubric's version), and run
// it more than once: a fixture that passes on one run and fails on the next is
// a rubric that needs rewording.
import { describe, it, expect } from 'vitest';
import OpenAI from 'openai';
import { makeClassifier } from './assertions.js';
import { CostTracker, DEFAULTS, type RedteamConfig } from './config.js';
import { MEMORY_RUBRIC_FIXTURES } from './memoryFixtures.js';
import type { AssertionContext } from './types.js';

const key = process.env.REDTEAM_LIVE_OPENAI_KEY;

describe.skipIf(!key)('memory rubrics against the live classifier', () => {
  const cfg = { ...DEFAULTS, suite: 'full' } as RedteamConfig;
  const cost = new CostTracker();
  const classify = key ? makeClassifier(new OpenAI({ apiKey: key }), cfg, cost) : null;

  for (const fx of MEMORY_RUBRIC_FIXTURES) {
    const spec = fx.assertion();
    it(`${spec.id}: ${fx.expectPass ? 'passes' : 'FAILS'} on "${fx.name}"`, { timeout: 60_000 }, async () => {
      const ctx: AssertionContext = {
        scenarioId: 'rubric-fixture',
        sessionId: 'rubric-fixture',
        latestReply: fx.reply,
        transcript: [],
        emissions: [],
        beatPostTimes: {},
        systemPromptCanaries: [],
        pool: { query: async () => ({ rows: [] }) },
        classify: classify!,
        dryRun: false,
      };
      const r = await spec.run(ctx);
      expect(r.passed, r.detail).toBe(fx.expectPass);
    });
  }
});
