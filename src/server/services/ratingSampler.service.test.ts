// Rating-queue sampler (eval program WP2): the allocation is pure and seeded,
// so stratification, crisis oversampling and the second-rater fraction are
// checked exactly rather than statistically.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getRatingCandidates: vi.fn(),
  getRatingCandidatesByIds: vi.fn(),
  insertRatingQueueRows: vi.fn(),
}));
vi.mock('../db/index.js', () => dbMocks);
const configMock = vi.hoisted(() => ({ getSystemConfig: vi.fn(async () => ({ evals: { rating_second_rater_fraction: 0.5 } })) }));
vi.mock('../utils/sessionHelpers.js', () => configMock);

import {
  stratifySample,
  isoWeekKey,
  riskBand,
  modalityOf,
  stratumOf,
  isCrisisAdjacent,
  seededRng,
  getSecondRaterFraction,
  enqueueStratifiedSample,
  enqueueSessions,
} from './ratingSampler.service.js';
import type { RatingCandidateRow } from '../db/index.js';

function candidate(id: string, over: Partial<RatingCandidateRow> = {}): RatingCandidateRow {
  return {
    session_id: id,
    session_type: 'chat',
    ended_at: new Date('2026-10-14T12:00:00Z'), // ISO week 42
    crisis_flagged: false,
    max_risk_score: 0,
    crisis_event_count: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.insertRatingQueueRows.mockImplementation(async (rows: unknown[]) => rows);
});

describe('stratum keys', () => {
  it('maps risk scores to the >= 25 / 50 / 75 bands', () => {
    expect(riskBand(0)).toBe('none');
    expect(riskBand(24)).toBe('none');
    expect(riskBand(25)).toBe('low');
    expect(riskBand(50)).toBe('moderate');
    expect(riskBand(75)).toBe('high');
    expect(riskBand(null)).toBe('none');
  });

  it('maps realtime sessions to voice and everything else to chat', () => {
    expect(modalityOf('realtime')).toBe('voice');
    expect(modalityOf('chat')).toBe('chat');
    expect(modalityOf(null)).toBe('chat');
  });

  it('computes ISO week keys across a year boundary', () => {
    expect(isoWeekKey(new Date('2026-10-14T12:00:00Z'))).toBe('2026-W42');
    expect(isoWeekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(isoWeekKey(new Date('2026-01-04T12:00:00Z'))).toBe('2026-W01');
    expect(isoWeekKey(new Date('2026-12-28T00:00:00Z'))).toBe('2026-W53');
  });

  it('builds modality|band|week', () => {
    expect(stratumOf(candidate('a', { session_type: 'realtime', max_risk_score: 80 }))).toBe('voice|high|2026-W42');
  });

  it('treats flagged, event-bearing, or moderate+ sessions as crisis-adjacent', () => {
    expect(isCrisisAdjacent(candidate('a'))).toBe(false);
    expect(isCrisisAdjacent(candidate('a', { max_risk_score: 30 }))).toBe(false);
    expect(isCrisisAdjacent(candidate('a', { max_risk_score: 50 }))).toBe(true);
    expect(isCrisisAdjacent(candidate('a', { crisis_flagged: true }))).toBe(true);
    expect(isCrisisAdjacent(candidate('a', { crisis_event_count: 1 }))).toBe(true);
  });
});

describe('stratifySample', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const pool = Array.from({ length: 40 }, (_, i) => candidate(`s${String(i).padStart(2, '0')}`, { max_risk_score: (i * 7) % 100 }));
    const a = stratifySample(pool, { size: 10, seed: 42 });
    const b = stratifySample(pool, { size: 10, seed: 42 });
    const c = stratifySample(pool, { size: 10, seed: 43 });
    expect(a).toEqual(b);
    expect(a.picks.map(p => p.session_id)).not.toEqual(c.picks.map(p => p.session_id));
  });

  it('covers every non-empty stratum before allocating proportionally, never exceeding size', () => {
    const pool = [
      ...Array.from({ length: 30 }, (_, i) => candidate(`chat-none-${i}`)),
      ...Array.from({ length: 3 }, (_, i) => candidate(`voice-none-${i}`, { session_type: 'realtime' })),
      candidate('chat-high-0', { max_risk_score: 90 }),
      candidate('w43-0', { ended_at: new Date('2026-10-21T12:00:00Z') }),
    ];
    const { picks, allocations } = stratifySample(pool, { size: 8, seed: 1 });
    expect(picks).toHaveLength(8);
    expect(allocations.map(a => a.stratum)).toEqual(['chat|high|2026-W42', 'chat|none|2026-W42', 'chat|none|2026-W43', 'voice|none|2026-W42']);
    for (const a of allocations) expect(a.allocated).toBeGreaterThanOrEqual(1);
    expect(allocations.find(a => a.stratum === 'chat|none|2026-W42')!.allocated).toBeGreaterThan(
      allocations.find(a => a.stratum === 'voice|none|2026-W42')!.allocated
    );
    expect(new Set(picks.map(p => p.session_id)).size).toBe(8);
  });

  it('never allocates more than a stratum holds and never picks beyond the pool', () => {
    const pool = [candidate('a'), candidate('b', { session_type: 'realtime' })];
    const { picks, allocations } = stratifySample(pool, { size: 10, seed: 9 });
    expect(picks).toHaveLength(2);
    for (const a of allocations) expect(a.allocated).toBeLessThanOrEqual(a.candidates);
  });

  it('oversamples crisis-adjacent sessions: strata heavy with them get more slots', () => {
    // Two equally sized strata; one is entirely crisis-adjacent.
    const pool = [
      ...Array.from({ length: 10 }, (_, i) => candidate(`calm-${i}`)),
      ...Array.from({ length: 10 }, (_, i) => candidate(`hot-${i}`, { session_type: 'realtime', crisis_flagged: true })),
    ];
    const { allocations } = stratifySample(pool, { size: 8, seed: 5, crisisOversample: 3 });
    const calm = allocations.find(a => a.stratum.startsWith('chat'))!.allocated;
    const hot = allocations.find(a => a.stratum.startsWith('voice'))!.allocated;
    expect(hot).toBeGreaterThan(calm);
    expect(hot + calm).toBe(8);
  });

  it('prefers crisis-adjacent sessions inside a stratum', () => {
    // One stratum: 2 crisis-adjacent (same band via flag, not score) among 20.
    const pool = Array.from({ length: 20 }, (_, i) => candidate(`s${i}`, { crisis_flagged: i < 2 }));
    let hits = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { picks } = stratifySample(pool, { size: 4, seed, crisisOversample: 10 });
      hits += picks.filter(p => p.crisis_adjacent).length;
    }
    // 2 of 20 at weight 10 vs 18 at weight 1: expect well above the 0.4/draw base rate.
    expect(hits).toBeGreaterThan(20);
  });

  it('marks the configured fraction for a second rater (0 and 1 are exact)', () => {
    const pool = Array.from({ length: 30 }, (_, i) => candidate(`s${i}`));
    expect(stratifySample(pool, { size: 30, seed: 2, secondRaterFraction: 0 }).picks.every(p => !p.needs_second_rater)).toBe(true);
    expect(stratifySample(pool, { size: 30, seed: 2, secondRaterFraction: 1 }).picks.every(p => p.needs_second_rater)).toBe(true);
    const some = stratifySample(pool, { size: 30, seed: 2, secondRaterFraction: 0.3 }).picks.filter(p => p.needs_second_rater).length;
    expect(some).toBeGreaterThan(0);
    expect(some).toBeLessThan(30);
  });

  it('returns nothing for an empty pool or size 0', () => {
    expect(stratifySample([], { size: 5 }).picks).toEqual([]);
    expect(stratifySample([candidate('a')], { size: 0 }).picks).toEqual([]);
  });
});

