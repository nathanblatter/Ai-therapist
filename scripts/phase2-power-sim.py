#!/usr/bin/env python3
"""Phase 2 power simulation (ai-therapist-108). Pure numpy — no statsmodels, no R.

Simulates the primary confirmatory analysis of the Phase 2 longitudinal study
(single-arm observational cohort, BYU IRB 2025-519 successor) using the SAME
estimator the real analysis uses (scripts/phase2-analysis-plan.py):

  Random-intercept FGLS of score on week (method-of-moments variance
  components + the standard partial-demeaning GLS transform), with
  CLUSTER-ROBUST (sandwich) standard errors by participant, df = clusters - 1.

This uses every observed wave, weights clusters near-optimally (recovering the
efficiency of a mixed model), keeps inference valid under the true
random-slope heterogeneity via the sandwich, and needs only numpy. Two
alternatives were evaluated and rejected (reproduce with --estimator
pooled / twostage): at N=120, d=0.30 the naive unweighted two-stage
(per-person slope then t-test) gives 0.45 power because early dropouts
contribute extremely noisy slopes, plain pooled OLS + sandwich gives 0.86,
and this FGLS gives 0.97.

Design assumptions (documented in docs/phase2-power-analysis.md):
  - Waves: Week 0 (baseline) through Week 8, 9 measurement occasions.
  - Enrollment N varied: 80 / 100 / 120.
  - Attrition: constant weekly dropout hazard ~30% cumulative by Week 8
    (digital mental health studies routinely lose 25-40%); MAR after dropout.
  - Occasion-level missingness: 20% of remaining waves skipped at random.
  - PHQ-2 ~ continuous (0-6): baseline mean 2.2, between-person intercept SD
    1.2, between-person slope SD 0.04/wk, residual SD 0.9, truncated 0-6.
  - Effect: standardized total change by Week 8 d = 0.20 / 0.30 / 0.45,
    where d = (change in points by Week 8) / TOTAL baseline SD
    (sqrt(intercept_sd^2 + residual_sd^2) ~= 1.5). This is the same scale the
    analysis script reports (empirical SD of week-0 scores), so the power
    table's d and the analysis's printed d are directly comparable.
  - Test: FGLS slope with cluster-robust SE, t(G-1), two-sided alpha = .05.

Run:  python3 scripts/phase2-power-sim.py   (seed fixed; ~1 min, pure numpy)
"""
import sys
import time

import numpy as np

import argparse

RNG_SEED = 20260902
WEEKS = np.arange(0, 9)
BASELINE_MEAN = 2.2
INTERCEPT_SD = 1.2
SLOPE_SD = 0.04
RESIDUAL_SD = 0.9
WEEKLY_DROPOUT = 1 - (1 - 0.30) ** (1 / 8)
OCCASION_MISS = 0.20
# d is defined against the TOTAL baseline SD — the same quantity the analysis
# script estimates from week-0 scores — not the latent between-person SD.
TOTAL_BASELINE_SD = float(np.sqrt(INTERCEPT_SD ** 2 + RESIDUAL_SD ** 2))
N_REPS = 2000
ALPHA = 0.05

ENROLLMENTS = [80, 100, 120]
EFFECTS_D = [0.20, 0.30, 0.45]

# two-sided t critical values by df (df = n_participants-1 is always large here,
# so the normal approx is fine, but use scipy-free exact-ish via numpy: for the
# df we see (>=50) the 0.975 t-quantile is ~2.0-2.01; use a small lookup + normal
# fallback so we stay dependency-free).
def t_crit_975(df: int) -> float:
    # Cornish-Fisher-free: interpolate a tiny table, fall back to z for large df.
    table = {1: 12.706, 2: 4.303, 5: 2.571, 10: 2.228, 20: 2.086, 30: 2.042,
             40: 2.021, 50: 2.009, 60: 2.000, 80: 1.990, 100: 1.984, 120: 1.980}
    if df >= 120:
        return 1.960 + (1.980 - 1.960) * (120 / max(df, 120))  # ~1.96-1.98
    keys = sorted(table)
    for i in range(len(keys) - 1):
        lo, hi = keys[i], keys[i + 1]
        if lo <= df <= hi:
            f = (df - lo) / (hi - lo)
            return table[lo] + f * (table[hi] - table[lo])
    return table[keys[-1]]


