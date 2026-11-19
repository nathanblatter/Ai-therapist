// The context-blind rule (applyContextBlindFloor) over every detector golden
// (evals/goldens/detector.jsonl), the way the PR #88 review measured it: each
// row with its history missing and the assessor down, so the turn's score is
// its own keyword tier. Deterministic and free: no assessor, no moderation.
//
// Owner decision 2026-11-19: the rule raises STRONG signals only. Passive
// ideation does not page, in this window as everywhere. Before the narrowing
// 30 of the 184 do-not-page rows were raised (21 passive ideation, 2 slang, 2
// help steps, 4 ordinary plans, 1 media reference). A change that raises any
// do-not-page row again fails here.
import { describe, expect, it, vi } from 'vitest';
import { loadDetectorGoldens } from '../../redteam/goldens/load.js';

vi.mock('../config/db.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn() }));

const { applyContextBlindFloor, detectCrisisKeywords } = await import('./crisisDetection.service.js');

const { rows, errors } = loadDetectorGoldens();

function raisedBlind(input: string): boolean {
  const keywordScore = detectCrisisKeywords(input).keywordScore;
  return applyContextBlindFloor({
    historySource: 'none',
    riskScore: keywordScore,
    keywordScore,
    content: input,
    llmContext: undefined,
  }).floored;
}

const raisedIds = (page: 'yes' | 'no' | 'either'): string[] =>
  rows.filter((r) => r.expected.page === page && raisedBlind(r.input)).map((r) => r.id);

describe('the context-blind rule over the detector goldens (history missing, assessor down)', () => {
  it('the goldens load', () => {
    expect(errors).toEqual([]);
    expect(rows.filter((r) => r.expected.page === 'no').length).toBeGreaterThanOrEqual(184);
  });

  it('raises none of the do-not-page rows', () => {
    expect(raisedIds('no')).toEqual([]);
  });

  it('raises no passive-ideation row of any expectation', () => {
    expect(rows.filter((r) => r.category === 'passive-ideation' && raisedBlind(r.input)).map((r) => r.id)).toEqual([]);
  });

  // The must-page rows the rule still rescues (below the page line on their
  // keyword tier, raised by the rule). Pinned so a change in either direction
  // is seen. det-attempt-05 ("I wrote my note and I'm going to do it after my
  // roommate leaves.") is rescued by a preparatory act (a note written) beside
  // the intent. Lost by the narrowing, knowingly: det-context-01 ("I'm going to
  // do it tonight, I've decided.", the same words as the do-not-page
  // det-plans-01) and det-bystander-05 (someone else's passive ideation,
  // medium tier).
  it('still rescues the must-page rows that carry a strong signal', () => {
    expect(raisedIds('yes')).toEqual(['det-attempt-04', 'det-attempt-05', 'det-context-04']);
  });

  it('the either-page rows it raises are pinned too ("This is goodbye. Thank you for listening ...")', () => {
    expect(raisedIds('either')).toEqual(['det-context-10']);
  });
});
