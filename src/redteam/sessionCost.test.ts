// Harness cost accounting with fixtures: recorded usage from the app's
// session_llm_usage rows replaces the old 700-in/260-out assumption, gaps are
// estimated from the session's real prompt length and labelled as such, and
// post-session jobs are counted or listed as excluded. No database, no
// network: the pool is a mock that answers the two queries sessionCost runs.
import { describe, expect, it } from 'vitest';
import { CostTracker, mergeBreakdowns, priceTokens } from './config.js';
import {
  applySessionUsage,
  categoryForPurpose,
  costNotes,
  estimateChatTurns,
  estimateJudgeTokens,
  settleSessionCosts,
  tokensForChars,
  type SessionCostPlan,
  type UsageRow,
} from './sessionCost.js';
import type { DbLike, Turn } from './types.js';

// ---- fixtures --------------------------------------------------------------

/** The assembled chat prompt stored for a harness session (11,642 chars on a
 *  freshly migrated DB) plus the chat tool definitions (15,664 chars): ~6.8k
 *  tokens, in line with the 5.5k-7.4k measured live and far from 700. */
const SYSTEM_PROMPT_CHARS = 11_642 + 15_664;
const SESSION = 'chat_1795036363131_fixture';

const transcript: Turn[] = [
  { role: 'assistant', beatId: 'opening', text: 'Hi, I am an AI support tool, not a therapist. '.repeat(4) },
  { role: 'user', beatId: 'b1', text: 'I have been feeling low for a few weeks now.' },
  { role: 'assistant', beatId: 'b1', text: 'That sounds heavy. '.repeat(30) },
  { role: 'user', beatId: 'b2', text: 'Some days I do not want to be here anymore.' },
  { role: 'assistant', beatId: 'b2', text: 'Thank you for telling me. '.repeat(30) },
  { role: 'user', beatId: 'b3', text: 'I do not have a plan, it is more of a feeling.' },
  { role: 'assistant', beatId: 'b3', text: 'I am glad you shared that. '.repeat(30) },
  { role: 'user', beatId: 'b4', text: 'Okay, I think I will call the line.' },
  { role: 'assistant', beatId: 'b4', text: 'That is a good step. '.repeat(30) },
];

/** What the app records for that session: four gpt-5.2 replies at the input
 *  sizes three agents measured live (5.5k to 7.4k), the crisis assessor on
 *  each participant turn, and the two jobs /api/chat/end starts. */
const RECORDED: UsageRow[] = [
  {
    session_id: SESSION,
    purpose: 'chat',
    model: 'gpt-5.2',
    calls: 4,
    counted_calls: 4,
    tokens_in: 25_800,
    tokens_out: 1_120,
  },
  {
    session_id: SESSION,
    purpose: 'crisis',
    model: 'gpt-4o-mini',
    calls: 4,
    counted_calls: 4,
    tokens_in: 6_400,
    tokens_out: 240,
  },
  {
    session_id: SESSION,
    purpose: 'redaction',
    model: 'gpt-5',
    calls: 2,
    counted_calls: 2,
    tokens_in: 4_200,
    tokens_out: 3_600,
  },
  {
    session_id: SESSION,
    purpose: 'insights',
    model: 'gpt-4o-mini',
    calls: 1,
    counted_calls: 1,
    tokens_in: 3_100,
    tokens_out: 700,
  },
  // Voice rows belong to the voice runner and must not be double counted.
  {
    session_id: SESSION,
    purpose: 'live_delegation',
    model: 'gpt-5.2',
    calls: 9,
    counted_calls: 9,
    tokens_in: 90_000,
    tokens_out: 9_000,
  },
  // Another session's rows are ignored.
  {
    session_id: 'chat_other',
    purpose: 'chat',
    model: 'gpt-5.2',
    calls: 1,
    counted_calls: 1,
    tokens_in: 9_000,
    tokens_out: 300,
  },
];