def simulate_long(rng: np.random.Generator, n: int, d: float):
    """Simulate the long-format dataset: (participant, week, score) triples."""
    slope_mean = -(d * TOTAL_BASELINE_SD) / 8.0   # improvement => negative slope
    intercepts = rng.normal(BASELINE_MEAN, INTERCEPT_SD, n)
    slopes = rng.normal(slope_mean, SLOPE_SD, n)
    dropout_week = rng.geometric(WEEKLY_DROPOUT, n)
    pid, wk, sc = [], [], []
    for i in range(n):
        for w in WEEKS:
            if w >= dropout_week[i]:
                break
            if w > 0 and rng.random() < OCCASION_MISS:
                continue
            y = intercepts[i] + slopes[i] * w + rng.normal(0, RESIDUAL_SD)
            pid.append(i)
            wk.append(float(w))
            sc.append(float(np.clip(y, 0, 6)))
    return np.array(pid), np.array(wk), np.array(sc)


def random_intercept_fgls_reject(pid: np.ndarray, wk: np.ndarray, sc: np.ndarray) -> bool:
    """Random-intercept FGLS slope of score~week with cluster-robust (CR0
    sandwich) SEs; two-sided t vs 0 with df = clusters - 1.

    Step 1 (variance components, method of moments): within-person variance
    from person-demeaned OLS residuals; between-person variance from the excess
    variance of cluster mean residuals.
    Step 2 (GLS): the standard random-effects partial-demeaning transform
    y*_ij = y_ij - theta_i * ybar_i with theta_i = 1 - sqrt(s2e/(s2e+n_i*s2u)),
    then pooled OLS on transformed data. Sandwich SEs keep inference valid even
    where the random-intercept working model is only approximate (there is also
    slope heterogeneity in truth)."""
    if len(sc) < 10:
        return False
    clusters = np.unique(pid)
    G = len(clusters)
    if G < 3:
        return False
    X = np.column_stack([np.ones_like(wk), wk])

    # Step 1: pooled OLS residuals -> variance components
    beta0 = np.linalg.lstsq(X, sc, rcond=None)[0]
    resid = sc - X @ beta0
    s2_within_num, s2_within_den = 0.0, 0
    cluster_masks = [pid == g for g in clusters]
    for m in cluster_masks:
        r = resid[m]
        if len(r) > 1:
            s2_within_num += np.sum((r - r.mean()) ** 2)
            s2_within_den += len(r) - 1
    s2e = s2_within_num / max(s2_within_den, 1)
    # between: Var(cluster mean resid) ~= s2u + s2e/n_i  (moment estimate)
    means = np.array([resid[m].mean() for m in cluster_masks])
    ns = np.array([m.sum() for m in cluster_masks])
    s2u = max(float(np.var(means, ddof=1) - s2e * np.mean(1.0 / ns)), 0.0)

    # Step 2: partial demeaning per cluster, then OLS + cluster sandwich
    theta = 1.0 - np.sqrt(s2e / (s2e + ns * s2u)) if s2u > 0 else np.zeros(G)
    Xs = X.copy().astype(float)
    ys = sc.copy().astype(float)
    for i, m in enumerate(cluster_masks):
        th = theta[i] if s2u > 0 else 0.0
        Xs[m] = Xs[m] - th * Xs[m].mean(axis=0)
        ys[m] = ys[m] - th * ys[m].mean()
    XtX_inv = np.linalg.inv(Xs.T @ Xs)
    beta = XtX_inv @ (Xs.T @ ys)
    r2 = ys - Xs @ beta
    # CR2 (Bell-McCaffrey) sandwich: adjust each cluster's residuals by
    # (I - H_gg)^{-1/2} before forming the meat. Plain CR0 ran liberal here
    # (empirical size ~0.057 at G=120 over 6000 null replicates) because
    # cluster sizes vary 1-9 and high-leverage clusters get shrunken
    # residuals; CR2 undoes exactly that shrinkage.
    meat = np.zeros((2, 2))
    for m in cluster_masks:
        Xg = Xs[m]
        Hgg = Xg @ XtX_inv @ Xg.T
        w, Q = np.linalg.eigh(np.eye(len(Xg)) - Hgg)
        w = np.clip(w, 1e-10, None)
        adj = Q @ np.diag(1.0 / np.sqrt(w)) @ Q.T
        s = Xg.T @ (adj @ r2[m])
        meat += np.outer(s, s)
    V = XtX_inv @ meat @ XtX_inv
    se = np.sqrt(V[1, 1])
    if se == 0:
        return beta[1] != 0
    t = beta[1] / se
    return abs(t) > t_crit_975(G - 1)


