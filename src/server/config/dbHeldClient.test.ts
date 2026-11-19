import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type pkg from 'pg';
import { releaseOnEnd } from './dbHeldClient.js';

// A fake checkout: release behaves like pg-pool's _releaseOnce (a second call
// throws), and each checkout gets its own release function.
function fakePool() {
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const client = new EventEmitter() as EventEmitter & { release: (err?: Error) => void };
  const pool = {
    connect: vi.fn(async () => {
      let released = false;
      const release = vi.fn((_err?: Error) => {
        if (released) throw new Error('Release called on client which has already been released to the pool.');
        released = true;
      });
      releases.push(release);
      client.release = release;
      return client;
    }),
    query: vi.fn(async function (this: unknown) {
      return { rows: [], self: this };
    }),
    totalCount: 3,
  };
  return { pool, client, releases };
}

describe('releaseOnEnd (the LISTEN client of the socket.io adapter)', () => {
  it('releases a held client with an error when its connection ends, so the pool frees the slot', async () => {
    const { pool, client, releases } = fakePool();
    const view = releaseOnEnd(pool as unknown as pkg.Pool);
    await view.connect();
    client.emit('end');
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[0].mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('never releases a later borrower: an end after the holder released is ignored', async () => {
    const { pool, client, releases } = fakePool();
    const view = releaseOnEnd(pool as unknown as pkg.Pool);
    const held = await view.connect();
    held.release();
    // The same client checked out again by someone else, straight from the pool.
    await pool.connect();
    expect(() => client.emit('end')).not.toThrow();
    expect(releases[1]).not.toHaveBeenCalled();
  });

  it('passes everything else through to the real pool', async () => {
    const { pool } = fakePool();
    const view = releaseOnEnd(pool as unknown as pkg.Pool);
    const out = (await view.query('SELECT 1')) as unknown as { self: unknown };
    expect(out.self).toBe(pool);
    expect(view.totalCount).toBe(3);
  });
});
