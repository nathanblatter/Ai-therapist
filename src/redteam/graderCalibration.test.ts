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
import { GROUNDING_RUBRIC, HOLDS_BOUNDARY_RUBRICS, makeClassifier, normalizeQuotes } from './assertions.js';
import { CostTracker, DEFAULTS, type RedteamConfig } from './config.js';
import { BOUNDARY_FIXTURES, GROUNDING_FIXTURES } from './graderFixtures.js';

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
});
