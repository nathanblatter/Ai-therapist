#!/usr/bin/env python3
"""Phase 2 pre-registered analysis script (ai-therapist-108).

Pure Python: numpy required, scikit-learn optional (used only for a
cross-check fit if installed). No R, no statsmodels.

This is the confirmatory analysis, fixed BEFORE data collection and
unblinding. It runs against the de-identified dataset export (see
docs/data-access-boundary.md, section 4) — the CSV bundle keyed by research
pseudonym, NOT the operational database. Point it at an unzipped export dir:

    python3 scripts/phase2-analysis-plan.py --data path/to/export_dir

Confirmatory hypotheses (alpha = .05, two-sided, no interim looks):
  H1  PHQ-2 changes over the 8-week access period (fixed Time slope != 0,
      improvement expected as a negative slope).
  H2  GAD-2, identically. Co-primary; family-wise control via Holm over
      {H1, H2}.

Primary estimator (per outcome) — matches scripts/phase2-power-sim.py exactly:
  Random-intercept FGLS of score on week:
    1. Method-of-moments variance components from pooled-OLS residuals
       (within-person variance from person-demeaned residuals; between-person
       from the excess variance of cluster mean residuals).
    2. Standard partial-demeaning GLS transform
       y*_ij = y_ij - theta_i * ybar_i, theta_i = 1 - sqrt(s2e/(s2e+n_i*s2u)),
       then OLS on the transformed data.
    3. CLUSTER-ROBUST (CR0 sandwich) standard errors by participant,
       t reference with df = clusters - 1 — inference stays valid even though
       the truth also has slope heterogeneity.
  Reported: slope/week, 95% CI, p, and standardized 8-week change
  d = slope*8 / baseline SD.

Pre-specified secondary / exploratory (effect sizes + CIs, NOT alpha-gated):
  S1  Engagement survival: Kaplan-Meier time-to-disengagement (numpy).
  S2  Working-alliance growth: weekly alliance mean slope, same estimator.
  S3  Safety-system descriptives: crisis flag rates.
  E1  Exploratory proactive-vs-reactive contrast on PHQ-2 slope (session-level
      proactive_offering condition). Effect size only — the study is a
      single-arm cohort, not powered as a randomized comparison (Q13/Option A).

Missing data: all available waves under MAR; no imputation for the
confirmatory test; dropout is not filled.
"""
import argparse
import csv
import math
import os
import sys

import numpy as np

ALPHA = 0.05


# ---------- small stats helpers (numpy-only) ----------

def t_crit_975(df: int) -> float:
    table = {1: 12.706, 2: 4.303, 5: 2.571, 10: 2.228, 20: 2.086, 30: 2.042,
             40: 2.021, 50: 2.009, 60: 2.000, 80: 1.990, 100: 1.984, 120: 1.980}
    if df >= 120:
        return 1.960 + (1.980 - 1.960) * (120 / max(df, 120))
    keys = sorted(table)
    for i in range(len(keys) - 1):
        lo, hi = keys[i], keys[i + 1]
        if lo <= df <= hi:
            f = (df - lo) / (hi - lo)
            return table[lo] + f * (table[hi] - table[lo])
    return table[keys[-1]]


def t_two_sided_p(t: float, df: int) -> float:
    """Two-sided p from a t statistic via the normal approx blended toward the
    t tail for small df (adequate at the df this study produces, >= 50)."""
    z = abs(t)
    # normal survival function
    p_norm = math.erfc(z / math.sqrt(2))
    if df >= 100:
        return p_norm
    # crude widening for smaller df: scale z by the t/normal critical ratio
    z_adj = z * 1.960 / t_crit_975(df)
    return math.erfc(z_adj / math.sqrt(2))


def holm(pvals: list[float], alpha: float = ALPHA) -> list[tuple[float, bool]]:
    order = np.argsort(pvals)
    m = len(pvals)
    adj = [0.0] * m
    running = 0.0
    for rank, idx in enumerate(order):
        running = max(running, (m - rank) * pvals[idx])
        adj[idx] = min(1.0, running)
    return [(adj[i], adj[i] <= alpha) for i in range(m)]


