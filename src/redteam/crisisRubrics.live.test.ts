// Live calibration of the crisis classifier rubrics. Opt-in and skipped in the
// normal `npm test`: it calls the real classifier model.
//
//   REDTEAM_LIVE_RUBRICS=1 REDTEAM_RUBRICS_OPENAI_KEY=sk-... \
//     npx vitest run src/redteam/crisisRubrics.live.test.ts
//
// (A separate variable for the key because vitest.config.ts pins
// OPENAI_API_KEY to a dummy value for every test.)
//
// The offline tests in crisisAssertions.test.ts mock the classifier, so they
// prove the wiring and the regex layers but not that each QUESTION separates a
// good reply from a bad one. This does: every classifier-backed assertion gets
// one synthetic reply that must pass and one that MUST FAIL, each written to
// slip past the regex layer so the classifier is what decides. Run it whenever
// a rubric question or the classifier model changes.
import { describe, it, expect } from 'vitest';
import OpenAI from 'openai';
import { makeClassifier } from './assertions.js';
import { CostTracker, DEFAULTS, type RedteamConfig } from './config.js';
import { CRISIS_RUBRIC_CASES as CASES } from './crisisRubricCases.js';
import { A, ctxOf } from './crisisTestSupport.js';

const KEY = process.env.REDTEAM_RUBRICS_OPENAI_KEY;
const LIVE = process.env.REDTEAM_LIVE_RUBRICS === '1' && Boolean(KEY);

describe.skipIf(!LIVE)('crisis rubrics against the real classifier', () => {
  const cfg = { ...DEFAULTS, suite: 'full' } as RedteamConfig;
  const cost = new CostTracker();
  const classify = LIVE ? makeClassifier(new OpenAI({ apiKey: KEY }), cfg, cost) : undefined;

  for (const c of CASES) {
    it(`${c.name}: the good reply passes`, async () => {
      const ctx = ctxOf({ transcript: [...c.before, A(c.good)], classify });
      const r = await c.spec.run(ctx);
      expect(r.passed, r.detail).toBe(true);
    }, 60_000);

    it(`${c.name}: the bad reply MUST FAIL, decided by the classifier`, async () => {
      const ctx = ctxOf({ transcript: [...c.before, A(c.bad)], classify });
      const r = await c.spec.run(ctx);
      expect(r.passed, r.detail).toBe(false);
      // If a regex settled it, this case is not testing the rubric question.
      expect(ctx.classifyCalls.length, `${c.name}: regex decided, rewrite the bad reply`).toBeGreaterThan(0);
    }, 60_000);
  }
});

describe('crisis rubric calibration set', () => {
  it('covers every classifier-backed crisis assertion once', () => {
    expect(new Set(CASES.map((c) => c.spec.id)).size).toBe(CASES.length);
    expect(CASES).toHaveLength(33);
  });
});
