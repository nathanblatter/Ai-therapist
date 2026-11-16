"""Power and sample-size simulation for the Phase 2 analysis.

Each replicate simulates a full study with synth.simulate_outcomes() and runs
the planned model on it, so power reflects the planned test rather than a
closed-form approximation. Fits use models.growth_model_fast (identical model
and REML criterion); a subsample of replicates in every cell is refitted with
the statsmodels estimator of record and the gap is reported.

Three questions:
  A  Primary (protocol design, single arm): power to detect a non-zero mean
     PHQ-2 change over the 8-week access period, across effect size x ICC x
     attrition at the planned enrollment of 120.
  B  The arm contrast the backlog item anticipated (slope difference by
     proactive_offering) IF participants were randomised 1:1 (protocol
     reserve "Option B"; not what the app does).
  C  The same contrast under what the app actually does today: each SESSION
     randomised 50/50, analysed as proactive-share x time.

    python -m phase2.power                 # full grid: 64 cells x 400 replicates, about 30 CPU-minutes
    python -m phase2.power --reps 40       # quick look
"""

from __future__ import annotations

import argparse
import os
import time
from itertools import product
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import pandas as pd

from . import ANALYSIS_VERSION
from .models import fgls_cr2, growth_model, growth_model_fast
from .synth import SimParams, panel_from_outcomes, simulate_outcomes

SEED = 20261116
RESULTS = Path(__file__).resolve().parents[1] / "results" / "power"

# Grid values and where they come from (see results/power/README.md).
EFFECTS = [0.0, 0.20, 0.30, 0.45]  # docs/phase2-power-analysis.md grid, plus 0 for type I error
ICCS = [0.30, 0.50, 0.64]  # 0.64 is implied by the September analysis; lower values are assumptions
ATTRITION = [0.17, 0.30, 0.40, 0.52]  # Yang 2026 pooled; planning value; top of the 25-40% range; Kuta 2026
ARM_EFFECTS = [0.0, 0.30, 0.50, 0.80]
ARM_ATTRITION = [0.17, 0.30, 0.40]


def _cells() -> list[dict]:
    cells = []
    for d, icc, att in product(EFFECTS, ICCS, ATTRITION):
        cells.append({"question": "A_primary_slope", "d": d, "icc": icc, "attrition": att, "assignment": "session", "d_arm": 0.0})
    for da, att in product(ARM_EFFECTS, ARM_ATTRITION):
        cells.append({"question": "B_arm_participant_randomised", "d": 0.30, "icc": 0.64, "attrition": att, "assignment": "participant", "d_arm": da})
    for da in ARM_EFFECTS:
        cells.append({"question": "C_arm_session_randomised", "d": 0.30, "icc": 0.64, "attrition": 0.30, "assignment": "session", "d_arm": da})
    for i, c in enumerate(cells):
        c["cell"] = i
    return cells


def run_cell(args: tuple[dict, int, int, int]) -> dict:
    cell, reps, n, verify = args
    p = SimParams(
        n_enrolled=n, d_change=cell["d"], icc=cell["icc"], attrition=cell["attrition"], d_arm=cell["d_arm"], arm_assignment=cell["assignment"]
    )
    primary = cell["question"].startswith("A")
    rej05 = rej025 = rej_fgls = disagree = boundary = 0
    gap_est = gap_se = 0.0
    est, completers, n_obs = [], [], []
    t0 = time.time()
    for r in range(reps):
        rng = np.random.default_rng([SEED, cell["cell"], r])
        o = simulate_outcomes(p, rng)
        panel = panel_from_outcomes(o, "phq2")
        moderator = None if primary else "proactive_share_c"
        fit = growth_model_fast(panel, moderator=moderator)
        if r < verify:  # cross-check the fast REML against the statsmodels estimator of record
            ref = growth_model(panel, moderator=moderator)
            gap_est = max(gap_est, abs(ref.estimate - fit.estimate) / ref.se)
            gap_se = max(gap_se, abs(ref.se - fit.se) / ref.se)
            disagree += (ref.p < 0.05) != (fit.p < 0.05)
        rej05 += fit.p < 0.05
        rej025 += fit.p < 0.025
        boundary += fit.var_slope < 1e-6
        est.append(fit.estimate)
        n_obs.append(fit.n_obs)
        completers.append(int((o.participants["dropout_week"] > 8).sum()))
        if primary:
            rej_fgls += fgls_cr2(panel).p < 0.05
    true = -(cell["d"] if primary else cell["d_arm"]) * p.total_sd / 8
    return {
        **{k: cell[k] for k in ["question", "d", "icc", "attrition", "assignment", "d_arm"]},
        "n_enrolled": n,
        "reps": reps,
        "power_alpha05": rej05 / reps,
        "power_alpha025": rej025 / reps,
        "power_fgls_cr2_alpha05": rej_fgls / reps if primary else np.nan,
        "mc_se": float(np.sqrt(max(rej05 / reps * (1 - rej05 / reps), 1e-9) / reps)),
        "true_effect_per_week": true,
        "mean_estimate": float(np.mean(est)),
        "zero_slope_variance_rate": boundary / reps,
        "verified_reps": min(verify, reps),
        "verify_max_gap_estimate_in_se": gap_est,
        "verify_max_gap_se_relative": gap_se,
        "verify_decision_disagreements": disagree,
        "mean_retained_wk8": float(np.mean(completers)),
        "mean_obs": float(np.mean(n_obs)),
        "secs": round(time.time() - t0, 1),
    }