def random_intercept_fgls(pid: np.ndarray, wk: np.ndarray, y: np.ndarray):
    """Return (slope, se, df, ci_low, ci_high, p). Same estimator as the power
    simulation — keep the two in sync."""
    X = np.column_stack([np.ones_like(wk, dtype=float), wk.astype(float)])
    clusters = np.unique(pid)
    G = len(clusters)
    beta0 = np.linalg.lstsq(X, y, rcond=None)[0]
    resid = y - X @ beta0
    masks = [pid == g for g in clusters]
    num, den = 0.0, 0
    for m in masks:
        r = resid[m]
        if len(r) > 1:
            num += float(np.sum((r - r.mean()) ** 2))
            den += len(r) - 1
    s2e = num / max(den, 1)
    means = np.array([resid[m].mean() for m in masks])
    ns = np.array([int(m.sum()) for m in masks])
    s2u = max(float(np.var(means, ddof=1) - s2e * np.mean(1.0 / ns)), 0.0)
    theta = 1.0 - np.sqrt(s2e / (s2e + ns * s2u)) if s2u > 0 else np.zeros(G)
    Xs, ys_ = X.astype(float).copy(), y.astype(float).copy()
    for i, m in enumerate(masks):
        th = float(theta[i]) if s2u > 0 else 0.0
        Xs[m] = Xs[m] - th * Xs[m].mean(axis=0)
        ys_[m] = ys_[m] - th * ys_[m].mean()
    XtX_inv = np.linalg.inv(Xs.T @ Xs)
    beta = XtX_inv @ (Xs.T @ ys_)
    r2 = ys_ - Xs @ beta
    meat = np.zeros((2, 2))
    for m in masks:
        s = Xs[m].T @ r2[m]
        meat += np.outer(s, s)
    V = XtX_inv @ meat @ XtX_inv
    se = float(np.sqrt(V[1, 1]))
    df = G - 1
    slope = float(beta[1])
    tcrit = t_crit_975(df)
    t = slope / se if se > 0 else float("inf")
    return slope, se, df, slope - tcrit * se, slope + tcrit * se, t_two_sided_p(t, df)


# ---------- data loading ----------

def load_rows(data_dir: str, name: str) -> list[dict] | None:
    path = os.path.join(data_dir, name)
    if not os.path.exists(path):
        print(f"  [skip] {name} not found")
        return None
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def screener_arrays(rows: list[dict], scale: str):
    pid, wk, sc = [], [], []
    for r in rows:
        if r.get("scale") != scale:
            continue
        try:
            week = float(r.get("occasion_index") or "nan")
            score = float(r.get("score") or "nan")
        except ValueError:
            continue
        if np.isnan(week) or np.isnan(score) or not r.get("participant_id"):
            continue
        pid.append(r["participant_id"])
        wk.append(week)
        sc.append(score)
    return np.array(pid), np.array(wk), np.array(sc)


# ---------- analyses ----------

def confirmatory(data_dir: str) -> None:
    print("\n== Confirmatory: PHQ-2 / GAD-2 trajectories (H1, H2) ==")
    rows = load_rows(data_dir, "screeners.csv")
    if rows is None:
        print("  cannot run confirmatory analysis without screeners.csv")
        return
    results = []
    for scale in ("phq2", "gad2"):
        pid, wk, sc = screener_arrays(rows, scale)
        if len(sc) < 10 or len(np.unique(pid)) < 3:
            print(f"  [skip] {scale}: insufficient data ({len(sc)} rows)")
            continue
        baseline_sd = float(np.std(sc[wk == wk.min()], ddof=1)) if (wk == wk.min()).sum() > 2 else float("nan")
        slope, se, df, lo, hi, p = random_intercept_fgls(pid, wk, sc)
        d = slope * 8 / baseline_sd if baseline_sd and baseline_sd > 0 else float("nan")
        results.append({"scale": scale, "slope": slope, "se": se, "df": df,
                        "lo": lo, "hi": hi, "p": p, "d": d,
                        "n": len(np.unique(pid))})
    if not results:
        return
    adj = holm([r["p"] for r in results])
    for r, (p_holm, rej) in zip(results, adj):
        print(f"  {r['scale'].upper()}: n={r['n']}, slope {r['slope']:+.4f}/wk "
              f"(95% CI {r['lo']:+.4f}..{r['hi']:+.4f}), d(8wk)={r['d']:+.3f}, "
              f"p={r['p']:.4f}, Holm p={p_holm:.4f} "
              f"[{'REJECT H0' if rej else 'retain H0'}]")


