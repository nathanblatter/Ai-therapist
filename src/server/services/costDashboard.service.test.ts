// The attribution maths is the part that can be quietly wrong: it turns real
// dollars into a product-level story, and a bad split would misdirect budget
// decisions while looking authoritative. These tests pin the apportionment,
// the shared-model case, and the honesty guarantees (totals never inflate,
// estimates get flagged).
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';

const { getCostsSummaryMock, usageMock, realtimeMock, volumeMock } = vi.hoisted(() => ({
  getCostsSummaryMock: vi.fn(),
  usageMock: vi.fn(),
  realtimeMock: vi.fn(),
  volumeMock: vi.fn(),
}));

vi.mock('./openaiCosts.service.js', () => ({ getCostsSummary: getCostsSummaryMock }));
vi.mock('../db/index.js', () => ({
  getUsageByPurpose: usageMock,
  getRealtimeUsageTotals: realtimeMock,
  getSessionVolume: volumeMock,
}));

import { getCostDashboard, modelFamilyOf } from './costDashboard.service.js';

const VOLUME = {
  sessions: 20,
  endedSessions: 18,
  realtimeSessions: 12,
  chatSessions: 8,
  activeDays: 10,
  participants: 5,
};

function costs(
  byLineItem: Array<{ lineItem: string; amountUsd: number }>,
  days = [{ date: '2026-09-01', amountUsd: 10 }],
) {
  const total = byLineItem.reduce((s, i) => s + i.amountUsd, 0);
  return {
    configured: true,
    totalUsd: total,
    days,
    byLineItem,
    fetchedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usageMock.mockResolvedValue([]);
  realtimeMock.mockResolvedValue({
    responses: 0,
    inputTokens: 0,
    outputTokens: 0,
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    cachedTokens: 0,
  });
  volumeMock.mockResolvedValue(VOLUME);
});

describe('modelFamilyOf', () => {
  it('maps the line-item strings OpenAI actually returns', () => {
    expect(modelFamilyOf('gpt-5-2025-08-07, output')).toBe('gpt-5');
    expect(modelFamilyOf('gpt-5.2-2025-12-11, cached input')).toBe('gpt-5.2');
    expect(modelFamilyOf('gpt-realtime-2.1 audio, output')).toBe('realtime');
    expect(modelFamilyOf('gpt-4o-mini, input')).toBe('gpt-4o-mini');
    expect(modelFamilyOf('text-embedding-3-small, input')).toBe('embeddings');
    expect(modelFamilyOf('omni-moderation-2024-09-26, input')).toBe('moderation');
  });

  it('does not confuse gpt-5.2 with gpt-5 (they are different subsystems)', () => {
    expect(modelFamilyOf('gpt-5.2, output')).toBe('gpt-5.2');
    expect(modelFamilyOf('gpt-5, output')).toBe('gpt-5');
  });

  it('maps every transcribe variant to realtime, including the new ones', () => {
    expect(modelFamilyOf('gpt-transcribe, input')).toBe('transcribe');
    expect(modelFamilyOf('gpt-live-transcribe, input')).toBe('transcribe');
    expect(modelFamilyOf('gpt-4o-mini-transcribe, input')).toBe('transcribe');
  });

  it('returns null for anything unrecognised rather than guessing', () => {
    expect(modelFamilyOf('some-future-model, input')).toBeNull();
  });

  it('gives each GPT-6 model its own family, folding dated snapshots into the alias', () => {
    expect(modelFamilyOf('gpt-6.1-terra, input')).toBe('gpt-6.1-terra');
    expect(modelFamilyOf('gpt-6.1-terra-2026-10-01, output')).toBe('gpt-6.1-terra');
    expect(modelFamilyOf('gpt-6-luna, cached input')).toBe('gpt-6-luna');
    // The 5.6 backend keeps its historical bucket.
    expect(modelFamilyOf('gpt-5.6-terra, output')).toBe('live-backend');
    expect(modelFamilyOf('')).toBeNull();
  });
});