describe('seededRng', () => {
  it('produces the same stream for the same seed, in [0, 1)', () => {
    const a = seededRng(7);
    const b = seededRng(7);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('getSecondRaterFraction', () => {
  it('reads evals.rating_second_rater_fraction and clamps it', async () => {
    expect(await getSecondRaterFraction()).toBe(0.5);
    configMock.getSystemConfig.mockResolvedValueOnce({ evals: { rating_second_rater_fraction: 7 } });
    expect(await getSecondRaterFraction()).toBe(1);
    configMock.getSystemConfig.mockResolvedValueOnce({ evals: {} });
    expect(await getSecondRaterFraction()).toBe(0.2);
  });
});

describe('enqueueStratifiedSample', () => {
  it('inserts the picks with source stratified, or nothing on a dry run', async () => {
    dbMocks.getRatingCandidates.mockResolvedValue([candidate('a'), candidate('b'), candidate('c')]);
    const dry = await enqueueStratifiedSample({ size: 2, seed: 3, dryRun: true });
    expect(dry.picks).toHaveLength(2);
    expect(dry.inserted).toEqual([]);
    expect(dbMocks.insertRatingQueueRows).not.toHaveBeenCalled();

    const real = await enqueueStratifiedSample({ size: 2, seed: 3, enqueuedBy: 9 });
    expect(real.picks.map(p => p.session_id)).toEqual(dry.picks.map(p => p.session_id));
    const [rows, by] = dbMocks.insertRatingQueueRows.mock.calls[0];
    expect(by).toBe(9);
    expect(rows.every((r: { source: string }) => r.source === 'stratified')).toBe(true);
    expect(real.second_rater_fraction).toBe(0.5);
  });
});

describe('enqueueSessions', () => {
  it('enqueues eligible ids with the given source and reports the rest as skipped', async () => {
    dbMocks.getRatingCandidatesByIds.mockResolvedValue([candidate('ok', { max_risk_score: 60 })]);
    const result = await enqueueSessions(['ok', 'missing'], 'disagreement', 4, 0);
    expect(result.skipped).toEqual(['missing']);
    const [rows] = dbMocks.insertRatingQueueRows.mock.calls[0];
    expect(rows).toEqual([
      { session_id: 'ok', stratum: 'chat|moderate|2026-W42', source: 'disagreement', crisis_adjacent: true, needs_second_rater: false },
    ]);
  });
});
