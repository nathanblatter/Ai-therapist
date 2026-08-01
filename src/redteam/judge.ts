// Thin wrapper over the v1 LLM judge (sessionEval.evaluateSession). Reuses the
// existing session_evals path — no new table (spec §6, §9).
import { evaluateSession, EVAL_DIMENSIONS, type EvalDimensionId } from '../server/services/sessionEval.service.js';
import type { CostTracker, RedteamConfig } from './config.js';
import type { JudgeScores, Scenario } from './types.js';

export interface JudgeOutcome {
  scores: JudgeScores;
  /** Gating floor breaches: dimension → { score, floor }. Empty when none. */
  breaches: Array<{ dimension: EvalDimensionId; score: number; floor: number }>;
}

/**
 * Run the v1 judge over an ended session and return its scores plus any
 * judgeMinScores floor breaches. Judge scores are reported; they gate the
 * scenario ONLY when the scenario sets judgeMinScores (spec §6).
 */
export async function runJudge(
  sessionId: string,
  scenario: Scenario,
  cfg: RedteamConfig,
  cost: CostTracker,
): Promise<JudgeOutcome | null> {
  if (cfg.dryRun) {
    // Offline: fabricate perfect scores so the pipeline completes without a key.
    const scores: Partial<Record<EvalDimensionId, number>> = {};
    for (const d of EVAL_DIMENSIONS) scores[d] = 5;
    return { scores: { scores, overall: 'dry-run: judge skipped' }, breaches: [] };
  }

  const row = await evaluateSession(sessionId, { force: true, judgeModel: cfg.judgeModel });
  if (!row) return null;

  // evaluateSession makes one judge call; estimate its cost (usage not returned).
  cost.estimate(cfg.judgeModel, 3000, 400);

  const scores: Partial<Record<EvalDimensionId, number>> = {};
  for (const d of EVAL_DIMENSIONS) scores[d] = row.rubric[d]?.score;

  const breaches: JudgeOutcome['breaches'] = [];
  if (scenario.judgeMinScores) {
    for (const [dim, floor] of Object.entries(scenario.judgeMinScores) as Array<[EvalDimensionId, number]>) {
      const score = scores[dim];
      if (typeof score === 'number' && score < floor) breaches.push({ dimension: dim, score, floor });
    }
  }

  return { scores: { scores, overall: row.overall_comments ?? null }, breaches };
}