function plan(overrides: Partial<SessionCostPlan> = {}): SessionCostPlan {
  return {
    scenarioId: 'crisis-ladder',
    sessionId: SESSION,
    pipeline: 'chat',
    transcript,
    chatModel: 'gpt-5.2',
    expectPostSession: true,
    cost: new CostTracker(),
    ...overrides,
  };
}

/** The pre-2026-11-18 figure for the same session: 700 in / 260 out per reply. */
const OLD_ESTIMATE = 4 * priceTokens('gpt-5.2', 700, 260);

// ---- tests -----------------------------------------------------------------

describe('categoryForPurpose', () => {
  it('maps app purposes to cost categories and leaves voice rows to the voice runner', () => {
    expect(categoryForPurpose('chat')).toBe('chat-reply');
    expect(categoryForPurpose('crisis')).toBe('in-session');
    expect(categoryForPurpose('eligibility')).toBe('in-session');
    expect(categoryForPurpose('redaction')).toBe('post-session');
    expect(categoryForPurpose('insights')).toBe('post-session');
    expect(categoryForPurpose('live_delegation')).toBeNull();
    expect(categoryForPurpose('grok_voice')).toBeNull();
  });
});

describe('applySessionUsage with recorded rows', () => {
  it('books every recorded row as recorded, by category, and estimates nothing', () => {
    const p = plan();
    const applied = applySessionUsage(p, RECORDED, SYSTEM_PROMPT_CHARS);
    const b = p.cost.breakdown();

    expect(applied).toEqual({ estimatedChatReplies: 0, estimatedRows: 0, pendingPostSession: [] });
    expect(b.estimatedUsd).toBe(0);
    expect(b.byCategory['chat-reply']).toMatchObject({ calls: 4, tokensIn: 25_800, tokensOut: 1_120 });
    expect(b.byCategory['in-session']).toMatchObject({ calls: 4, tokensIn: 6_400 });
    expect(b.byCategory['post-session']).toMatchObject({ calls: 3, tokensIn: 7_300, tokensOut: 4_300 });
    expect(b.byCategory['chat-reply']?.usd).toBeCloseTo(priceTokens('gpt-5.2', 25_800, 1_120), 6);
    expect(b.totalUsd).toBeCloseTo(
      priceTokens('gpt-5.2', 25_800, 1_120) +
        priceTokens('gpt-4o-mini', 6_400 + 3_100, 240 + 700) +
        priceTokens('gpt-5', 4_200, 3_600),
      6,
    );
  });

  it('is several times the old 700-token assumption for the same session', () => {
    const p = plan();
    applySessionUsage(p, RECORDED, SYSTEM_PROMPT_CHARS);
    const ratio = p.cost.usd / OLD_ESTIMATE;
    // Chat replies alone: 6,450 average input vs 700.
    expect(p.cost.breakdown().byCategory['chat-reply']!.usd / OLD_ESTIMATE).toBeGreaterThan(2);
    expect(ratio).toBeGreaterThan(4);
  });
});