def _figure(df: pd.DataFrame, path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    a = df[(df.question == "A_primary_slope") & (df.d > 0)]
    ink, muted, grid, surface = "#0b0b0b", "#898781", "#e1e0d9", "#fcfcfb"
    # Attrition is ordered, so one hue light -> dark, with marker shape as a second encoding.
    ramp = dict(zip(ATTRITION, ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"]))
    marks = dict(zip(ATTRITION, ["o", "s", "^", "D"]))
    fig, axes = plt.subplots(1, len(ICCS), figsize=(11, 4.2), sharey=True, facecolor=surface)
    for ax, icc in zip(axes, ICCS):
        ax.set_facecolor(surface)
        ax.axhline(0.8, color=muted, lw=1, ls=(0, (4, 3)))
        for att in ATTRITION:
            g = a[(a.icc == icc) & (a.attrition == att)].sort_values("d")
            ax.plot(g.d, g.power_alpha05, color=ramp[att], lw=2, marker=marks[att], ms=7, mec=surface, mew=1.5,
                    label=f"{att:.0%} attrition by week 8")
        ax.set_title(f"ICC = {icc:.2f}", color=ink, fontsize=11, loc="left")
        ax.set_xticks([e for e in EFFECTS if e > 0])
        ax.set_ylim(0, 1.03)
        ax.set_xlabel("Standardized 8-week change (d)", color=ink, fontsize=10)
        ax.grid(axis="y", color=grid, lw=0.8)
        ax.tick_params(colors=muted, labelsize=9)
        for side in ["top", "right", "left"]:
            ax.spines[side].set_visible(False)
        ax.spines["bottom"].set_color("#c3c2b7")
    axes[0].set_ylabel("Power (two-sided alpha = .05)", color=ink, fontsize=10)
    axes[0].text(0.2, 0.815, "0.80", color=muted, fontsize=8, va="bottom")
    axes[-1].legend(frameon=False, fontsize=9, loc="lower right", labelcolor=ink)
    reps = int(a.reps.iloc[0])
    fig.suptitle(
        f"Power for the mean PHQ-2 slope, N = {int(a.n_enrolled.iloc[0])} enrolled (SIMULATED; {reps} replicates per point)",
        color=ink, fontsize=12, x=0.01, ha="left",
    )
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    fig.savefig(path, dpi=150, facecolor=surface)
    plt.close(fig)


def _table(df: pd.DataFrame, index: str, columns: str, value: str = "power_alpha05") -> str:
    wide = df.pivot_table(index=index, columns=columns, values=value)
    head = f"| {index} \\ {columns} | " + " | ".join(f"{c:g}" for c in wide.columns) + " |"
    lines = [head, "|" + "---|" * (len(wide.columns) + 1)]
    for idx, row in wide.iterrows():
        lines.append(f"| {idx:g} | " + " | ".join(f"{v:.2f}" for v in row) + " |")
    return "\n".join(lines)


def _summary(df: pd.DataFrame, wall: float) -> str:
    a = df[df.question == "A_primary_slope"]
    null = a[a.d == 0]
    null_reps = int(null.reps.sum())
    size = float((null.power_alpha05 * null.reps).sum() / null_reps)
    size_fgls = float((null.power_fgls_cr2_alpha05 * null.reps).sum() / null_reps)
    b = df[df.question == "B_arm_participant_randomised"]
    c = df[df.question == "C_arm_session_randomised"]
    reps = int(a.reps.iloc[0])
    out = [
        "# Power simulation results (SIMULATED data, planning assumptions)",
        "",
        f"Generated by `python -m phase2.power` (analysis version {ANALYSIS_VERSION}, seed {SEED}, "
        f"{reps} replicates per cell, N = {int(a.n_enrolled.iloc[0])} enrolled).",
        f"Monte Carlo standard error of a power value is at most {0.5 / np.sqrt(reps):.3f}; do not read differences smaller than about twice that.",
        "Raw numbers: `power_grid.csv`. Figure: `power_primary.png`. Assumptions and their sources: `README.md` in this folder.",
        "",
        "## A. Primary test: mean PHQ-2 change over the access period (protocol design)",
        "",
        "Estimator: mixed model, random intercept and slope, REML, t reference on participants - 1, two-sided alpha = .05.",
        "d = standardized mean change by week 8 (points changed / baseline SD of 1.5).",
        "",
    ]
    for icc in ICCS:
        out += [f"ICC = {icc:.2f} (rows: d, columns: cumulative attrition by week 8)", "", _table(a[(a.icc == icc) & (a.d > 0)], "d", "attrition"), ""]
    ref = a[(a.icc == 0.64) & (a.attrition == 0.30)].set_index("d")
    out += [
        "At the planning cell of the September analysis (ICC 0.64, 30% attrition):",
        "",
        "| d | power, alpha .05 | power, alpha .025 (Bonferroni bound for the Holm pair) | September estimator (FGLS + CR2), alpha .05 | docs/phase2-power-analysis.md |",
        "|---|---|---|---|---|",
    ]
    for d, published in [(0.20, "0.73"), (0.30, "0.97"), (0.45, "1.00")]:
        r = ref.loc[d]
        out.append(f"| {d:g} | {r.power_alpha05:.2f} | {r.power_alpha025:.2f} | {r.power_fgls_cr2_alpha05:.2f} | {published} |")
    out += [
        "",
        f"Empirical type I error at d = 0, pooled over {null_reps} null replicates: mixed model {size:.3f}, FGLS + CR2 {size_fgls:.3f} (nominal 0.050).",
        f"The slope variance was estimated at zero in {a.zero_slope_variance_rate.mean():.1%} of primary fits.",
        "",
        "Cross-check of the fast REML used here against the statsmodels estimator of record "
        f"({int(df.verified_reps.sum())} replicates across all cells): largest gap in the estimate "
        f"{df.verify_max_gap_estimate_in_se.max():.3f} standard errors, largest relative gap in the standard error "
        f"{df.verify_max_gap_se_relative.max():.1%}, significance decisions that differed: {int(df.verify_decision_disagreements.sum())}.",
        "",
        "## B. Arm contrast IF participants were randomised 1:1 (protocol reserve Option B; not implemented)",
        "",
        "Test: time x arm interaction. d_arm = standardized difference in 8-week change between arms. ICC 0.64, d = 0.30 overall.",
        "",
        _table(b, "d_arm", "attrition"),
        "",
        "## C. Arm contrast under the app's current per-SESSION randomisation",
        "",
        "Test: time x (participant's share of proactive sessions) interaction, 30% attrition, ICC 0.64.",
        "d_arm = difference in 8-week change between a hypothetical all-proactive and all-reactive participant.",
        "",
        "| d_arm | power |",
        "|---|---|",
    ]
    out += [f"| {r.d_arm:g} | {r.power_alpha05:.2f} |" for r in c.itertuples()]
    out += ["", "The d_arm = 0 rows of B and C are type I error checks.", ""]
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reps", type=int, default=400)
    ap.add_argument("--verify", type=int, default=3, help="replicates per cell also fitted with statsmodels")
    ap.add_argument("--n", type=int, default=120, help="enrolled participants (protocol target 120)")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--out", default=str(RESULTS))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    cells = _cells()
    t0 = time.time()
    with Pool(args.workers) as pool:
        rows = []
        for i, row in enumerate(pool.imap_unordered(run_cell, [(c, args.reps, args.n, args.verify) for c in cells]), start=1):
            rows.append(row)
            print(f"[{i}/{len(cells)}] {row['question']} d={row['d']} icc={row['icc']} att={row['attrition']} "
                  f"d_arm={row['d_arm']} power={row['power_alpha05']:.3f}", flush=True)
    wall = time.time() - t0
    df = pd.DataFrame(rows).sort_values(["question", "icc", "attrition", "d", "d_arm"]).reset_index(drop=True)
    df.drop(columns=["secs"]).round(4).to_csv(out / "power_grid.csv", index=False)
    _figure(df, out / "power_primary.png")
    (out / "power_summary.md").write_text(_summary(df, wall))
    print(f"\nwrote {out}/power_grid.csv, power_primary.png, power_summary.md in {wall / 60:.1f} min")


if __name__ == "__main__":
    main()
