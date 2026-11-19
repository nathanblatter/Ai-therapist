// DB liveness probe for the deep health check (ai-therapist-159). Kept in the
// db layer so the health route never touches the pool directly.
import { pool, type PoolStats } from '../config/db.js';

/**
 * SELECT 1 with a hard timeout. Returns false instead of throwing — the
 * health route maps false to 503, and the caller must never hang: a wedged
 * pool is exactly the failure this probe exists to expose.
 */
export async function pingDatabase(timeoutMs = 2500): Promise<boolean> {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('db ping timeout')), timeoutMs);
        (t as { unref?: () => void }).unref?.();
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pool's size, in-use, waiting and timeout counters (ai-therapist-366),
 * for the deep health check: what to watch while the bounds bake on stage.
 * Counts only, never a query or a credential. Null when unavailable.
 */
export function getDatabasePoolStats(): PoolStats | null {
  const stats = (pool as { stats?: () => PoolStats }).stats;
  if (typeof stats !== 'function') return null;
  try {
    return stats.call(pool);
  } catch {
    return null;
  }
}
