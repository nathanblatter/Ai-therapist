// Where the working-alliance rating hook sits in the redaction job
// (ai-therapist-173): after the leak check of the same job has settled, never
// before, and without the job waiting for either. The judge does not read a
// message the leak check flagged, so a rating started while the check is
// still running would read text the check was about to withhold.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  pending: [] as Array<{ message_id: number; content: string }>,
  verifier: null as null | { resolve: () => void; reject: (err: Error) => void },
  verifyCalls: [] as Array<{ sessionId: string; ids: number[] }>,
  hookCalls: [] as string[],
}));

vi.mock('../config/db.js', () => ({
  pool: {
    query: vi.fn(async (sql: string) =>
      /^\s*SELECT/i.test(sql) ? { rows: state.pending } : { rows: [], rowCount: 1 },
    ),
  },
}));
vi.mock('./redaction.service.js', () => ({
  redactPHIBatch: vi.fn(
    async (items: Array<{ id: number; content: string }>) => new Map(items.map((i) => [i.id, `[redacted ${i.id}]`])),
  ),
}));
vi.mock('./redactionVerifier.service.js', () => ({
  verifyRedactedMessages: vi.fn((sessionId: string, items: Array<{ id: number }>) => {
    state.verifyCalls.push({ sessionId, ids: items.map((i) => i.id) });
    return new Promise<void>((resolve, reject) => {
      state.verifier = { resolve, reject };
    });
  }),
}));
vi.mock('./allianceRating.service.js', () => ({
  maybeRateAllianceForSession: vi.fn(async (sessionId: string) => {
    state.hookCalls.push(sessionId);
  }),
}));
vi.mock('./harnessPostSession.service.js', () => ({ shouldSkipPostSessionWork: vi.fn(async () => false) }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn(async () => undefined) }));

const { redactSession } = await import('./sessionRedaction.service.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  state.pending = [{ message_id: 1, content: 'hello' }];
  state.verifier = null;
  state.verifyCalls = [];
  state.hookCalls = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('alliance rating hook in the redaction job', () => {
  it('runs only after the leak check has finished, and the job waits for neither', async () => {
    await redactSession('sess_a'); // resolves while the leak check is still running
    await settle();
    expect(state.verifyCalls).toEqual([{ sessionId: 'sess_a', ids: [1] }]);
    expect(state.hookCalls).toEqual([]);

    state.verifier!.resolve();
    await settle();
    expect(state.hookCalls).toEqual(['sess_a']);
  });

  it('still runs when the leak check fails: the unchecked messages are simply not flagged', async () => {
    await redactSession('sess_b');
    await settle();
    expect(state.hookCalls).toEqual([]);
    state.verifier!.reject(new Error('verifier down'));
    await settle();
    expect(state.hookCalls).toEqual(['sess_b']);
  });

  it('does not run when the job redacted nothing', async () => {
    state.pending = [];
    await redactSession('sess_c');
    await settle();
    expect(state.verifyCalls).toEqual([]);
    expect(state.hookCalls).toEqual([]);
  });
});