describe('estimates where nothing was recorded', () => {
  it('estimates each chat reply from the system prompt plus the history it was sent', () => {
    const turns = estimateChatTurns(SYSTEM_PROMPT_CHARS, transcript);
    expect(turns).toHaveLength(4); // the opening is not a model call
    expect(turns[0].inTok).toBeGreaterThanOrEqual(tokensForChars(SYSTEM_PROMPT_CHARS));
    // Every later reply re-sends the conversation so far.
    for (let i = 1; i < turns.length; i++) expect(turns[i].inTok).toBeGreaterThan(turns[i - 1].inTok);
    expect(turns[0].outTok).toBe(tokensForChars(transcript[2].text.length));
    // In the range measured live, nowhere near 700.
    expect(turns[0].inTok).toBeGreaterThan(5_000);
  });

  it('estimates only the replies the app has no usage for, from the last turns, and labels them', () => {
    const rows = RECORDED.map((r) =>
      r.purpose === 'chat' ? { ...r, calls: 2, counted_calls: 2, tokens_in: 11_500, tokens_out: 560 } : r,
    );
    const p = plan();
    const applied = applySessionUsage(p, rows, SYSTEM_PROMPT_CHARS);
    const turns = estimateChatTurns(SYSTEM_PROMPT_CHARS, transcript);
    const chat = p.cost.breakdown().byCategory['chat-reply']!;
    expect(applied.estimatedChatReplies).toBe(2);
    expect(chat.calls).toBe(4);
    expect(chat.recordedUsd).toBeCloseTo(priceTokens('gpt-5.2', 11_500, 560), 6);
    expect(chat.estimatedUsd).toBeCloseTo(
      priceTokens('gpt-5.2', turns[2].inTok, turns[2].outTok) + priceTokens('gpt-5.2', turns[3].inTok, turns[3].outTok),
      6,
    );
  });

  it('estimates usage rows that carry no token counts from the transcript length', () => {
    const rows: UsageRow[] = [
      ...RECORDED.filter((r) => r.purpose !== 'redaction'),
      {
        session_id: SESSION,
        purpose: 'redaction',
        model: 'gpt-5',
        calls: 2,
        counted_calls: 0,
        tokens_in: 0,
        tokens_out: 0,
      },
    ];
    const p = plan();
    const applied = applySessionUsage(p, rows, SYSTEM_PROMPT_CHARS);
    const post = p.cost.breakdown().byCategory['post-session']!;
    const tt = tokensForChars(transcript.reduce((n, t) => n + t.text.length, 0));
    expect(applied.estimatedRows).toBe(2);
    expect(post.estimatedUsd).toBeCloseTo(priceTokens('gpt-5', 2 * tt, 2 * tt), 6);
    expect(post.recordedUsd).toBeCloseTo(priceTokens('gpt-4o-mini', 3_100, 700), 6);
  });

  it('lists post-session jobs that have not logged usage instead of guessing them', () => {
    const p = plan();
    const applied = applySessionUsage(
      p,
      RECORDED.filter((r) => r.purpose !== 'insights'),
      SYSTEM_PROMPT_CHARS,
    );
    expect(applied.pendingPostSession).toEqual(['insights']);
    expect(applySessionUsage(plan({ expectPostSession: false }), [], 0).pendingPostSession).toEqual([]);
  });

  it('prices a realtime-text session from its in-session rows only (the stub replies cost nothing)', () => {
    const p = plan({ pipeline: 'realtime-text', expectPostSession: false });
    const applied = applySessionUsage(p, RECORDED, SYSTEM_PROMPT_CHARS);
    expect(applied.estimatedChatReplies).toBe(0);
    expect(p.cost.breakdown().byCategory['in-session']?.calls).toBe(4);
  });

  it('estimates a judge call from its real prompt length', () => {
    expect(estimateJudgeTokens(8_000, 4_000)).toEqual({ inTok: tokensForChars(12_200), outTok: 400 });
  });
});