def twostage_reject(pid: np.ndarray, wk: np.ndarray, sc: np.ndarray) -> bool:
    """Naive two-stage comparison estimator: per-person OLS slope, one-sample
    t. Kept ONLY so the estimator-selection numbers in
    docs/phase2-power-analysis.md are reproducible (--estimator twostage)."""
    slopes = []
    for g in np.unique(pid):
        m = pid == g
        if m.sum() >= 2 and len(set(wk[m])) >= 2:
            slopes.append(np.polyfit(wk[m], sc[m], 1)[0])
    slopes = np.array(slopes)
    n = len(slopes)
    if n < 3:
        return False
    sd = slopes.std(ddof=1)
    if sd == 0:
        return slopes.mean() != 0
    t = slopes.mean() / (sd / np.sqrt(n))
    return abs(t) > t_crit_975(n - 1)


def pooled_ols_reject(pid: np.ndarray, wk: np.ndarray, sc: np.ndarray) -> bool:
    """Pooled OLS + CR0 sandwich comparison estimator (--estimator pooled)."""
    if len(sc) < 10:
        return False
    clusters = np.unique(pid)
    G = len(clusters)
    if G < 3:
        return False
    X = np.column_stack([np.ones_like(wk), wk])
    XtX_inv = np.linalg.inv(X.T @ X)
    beta = XtX_inv @ (X.T @ sc)
    resid = sc - X @ beta
    meat = np.zeros((2, 2))
    for g in clusters:
        m = pid == g
        srow = X[m].T @ resid[m]
        meat += np.outer(srow, srow)
    # CR1 small-sample correction (G/(G-1), the Stata default): the plain
    # CR0 sandwich ran mildly liberal here (empirical size ~0.055-0.058 at
    # G=120 over 6000 null replicates); CR1 pulls it back toward nominal.
    V = (G / (G - 1)) * (XtX_inv @ meat @ XtX_inv)
    se = np.sqrt(V[1, 1])
    if se == 0:
        return beta[1] != 0
    return abs(beta[1] / se) > t_crit_975(G - 1)


ESTIMATORS = {
    "fgls": random_intercept_fgls_reject,
    "pooled": pooled_ols_reject,
    "twostage": twostage_reject,
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--estimator", choices=sorted(ESTIMATORS), default="fgls",
                    help="fgls is the pre-registered estimator; pooled/twostage "
                         "reproduce the estimator-selection comparison")
    args = ap.parse_args()
    reject = ESTIMATORS[args.estimator]
    rng = np.random.default_rng(RNG_SEED)
    print(f"Phase 2 power sim (estimator={args.estimator}) — seed {RNG_SEED}, "
          f"{N_REPS} reps/cell, pure numpy, d scaled to total baseline SD "
          f"{TOTAL_BASELINE_SD:.3f}")
    print(f"weekly dropout {WEEKLY_DROPOUT:.4f} (~30% by wk8), "
          f"occasion missingness {OCCASION_MISS:.0%}")
    results = []
    for n in ENROLLMENTS:
        for d in EFFECTS_D:
            t0 = time.time()
            hits = 0
            completers = []
            for _ in range(N_REPS):
                pid, wk, sc = simulate_long(rng, n, d)
                # participants contributing a usable trajectory (>= 2 waves) —
                # everyone has a week-0 row, so a raw count is tautologically N
                upid, counts = np.unique(pid, return_counts=True)
                completers.append(int((counts >= 2).sum()))
                if reject(pid, wk, sc):
                    hits += 1
            power = hits / N_REPS
            results.append({
                "enrolled": n, "effect_d": d, "power": round(power, 3),
                "reps": N_REPS,
                "mean_ge2_waves": round(float(np.mean(completers)), 1),
                "secs": round(time.time() - t0, 1),
            })
            print(f"  N={n:3d} d={d:.2f}  power={power:.3f} "
                  f"(~{np.mean(completers):.0f} with >=2 waves, {time.time()-t0:.0f}s)")
    import csv
    out_path = ("docs/phase2-power-sim-results.csv" if args.estimator == "fgls"
                else f"docs/phase2-power-sim-results-{args.estimator}.csv")
    with open(out_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(results[0].keys()))
        w.writeheader()
        w.writerows(results)
    print(f"\nwrote {out_path}")


if __name__ == "__main__":
    sys.exit(main())
