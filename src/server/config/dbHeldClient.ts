// A pool view for code that holds one connection for the life of the process
// (the socket.io Postgres adapter's LISTEN client), ai-therapist-366.
//
// The adapter checks a client out, LISTENs on it, and when that connection
// ends (the backend was terminated, Postgres restarted, the network dropped)
// it drops its reference and checks out a new one. It never releases the dead
// one, and pg-pool does not remove a checked-out client on its own, so each
// such event used to leave one pool slot taken for good. Before the pool had a
// permanent 'error' listener on every client (config/db.ts) the same event
// crashed the process instead, which hid the leak. Measured on a pool of 3:
// three backend terminations of the LISTEN connection left every later
// connect() waiting until the acquire timeout.
//
// Here the client is released with an error when its connection ends, so
// pg-pool destroys it and frees the slot. The release function is the one
// handed out for that checkout: if the holder has already released the
// client (it may since have gone to someone else), the call is refused by
// pg-pool and ignored here, never applied to the new borrower's checkout.
// Holds no pool of its own, so tests that mock config/db.js are unaffected.
import type pkg from 'pg';
import type { PoolClient } from 'pg';

export function releaseOnEnd(pool: pkg.Pool): pkg.Pool {
  const connect = async (): Promise<PoolClient> => {
    const client = await pool.connect();
    const release = client.release;
    client.once('end', () => {
      try {
        release(new Error('held connection ended'));
      } catch {
        // Already released by its holder: nothing of ours to free.
      }
    });
    return client;
  };
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === 'connect') return connect;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