describe('getCostDashboard attribution', () => {
  it('assigns a sole-owner model entirely to its subsystem', async () => {
    getCostsSummaryMock.mockResolvedValue(
      costs([
        { lineItem: 'gpt-5-2025-08-07, output', amountUsd: 20 },
        { lineItem: 'gpt-5.2, output', amountUsd: 5 },
      ]),
    );
    const d = await getCostDashboard(30);
    const byName = Object.fromEntries(d.bySubsystem.map((s) => [s.subsystem, s.amountUsd]));
    expect(byName.redaction).toBe(20); // gpt-5 -> redaction only
    expect(byName.chat).toBe(5); // gpt-5.2 -> chat only
  });

  it('splits a SHARED model by measured token share, not evenly', async () => {
    // crisis and insights both run gpt-4o-mini; insights burns 3x the tokens.
    usageMock.mockResolvedValue([
      { purpose: 'crisis', model: 'gpt-4o-mini', calls: 10, tokensIn: 200, tokensOut: 50, tokensMissing: false },
      { purpose: 'insights', model: 'gpt-4o-mini', calls: 5, tokensIn: 600, tokensOut: 150, tokensMissing: false },
    ]);
    getCostsSummaryMock.mockResolvedValue(costs([{ lineItem: 'gpt-4o-mini, input', amountUsd: 100 }]));

    const d = await getCostDashboard(30);
    const byName = Object.fromEntries(d.bySubsystem.map((s) => [s.subsystem, s.amountUsd]));
    expect(byName.crisis).toBeCloseTo(25, 1); // 250 / 1000
    expect(byName.insights).toBeCloseTo(75, 1); // 750 / 1000
    expect(d.bySubsystem.every((s) => s.subsystem === 'other' || s.estimated)).toBe(true);
  });

  it('falls back to call count and raises a caveat when tokens were not recorded', async () => {
    // This is redaction's real situation today: calls logged, tokens NULL.
    usageMock.mockResolvedValue([
      { purpose: 'crisis', model: 'gpt-4o-mini', calls: 30, tokensIn: 0, tokensOut: 0, tokensMissing: true },
      { purpose: 'insights', model: 'gpt-4o-mini', calls: 10, tokensIn: 0, tokensOut: 0, tokensMissing: true },
    ]);
    getCostsSummaryMock.mockResolvedValue(costs([{ lineItem: 'gpt-4o-mini, input', amountUsd: 40 }]));

    const d = await getCostDashboard(30);
    const byName = Object.fromEntries(d.bySubsystem.map((s) => [s.subsystem, s.amountUsd]));
    expect(byName.crisis).toBeCloseTo(30, 1); // 30/40 of the calls
    expect(byName.insights).toBeCloseTo(10, 1);
    expect(d.attributionCaveats.join(' ')).toMatch(/token counts not recorded/);
  });

  it('never invents or loses money — subsystem total equals the real total', async () => {
    usageMock.mockResolvedValue([
      { purpose: 'crisis', model: 'gpt-4o-mini', calls: 1, tokensIn: 100, tokensOut: 0, tokensMissing: false },
    ]);
    getCostsSummaryMock.mockResolvedValue(
      costs([
        { lineItem: 'gpt-5, output', amountUsd: 12.34 },
        { lineItem: 'gpt-4o-mini, input', amountUsd: 5.66 },
        { lineItem: 'some-unknown-model, input', amountUsd: 2 }, // must not vanish
      ]),
    );
    const d = await getCostDashboard(30);
    const sum = d.bySubsystem.reduce((s, x) => s + x.amountUsd, 0);
    expect(sum).toBeCloseTo(20, 1);
    expect(sum).toBeCloseTo(d.totalUsd, 1);
    // the unrecognised model lands in 'other' rather than being dropped
    expect(d.bySubsystem.find((s) => s.subsystem === 'other')?.amountUsd).toBeCloseTo(2, 1);
  });

  it('attributes a GPT-6 delegation backend to realtime, not other', async () => {
    // live_backend_model = gpt-6.1-terra: its spend is the voice product's.
    // Before, the line item matched no family and landed in 'other'.
    usageMock.mockResolvedValue([
      {
        purpose: 'live_delegation',
        model: 'gpt-6.1-terra',
        calls: 40,
        tokensIn: 9000,
        tokensOut: 1000,
        tokensMissing: false,
      },
    ]);
    getCostsSummaryMock.mockResolvedValue(costs([{ lineItem: 'gpt-6.1-terra, input', amountUsd: 7 }]));
    const d = await getCostDashboard(30);
    const byName = Object.fromEntries(d.bySubsystem.map((s) => [s.subsystem, s.amountUsd]));
    expect(byName.realtime).toBe(7);
    expect(byName.other).toBeUndefined();
  });

  it('splits a GPT-6 model shared by voice and chat by measured tokens', async () => {
    usageMock.mockResolvedValue([
      {
        purpose: 'live_delegation',
        model: 'gpt-6.1-terra',
        calls: 10,
        tokensIn: 750,
        tokensOut: 0,
        tokensMissing: false,
      },
      { purpose: 'chat', model: 'gpt-6.1-terra', calls: 10, tokensIn: 250, tokensOut: 0, tokensMissing: false },
      { purpose: 'redaction', model: 'gpt-6-luna', calls: 3, tokensIn: 100, tokensOut: 10, tokensMissing: false },
    ]);
    getCostsSummaryMock.mockResolvedValue(
      costs([
        { lineItem: 'gpt-6.1-terra, input', amountUsd: 8 },
        { lineItem: 'gpt-6-luna, input', amountUsd: 1 },
      ]),
    );
    const d = await getCostDashboard(30);
    const byName = Object.fromEntries(d.bySubsystem.map((s) => [s.subsystem, s.amountUsd]));
    expect(byName.realtime).toBeCloseTo(6, 2);
    expect(byName.chat).toBeCloseTo(2, 2);
    // The redaction verifier's gpt-6-luna spend now reaches redaction.
    expect(byName.redaction).toBeCloseTo(1, 2);
  });

  it('keeps a GPT-6 line item with no usage rows in other rather than dropping it', async () => {
    getCostsSummaryMock.mockResolvedValue(costs([{ lineItem: 'gpt-6.2-astra, input', amountUsd: 3 }]));
    const d = await getCostDashboard(30);
    expect(d.bySubsystem.find((s) => s.subsystem === 'other')?.amountUsd).toBe(3);
  });

  it('computes unit economics from real dollars and real session counts', async () => {
    getCostsSummaryMock.mockResolvedValue(costs([{ lineItem: 'gpt-5, output', amountUsd: 40 }]));
    const d = await getCostDashboard(30);
    expect(d.unit.usdPerSession).toBeCloseTo(40 / 20, 4);
    expect(d.unit.usdPerEndedSession).toBeCloseTo(40 / 18, 4);
    expect(d.volume.participants).toBe(5);
  });

  it('reports not-configured without touching the DB when there is no admin key', async () => {
    getCostsSummaryMock.mockResolvedValue({
      configured: false,
      totalUsd: 0,
      days: [],
      byLineItem: [],
      fetchedAt: new Date(0).toISOString(),
    });
    const d = await getCostDashboard(30);
    expect(d.configured).toBe(false);
    expect(usageMock).not.toHaveBeenCalled();
  });

  it('still renders dollars when the attribution queries fail', async () => {
    usageMock.mockRejectedValue(new Error('db down'));
    getCostsSummaryMock.mockResolvedValue(costs([{ lineItem: 'gpt-5, output', amountUsd: 9 }]));
    const d = await getCostDashboard(30);
    expect(d.configured).toBe(true);
    expect(d.totalUsd).toBe(9);
    expect(d.bySubsystem.find((s) => s.subsystem === 'redaction')?.amountUsd).toBe(9);
  });

  it('flags cap risk from the month-to-date projection', async () => {
    // The service reads the clock too: pin it so the test's "today" is the
    // service's today (they differed when the run crossed UTC midnight).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 12 * 3_600_000));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const today = new Date().toISOString().slice(0, 10);
    getCostsSummaryMock.mockResolvedValue(
      costs([{ lineItem: 'gpt-5, output', amountUsd: 110 }], [{ date: today, amountUsd: 110 }]),
    );
    const d = await getCostDashboard(30);
    expect(d.budget.monthToDateUsd).toBeCloseTo(110, 1);
    expect(d.budget.capRisk).toBe('critical');
  });
});