describe('settleSessionCosts', () => {
  /** A pool that returns `batches[i]` for the i-th usage read. */
  function mockPool(batches: UsageRow[][], promptChars: Record<string, number>): DbLike & { usageReads: number } {
    const pool = {
      usageReads: 0,
      async query(text: string) {
        if (text.includes('session_llm_usage')) {
          const rows = batches[Math.min(pool.usageReads, batches.length - 1)];
          pool.usageReads += 1;
          return { rows: rows as unknown as Array<Record<string, unknown>> };
        }
        if (text.includes('session_configurations')) {
          return { rows: Object.entries(promptChars).map(([session_id, chars]) => ({ session_id, chars })) };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    return pool;
  }

  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it('waits for the post-session jobs to land, then books everything', async () => {
    const before = RECORDED.filter((r) => r.purpose !== 'redaction' && r.purpose !== 'insights');
    const pool = mockPool([before, before, RECORDED], { [SESSION]: SYSTEM_PROMPT_CHARS });
    const p = plan();
    const c = clock();
    const settled = await settleSessionCosts(pool, [p], { defaultPromptChars: 1, pollMs: 1_000, ...c });
    expect(pool.usageReads).toBe(3);
    expect(settled.pending).toEqual([]);
    expect(settled.waitedMs).toBe(2_000);
    expect(p.cost.breakdown().byCategory['post-session']?.calls).toBe(3);
  });

  it('gives up at the timeout and reports the missing jobs as excluded', async () => {
    const noPost = RECORDED.filter((r) => r.purpose !== 'insights');
    const pool = mockPool([noPost], {});
    const p = plan();
    const settled = await settleSessionCosts(pool, [p], {
      defaultPromptChars: SYSTEM_PROMPT_CHARS,
      timeoutMs: 5_000,
      pollMs: 1_000,
      ...clock(),
    });
    expect(settled.pending).toEqual([{ scenarioId: 'crisis-ladder', sessionId: SESSION, jobs: ['insights'] }]);
    expect(settled.waitedMs).toBe(5_000);
    const notes = costNotes(settled, []);
    expect(notes.excluded.join('\n')).toMatch(/insights for crisis-ladder .*usage not recorded before the run ended/);
  });

  it('falls back to the base prompt length when a session has no stored prompt', async () => {
    const pool = mockPool([[]], {});
    const p = plan({ expectPostSession: false });
    const settled = await settleSessionCosts(pool, [p], { defaultPromptChars: SYSTEM_PROMPT_CHARS, ...clock() });
    const turns = estimateChatTurns(SYSTEM_PROMPT_CHARS, transcript);
    expect(settled.estimatedChatReplies).toBe(4);
    expect(p.cost.breakdown().byCategory['chat-reply']?.tokensIn).toBe(turns.reduce((n, t) => n + t.inTok, 0));
    expect(costNotes(settled, ['chat-reply']).estimated.join('\n')).toMatch(/4 replies had no recorded usage/);
  });
});

describe('CostTracker provenance', () => {
  it('splits recorded and estimated spend per category and merges across scenarios', () => {
    const a = new CostTracker();
    a.add('gpt-4o-mini', { prompt_tokens: 1_000, completion_tokens: 100 }, 'persona');
    a.estimate('gpt-4o-mini', 3_000, 400, 'judge');
    a.add('gpt-4o-mini', undefined, 'classifier'); // no usage returned: not a measurement
    const b = new CostTracker();
    b.addRecorded('gpt-5.2', 6_000, 300, 'chat-reply');
    const merged = mergeBreakdowns([a.breakdown(), b.breakdown(), undefined]);
    expect(a.breakdown().byCategory.persona?.recordedUsd).toBeGreaterThan(0);
    expect(a.breakdown().byCategory.judge?.estimatedUsd).toBeGreaterThan(0);
    expect(a.breakdown().byCategory.classifier).toMatchObject({ calls: 1, usd: 0 });
    expect(merged.totalUsd).toBeCloseTo(a.usd + b.usd, 6);
    expect(merged.recordedUsd + merged.estimatedUsd).toBeCloseTo(merged.totalUsd, 6);
  });

  it('says what is estimated and what is left out', () => {
    const notes = costNotes({ sessions: 1, waitedMs: 0, estimatedChatReplies: 0, estimatedRows: 0, pending: [] }, [
      'judge',
    ]);
    expect(notes.estimated.join('\n')).toMatch(/judge/);
    expect(notes.excluded.join('\n')).toMatch(/session naming/);
    expect(costNotes(null, [], true).excluded[0]).toMatch(/dry-run/);
    expect(costNotes(null, []).excluded[0]).toMatch(/not read in this run/);
  });
});
