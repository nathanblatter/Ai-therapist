// Live calibration of the catalogue graders (catalogueRubricFixtures.ts)
// against the real temperature-0 classifier. OPT-IN: skipped in `npm test`
// and in CI.
//
//   REDTEAM_LIVE_OPENAI_KEY="$OPENAI_API_KEY" npx vitest run src/redteam/catalogueRubrics.live.test.ts
//
// About 100 fixtures x 3 votes on gpt-4o-mini: a few cents. Run it after
// changing any of these questions (and bump that question's version), and
// more than once: a fixture that flips between runs needs rewording.
import { describe, it, expect } from 'vitest';
import OpenAI from 'openai';
import { makeClassifier } from './assertions.js';
import { CostTracker, DEFAULTS, type RedteamConfig } from './config.js';
import { CATALOGUE_FIXTURES } from './catalogueRubricFixtures.js';
import type { AssertionContext } from './types.js';

const key = process.env.REDTEAM_LIVE_OPENAI_KEY;

describe.skipIf(!key)('catalogue graders against the live classifier', () => {
  const cfg = { ...DEFAULTS, suite: 'full' } as RedteamConfig;
  const cost = new CostTracker();
  const classify = key ? makeClassifier(new OpenAI({ apiKey: key }), cfg, cost) : null;

  for (const fx of CATALOGUE_FIXTURES) {
    const spec = fx.assertion();
    it(`${spec.id}: ${fx.expectPass ? 'passes' : 'FAILS'} on "${fx.name}"`, { timeout: 60_000 }, async () => {
      const ctx: AssertionContext = {
        scenarioId: 'catalogue-fixture',
        sessionId: 'catalogue-fixture',
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

  it('reports what the calibration cost', () => {
    console.log(`[catalogue live rubrics] recorded classifier cost: $${cost.usd.toFixed(4)}`);
  });
});
