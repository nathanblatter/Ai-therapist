// Live calibration of the classifier-backed graders against labelled replies
// (graderFixtures.ts). OPT-IN: skipped unless REDTEAM_CALIBRATION_OPENAI_KEY is
// set, so `npm test` and CI stay offline. Run it after editing a classifier
// question in assertions.ts:
//
//   REDTEAM_CALIBRATION_OPENAI_KEY=$OPENAI_API_KEY npx vitest run src/redteam/graderCalibration.test.ts
//
// About 60 gpt-4o-mini calls, under $0.01. Every fixture is graded by the real
// classifier with the exact question the harness sends, bypassing the regex
// layers on purpose: the rubric on its own must FAIL every breach and pass
// every correct reply (assertions.test.ts covers the regex layers offline).
import { describe, it, expect } from 'vitest';
import OpenAI from 'openai';
import {
  GROUNDING_RUBRIC,
  HOLDS_BOUNDARY_RUBRICS,
  makeClassifier,
  noHarshConfrontation,
  normalizeQuotes,
  warmNonShaming,
} from './assertions.js';
import { CostTracker, DEFAULTS, type RedteamConfig } from './config.js';
import { A, ctxOf, U } from './crisisTestSupport.js';
import { BOUNDARY_FIXTURES, GROUNDING_FIXTURES, TONE_FIXTURES } from './graderFixtures.js';
import { warmUnderPushback } from './relationalAssertions.js';

const TONE_GRADERS = {
  'warm-non-shaming': warmNonShaming,
  'no-harsh-confrontation': noHarshConfrontation,
  'warm-under-pushback': warmUnderPushback,
};

// A dedicated variable on purpose: vitest.config.ts pins OPENAI_API_KEY to a
// dummy value for every test, so that name can never mean "run live".
const KEY = process.env.REDTEAM_CALIBRATION_OPENAI_KEY;

describe.skipIf(!KEY)('live grader calibration', () => {
  const cfg: RedteamConfig = { ...DEFAULTS };
  const classify = makeClassifier(KEY ? new OpenAI({ apiKey: KEY }) : null, cfg, new CostTracker());

  it.each(BOUNDARY_FIXTURES.map((f) => [f.kind, f.held ? 'HELD' : 'BREACH', f.name, f] as const))(
    'holds-boundary %s must grade %s: %s',
    async (_kind, _label, _name, f) => {
      const r = await classify({ ...HOLDS_BOUNDARY_RUBRICS[f.kind], text: normalizeQuotes(f.reply), votes: 3 });
      expect(r.verdict, r.evidence).toBe(f.held);
    },
    60_000,
  );

  it.each(GROUNDING_FIXTURES.map((f) => [f.grounded ? 'PRESENT' : 'ABSENT', f.name, f] as const))(
    'grounding-present must grade %s: %s',
    async (_label, _name, f) => {
      const r = await classify({ ...GROUNDING_RUBRIC, text: normalizeQuotes(f.reply), votes: 3 });
      expect(r.verdict, r.evidence).toBe(f.grounded);
    },
    60_000,
  );

  it.each(TONE_FIXTURES.map((f) => [f.grader, f.expectPass ? 'PASS' : 'FAIL', f.name, f] as const))(
    '%s must %s: %s',
    async (_grader, _label, _name, f) => {
      const ctx = ctxOf({ transcript: [U(f.participant), A(f.reply)], classify });
      const r = await TONE_GRADERS[f.grader]().run(ctx);
      expect(r.passed, r.detail).toBe(f.expectPass);
    },
    60_000,
  );
});

// Offline: the labels above mean something only if the judge is what decides.
describe('tone fixtures reach the judge', () => {
  it.each(TONE_FIXTURES.map((f) => [f.grader, f.name, f] as const))('%s: %s', async (_grader, _name, f) => {
    for (const verdict of [true, false]) {
      const ctx = ctxOf({ transcript: [U(f.participant), A(f.reply)], classifyVerdict: verdict });
      await TONE_GRADERS[f.grader]().run(ctx);
      expect(ctx.classifyCalls, 'a regex decided this reply: reword it').toHaveLength(1);
    }
  });

  it('every tone grader has replies that must pass and replies that must fail', () => {
    for (const grader of Object.keys(TONE_GRADERS)) {
      const own = TONE_FIXTURES.filter((f) => f.grader === grader);
      expect(own.filter((f) => f.expectPass).length).toBeGreaterThanOrEqual(3);
      expect(own.filter((f) => !f.expectPass).length).toBeGreaterThanOrEqual(5);
    }
  });
});
