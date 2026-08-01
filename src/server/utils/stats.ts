// Small statistics helpers shared by the pairwise-eval route and its tests.

/**
 * Wilson score interval for a binomial proportion, z = 1.959964 (95%).
 *   center = (p̂ + z²/2n) / (1 + z²/n)
 *   half   = z * sqrt( p̂(1-p̂)/n + z²/4n² ) / (1 + z²/n)
 *   [lo, hi] = [center - half, center + half], clamped to [0,1]
 * Returns null when n === 0.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.959964
): { p: number; lo: number; hi: number } | null {
  if (n === 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lo = Math.max(0, center - half);
  const hi = Math.min(1, center + half);
  return { p, lo, hi };
}
