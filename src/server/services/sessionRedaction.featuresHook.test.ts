// Where the session-features hook sits in the redaction job
// (ai-therapist-172): after the leak check of the same job has settled and
// after the alliance hook, never before the leak check, and without the job
// waiting for any of them. The judge does not read a message the leak check
// flagged, so an extraction started while the check is still running would
// read text the check was about to withhold. A failure of the alliance hook
// must not stop it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  pending: [] as Array<{ message_id: number; content: string }>,
  verifier: null as null | { resolve: () => void; reject: (err: Error) => void },
  order: [] as string[],
  allianceThrows: false,
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
  verifyRedactedMessages: vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        state.verifier = { resolve, reject };
      }),
  ),
}));
vi.mock('./allianceRating.service.js', () => ({
  maybeRateAllianceForSession: vi.fn(async (sessionId: string) => {
    state.order.push(`alliance:${sessionId}`);
    if (state.allianceThrows) throw new Error('alliance hook down');
  }),
}));
vi.mock('./sessionFeatures.service.js', () => ({
  maybeExtractFeaturesForSession: vi.fn(async (sessionId: string) => {
    state.order.push(`features:${sessionId}`);
  }),
}));
vi.mock('./harnessPostSession.service.js', () => ({ shouldSkipPostSessionWork: vi.fn(async () => false) }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn(async () => undefined) }));

const { redactSession } = await import('./sessionRedaction.service.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  state.pending = [{ message_id: 1, content: 'hello' }];
  state.verifier = null;
  state.order = [];
  state.allianceThrows = false;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('session-features hook in the redaction job', () => {
  it('runs only after the leak check has finished, and the job waits for neither', async () => {
    await redactSession('sess_a'); // resolves while the leak check is still running
    await settle();
    expect(state.order).toEqual([]);

    state.verifier!.resolve();
    await settle();
    expect(state.order).toEqual(['alliance:sess_a', 'features:sess_a']);
  });

  it('still runs when the leak check fails and when the alliance hook fails', async () => {
    state.allianceThrows = true;
    await redactSession('sess_b');
    await settle();
    expect(state.order).toEqual([]);
    state.verifier!.reject(new Error('verifier down'));
    await settle();
    expect(state.order).toEqual(['alliance:sess_b', 'features:sess_b']);
  });

  it('does not run when the job redacted nothing', async () => {
    state.pending = [];
    await redactSession('sess_c');
    await settle();
    expect(state.order).toEqual([]);
  });
});
