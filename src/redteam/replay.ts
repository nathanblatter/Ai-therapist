// Production replay (ai-therapist-124 phase 4): re-drive real sessions'
// REDACTED participant turns through the CURRENT chat pipeline and diff the
// judge's rubric scores against each session's stored eval. Catches quality
// regressions when the system prompt or model changes, over the real
// distribution of participant behavior instead of scripted personas.
//
//   npm run redteam:replay -- [--sessions <n>] [--drop <points>] [--allow-fail]
//
// Privacy posture (docs/anonymity.md):
// - Source text is content_redacted ONLY — the human-verified research field;
//   original content is never read.
// - Regenerated sessions run under the harness participant (excluded from real
//   analytics like all harness sessions) and ride the normal retention sweeps.
// - Only judge scores and per-dimension deltas persist to the harness tables.
// - Comparisons are restricted to evals with the CURRENT EVAL_PROMPT_VERSION —
//   cross-version scores are not comparable.
import 'dotenv/config';

// ---- env guards (MUST run before importing server modules) ----------------
process.env.IMESSAGE_API_KEY = '';
process.env.CRISIS_ALERT_PHONE = '';
process.env.SOCKET_PG_ADAPTER = 'off'; // never fan emissions to live admin dashboards
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import { HarnessClient } from './harnessClient.js';
import type { EvalDimensionId } from './types.js';

interface ReplayConfig {
  sessions: number;
  /** Per-dimension drop (stored - replay) that flags a regression. */
  dropThreshold: number;
  allowFail: boolean;
}

function parseArgs(argv: string[]): ReplayConfig {
  const cfg: ReplayConfig = { sessions: 3, dropThreshold: 1.0, allowFail: false };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--sessions': cfg.sessions = Math.max(1, Number(next()) || 3); break;
      case '--drop': cfg.dropThreshold = Math.max(0.5, Number(next()) || 1.0); break;
      case '--allow-fail': cfg.allowFail = true; break;
      default: break;
    }
  }
  return cfg;
}

export interface DimensionDelta {
  dimension: EvalDimensionId;
  stored: number;
  replay: number;
  /** stored - replay: positive = the current pipeline scored WORSE. */
  drop: number;
}

/** Pure delta computation (unit-tested): flag dimensions whose replay score
 *  dropped at least `threshold` points below the stored eval. */
export function computeReplayDeltas(
  stored: Partial<Record<EvalDimensionId, number>>,
  replay: Partial<Record<EvalDimensionId, number>>,
  threshold: number,
): { deltas: DimensionDelta[]; flagged: DimensionDelta[] } {
  const deltas: DimensionDelta[] = [];
  for (const [dim, storedScore] of Object.entries(stored) as Array<[EvalDimensionId, number]>) {
    const replayScore = replay[dim];
    if (typeof storedScore !== 'number' || typeof replayScore !== 'number') continue;
    deltas.push({ dimension: dim, stored: storedScore, replay: replayScore, drop: storedScore - replayScore });
  }
  return { deltas, flagged: deltas.filter(d => d.drop >= threshold) };
}