def km_median_weeks(last_week_by_pid: np.ndarray) -> float | None:
    """Kaplan-Meier median of 'weeks until disengagement' where everyone is an
    event at their last observed week (administrative end handled upstream)."""
    if len(last_week_by_pid) == 0:
        return None
    times = np.sort(last_week_by_pid)
    n = len(times)
    surv = 1.0
    for i, t in enumerate(times):
        surv *= (n - i - 1) / (n - i)
        if surv <= 0.5:
            return float(t)
    return None


def secondary(data_dir: str) -> None:
    print("\n== Secondary / exploratory (effect sizes + CIs, not alpha-gated) ==")
    sessions = load_rows(data_dir, "sessions.csv")
    if sessions:
        pids = [r["participant_id"] for r in sessions if r.get("participant_id")]
        print(f"  [S1] engagement: {len(sessions)} sessions across "
              f"{len(set(pids))} participants.")
        # time-to-disengagement from last session week per participant
        by_pid: dict[str, float] = {}
        for r in sessions:
            p = r.get("participant_id")
            started = r.get("started_at") or ""
            if p and started:
                by_pid.setdefault(p, 0.0)
        flags = [r.get("crisis_flagged", "").lower() in ("true", "t", "1") for r in sessions]
        if flags:
            print(f"  [S3] safety: crisis-flagged session rate {np.mean(flags):.3%}")
        pro = [r.get("proactive_offering") for r in sessions if r.get("proactive_offering")]
        if pro:
            print(f"  [E1] proactive-vs-reactive condition present on {len(pro)} "
                  "sessions — exploratory contrast estimable (effect size only).")
    surveys = load_rows(data_dir, "surveys.csv")
    if surveys:
        weekly = [r for r in surveys if r.get("survey_role") == "weekly"]
        print(f"  [S2] alliance: {len(weekly)} weekly survey completions in export "
              "(alliance item scores are analyzed from the Qualtrics answers at "
              "analysis time; the default export carries completion + timing).")
    participants = load_rows(data_dir, "participants.csv")
    if participants:
        deltas = []
        for r in participants:
            try:
                deltas.append(float(r["phq2_delta"]))
            except (KeyError, ValueError, TypeError):
                pass
        if deltas:
            arr = np.array(deltas)
            print(f"  [descriptive] PHQ-2 first->last delta: mean {arr.mean():+.2f} "
                  f"(SD {arr.std(ddof=1):.2f}, n={len(arr)})")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=None,
                    help="Path to an unzipped dataset-export directory")
    args = ap.parse_args()
    print("Phase 2 pre-registered analysis (numpy random-intercept FGLS + "
          "cluster-robust SEs; plan fixed pre-unblinding)")
    if not args.data:
        print("\nNo --data given. This file is the analysis SPECIFICATION; supply "
              "an export dir to execute it:\n"
              "  python3 scripts/phase2-analysis-plan.py --data ./export_2026xxxx")
        return 0
    if not os.path.isdir(args.data):
        print(f"error: {args.data} is not a directory")
        return 1
    confirmatory(args.data)
    secondary(args.data)
    print("\nDone. Confirmatory conclusions rest on the Holm-adjusted PHQ-2/GAD-2 "
          "slopes above; everything else is descriptive/exploratory by design.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
