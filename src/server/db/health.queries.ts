// DB liveness probe for the deep health check (ai-therapist-159). Kept in the
// db layer so the health route never touches the pool directly.
import { pool } from '../config/db.js';

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