const MAX_REPLAY_TURNS = 12;
const MIN_SOURCE_TURNS = 3;

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));

  const { app, io } = await import('../server/index.js');
  const { pool } = await import('../server/config/db.js');
  const { CURRENT_CONSENT_VERSION } = await import('../server/utils/consent.js');
  const { EVAL_PROMPT_VERSION, EVAL_DIMENSIONS, evaluateSession } = await import('../server/services/sessionEval.service.js');
  const { insertHarnessRun } = await import('../server/db/index.js');

  const client = new HarnessClient(app, io, CURRENT_CONSENT_VERSION);
  client.patchEmissions();
  const health = await (await import('supertest')).default(app).get('/health');
  if (health.status !== 200) throw new Error(`server not healthy: ${health.status}`);

  // Candidates: ended, non-demo, real sessions with a stored eval under the
  // CURRENT prompt version and enough redacted participant turns to be worth
  // replaying. The harness's own sessions are excluded by user filter below.
  const { rows: candidates } = await pool.query<{ session_id: string; rubric: Record<string, { score?: number }> }>(
    `SELECT se.session_id, se.rubric
       FROM session_evals se
       JOIN therapy_sessions ts ON ts.session_id = se.session_id
       LEFT JOIN users u ON u.userid = ts.user_id
      WHERE se.prompt_version = $1
        AND ts.status = 'ended'
        AND COALESCE(ts.is_demo, false) = false
        AND COALESCE(u.username, '') <> 'redteam_participant'
        AND (SELECT count(*) FROM messages m
              WHERE m.session_id = se.session_id AND m.role = 'user'
                AND COALESCE(m.content_redacted, '') <> '') >= $2
      ORDER BY se.created_at DESC
      LIMIT $3`,
    [EVAL_PROMPT_VERSION, MIN_SOURCE_TURNS, cfg.sessions],
  );

  if (candidates.length === 0) {
    console.log(`[replay] no candidate sessions (prompt_version=${EVAL_PROMPT_VERSION}, >=${MIN_SOURCE_TURNS} redacted user turns). Nothing to do.`);
    await flushAndExit(0);
  }
  console.log(`[replay] replaying ${candidates.length} session(s), drop threshold ${cfg.dropThreshold}`);

  const startedAt = new Date().toISOString();
  const scenarios: Parameters<typeof insertHarnessRun>[0]['scenarios'] = [];
  let anyFlagged = false;

  for (const source of candidates) {
    const t0 = Date.now();
    const shortId = source.session_id.slice(0, 16);
    try {
      // Redacted participant turns, in order.
      const { rows: turns } = await pool.query<{ content_redacted: string }>(
        `SELECT content_redacted FROM messages
          WHERE session_id = $1 AND role = 'user' AND COALESCE(content_redacted, '') <> ''
          ORDER BY created_at ASC LIMIT $2`,
        [source.session_id, MAX_REPLAY_TURNS],
      );

      // Re-drive through the real chat pipeline under the harness participant.
      const agent = client.newAgent();
      await client.loginParticipant(agent);
      await client.acceptConsent(agent);
      const replaySessionId = await client.startChat(agent);
      for (const turn of turns) {
        const res = await client.chatMessage(agent, replaySessionId, turn.content_redacted);
        if (res.sessionEnded) break; // e.g. eligibility gate — stop replaying into a dead session
      }
      await client.endChat(agent, replaySessionId);

      // Judge the regenerated transcript and diff against the stored rubric.
      const evalRow = await evaluateSession(replaySessionId, { force: true });
      if (!evalRow) throw new Error('judge returned no eval for the replay session');

      const stored: Partial<Record<EvalDimensionId, number>> = {};
      const replayScores: Partial<Record<EvalDimensionId, number>> = {};
      for (const d of EVAL_DIMENSIONS) {
        const s = source.rubric?.[d]?.score;
        if (typeof s === 'number') stored[d] = s;
        const r = evalRow.rubric?.[d]?.score;
        if (typeof r === 'number') replayScores[d] = r;
      }
      const { deltas, flagged } = computeReplayDeltas(stored, replayScores, cfg.dropThreshold);
      if (flagged.length > 0) anyFlagged = true;

      const deltaStr = deltas.map(d => `${d.dimension} ${d.stored}→${d.replay}`).join(', ');
      console.log(`[replay] ${shortId}…: ${flagged.length > 0 ? 'REGRESSION' : 'ok'} (${deltaStr})`);

      scenarios.push({
        scenarioId: `replay:${source.session_id}`,
        variation: 0,
        pipeline: 'chat',
        passed: flagged.length === 0,
        assertionFailures: flagged.map(d => ({
          id: `delta-${d.dimension}`,
          detail: `${d.dimension} dropped ${d.drop} (stored ${d.stored} → replay ${d.replay})`,
        })),
        judgeScores: replayScores as Record<string, number>,
        sessionId: replaySessionId,
        durationMs: Date.now() - t0,
        costUsd: 0, // chat replies + judge bill server-side; not metered here
      });
    } catch (err) {
      anyFlagged = true;
      console.error(`[replay] ${shortId}… failed: ${(err as Error).message}`);
      scenarios.push({
        scenarioId: `replay:${source.session_id}`,
        variation: 0,
        pipeline: 'chat',
        passed: false,
        assertionFailures: [],
        judgeScores: null,
        error: (err as Error).message,
        durationMs: Date.now() - t0,
        costUsd: 0,
      });
    }
  }

  try {
    const runId = await insertHarnessRun({
      startedAt, finishedAt: new Date().toISOString(),
      suite: 'replay', seed: 0, variations: 1,
      judgeModel: null, gitSha: process.env.GITHUB_SHA ?? null,
      trigger: 'replay', dryRun: false, scenarios,
    });
    console.log(`[replay] persisted as harness run #${runId}`);
  } catch (err) {
    console.warn(`[replay] run not persisted (${(err as Error).message})`);
  }

  const passCount = scenarios.filter(s => s.passed).length;
  console.log(`[replay] ${passCount}/${scenarios.length} sessions clean`);
  await flushAndExit(anyFlagged && !cfg.allowFail ? 1 : 0);
}

async function flushAndExit(code: number): Promise<never> {
  await new Promise<void>(res => process.stdout.write('', () => res()));
  await new Promise<void>(res => process.stderr.write('', () => res()));
  process.exit(code);
}

// Only run as an entrypoint — computeReplayDeltas is imported by unit tests.
const invokedDirectly = process.argv[1]?.endsWith('replay.ts') || process.argv[1]?.endsWith('replay.js');
if (invokedDirectly) {
  main().catch(async err => {
    console.error('[replay] fatal:', err);
    await flushAndExit(1);
  });
}
