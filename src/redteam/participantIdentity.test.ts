// Offline: the reserved-identity guard (ai-therapist-306).
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { participantIdentityProblem, RESERVED_PARTICIPANT_USERID_MIN } from './participantIdentity.js';
import { ALL_SCENARIOS, EXTENDED_SCENARIOS } from './scenarios/index.js';
import type { DbLike } from './types.js';

const poolWith = (rows: Array<Record<string, unknown>>): DbLike => ({ query: async () => ({ rows }) });

describe('participantIdentityProblem', () => {
  it('allows a participant with a reserved userid', async () => {
    expect(await participantIdentityProblem(poolWith([{ userid: 1_900_000_042 }]))).toBeNull();
    expect(
      await participantIdentityProblem(poolWith([{ userid: String(RESERVED_PARTICIPANT_USERID_MIN) }])),
    ).toBeNull();
  });

  it('REFUSES a participant seeded on the users sequence, whose identifier a real user may share', async () => {
    const problem = await participantIdentityProblem(poolWith([{ userid: 2 }]));
    expect(problem).toContain('not run');
    expect(problem).toContain('userid 2');
    expect(problem).toContain('ai-therapist-306');
  });

  it('refuses when the participant is missing or the id is unreadable', async () => {
    expect(await participantIdentityProblem(poolWith([]))).toContain('not found');
    expect(await participantIdentityProblem(poolWith([{ userid: null }]))).toContain('not run');
  });
});

describe('reserved harness identity wiring', () => {
  it('the seed script seeds the participant inside the reserved range', () => {
    const seed = fs.readFileSync(path.resolve(__dirname, '../../scripts/redteam-seed-user.mjs'), 'utf8');
    const m = /REDTEAM_PARTICIPANT_USERID \|\| (\d+)/.exec(seed);
    expect(m, 'default reserved userid in scripts/redteam-seed-user.mjs').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(RESERVED_PARTICIPANT_USERID_MIN);
  });

  it('both minors-refusal scenarios require the reserved participant, and nothing else does', () => {
    const guarded = [...ALL_SCENARIOS, ...EXTENDED_SCENARIOS]
      .filter((s) => s.requiresReservedParticipant)
      .map((s) => s.id);
    expect(guarded.sort()).toEqual(['minor-sexual-content-referral', 'minor-sexual-content-refusal']);
  });
});
