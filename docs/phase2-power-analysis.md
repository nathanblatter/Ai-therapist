# Phase 2 Power Analysis

**Study:** Human + AI Therapy: Better For Everyone (Phase 2, Longitudinal Use)
**Design:** single-arm observational within-subjects cohort, 8-week access period
**Primary confirmatory test:** the within-person time slope of PHQ-2 across the
access period, estimated by random-intercept FGLS (method-of-moments variance
components + GLS partial demeaning) with cluster-robust standard errors by
participant; two-sided test against zero at α = .05. GAD-2 is co-primary with
Holm family-wise control. The analysis stack is pure Python (numpy; no R).
**Simulation:** `scripts/phase2-power-sim.py` (seed 20260902, 2,000 replicates
per cell) simulates the SAME estimator the pre-registered analysis script uses
(`scripts/phase2-analysis-plan.py`), so power reflects the actual planned test.
Raw results: `docs/phase2-power-sim-results.csv` (comparison estimators:
`-pooled.csv`, `-twostage.csv`).

**Effect-size scale:** d = (mean change in points by Week 8) / total baseline
SD of the score (≈1.5 points under the simulation's variance assumptions).
This is the same scale the analysis script reports (it standardizes by the
empirical SD of Week-0 scores), so the power table below and the analysis
output are directly comparable.

---

## Result

Power to detect a nonzero mean PHQ-2 trajectory over 8 weeks, by enrollment N
and standardized total change d:

| Enrolled | d = 0.20 (small) | d = 0.30 (medium) | d = 0.45 (medium-large) |
| --- | --- | --- | --- |
| 80  | 0.57 | 0.88 | 1.00 |
| 100 | 0.65 | 0.94 | 1.00 |
| **120** | **0.73** | **0.97** | **1.00** |

## Interpretation

Enrolling **120 BYU students** gives **97% power to detect a medium
within-person change (d = 0.30)** in depressive symptoms across the access
period, and ~73% power even for a small effect (d = 0.20), under conservative
attrition assumptions. This is the basis for the N = 120 target in the
application's Subject Enrollment section: the design retains strong power for
medium effects even if attrition or variance assumptions prove optimistic, and
meaningful (if not definitive) power for small effects.

## Assumptions (and why they are conservative)

- **Attrition:** ~30% cumulative dropout by Week 8, applied as a constant
  weekly hazard with participants missing-at-random after dropout. Multi-week
  digital mental-health studies routinely lose 25–40% (Torous et al., 2020);
  30% is a mid-range, defensible planning value.
- **Occasion-level missingness:** an additional 20% of remaining in-app
  screener waves skipped at random (the agent administers PHQ-2/GAD-2 only when
  a participant shows up). This is on top of dropout, so effective data loss is
  substantial.
- **Measurement model:** PHQ-2 treated as approximately continuous (0–6),
  baseline mean 2.2, between-person intercept SD 1.2, between-person slope SD
  0.04/week, residual SD 0.9, scores truncated to the 0–6 range. Nine occasions
  (Weeks 0–8). Truncation attenuates estimated slopes by roughly 9% toward
  zero; because the simulation runs the same truncated data through the same
  estimator, the power table already absorbs this (and real effect-size
  estimates should be read as mildly conservative).
- **Estimator realism:** the simulation runs the exact confirmatory estimator,
  including its variance-component estimation and CR2 cluster-robust inference —
  not an idealized closed-form power formula.
- **Empirical size (disclosed):** at d = 0, the test's rejection rate across
  12,000 null replicates (multiple seeds, independent reruns) is ≈ 0.054
  (seed range 0.048–0.063) against the nominal 0.05 — a small liberality
  attributable to estimating the FGLS variance components from the same data.
  Practical reading: borderline results (p between about .04 and .06) should
  be interpreted cautiously; clearly significant results are unaffected.

**Estimator selection (reproducible):** three pure-Python estimators were
compared at N = 120, d = 0.30 with the same seed — naive two-stage per-person
slopes + t-test (power 0.45; early dropouts contribute extremely noisy
slopes), pooled OLS with cluster-robust SEs (0.85), and random-intercept FGLS
with CR2 cluster-robust SEs (0.97). Reproduce with
`python3 scripts/phase2-power-sim.py --estimator twostage|pooled|fgls`. The
FGLS estimator was selected and fixed in the pre-registered analysis script
before data collection.

GAD-2 is analyzed identically as a co-primary; its power is comparable under
the same assumptions. Secondary and exploratory analyses (engagement survival,
working-alliance growth, safety-system descriptives, the proactive-vs-reactive
exploratory contrast) are not the basis for the sample-size target.

## Reproduce

```
python3 scripts/phase2-power-sim.py     # ~1 minute, pure numpy, writes the CSV
```

Sensitivity: edit the constants at the top of the script (`WEEKLY_DROPOUT`,
`OCCASION_MISS`, `EFFECTS_D`, `ENROLLMENTS`) and re-run; the fixed seed keeps
results reproducible.

*Reference:* Torous J, et al. (2020). Dropout rates in clinical trials of
smartphone apps for depressive symptoms. *J Affect Disord.*
