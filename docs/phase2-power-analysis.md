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
Raw results: `docs/phase2-power-sim-results.csv`.

---

## Result

Power to detect a nonzero mean PHQ-2 trajectory over 8 weeks, by enrollment N
and standardized total change (d = change by Week 8 relative to the baseline
between-person SD):

| Enrolled | d = 0.20 (small) | d = 0.30 (medium) | d = 0.45 (medium-large) |
| --- | --- | --- | --- |
| 80  | 0.41 | 0.74 | 0.97 |
| 100 | 0.46 | 0.80 | 0.99 |
| **120** | **0.53** | **0.85** | **1.00** |

## Interpretation

Enrolling **120 BYU students** gives **85% power to detect a medium
within-person change (d = 0.30)** in depressive symptoms across the access
period, and essentially full power for larger effects, under conservative
attrition assumptions. This is the basis for the N = 120 target in the
application's Subject Enrollment section.

The design is **appropriately powered for medium effects and honest about small
ones**: a genuinely small effect (d = 0.20) would be detected only ~53% of the
time even at N = 120. We do not claim to reliably detect small effects; the
study is exploratory for effect sizes below d ≈ 0.30, and the analysis plan
reports effect-size estimates with confidence intervals rather than resting on
significance alone.

## Assumptions (and why they are conservative)

- **Attrition:** ~30% cumulative dropout by Week 8, applied as a constant
  weekly hazard with participants missing-at-random after dropout. Multi-week
  digital mental-health studies routinely lose 25–40% (Torous et al., 2020);
  30% is a mid-range, defensible planning value.
- **Occasion-level missingness:** an additional 20% of remaining in-app
  screener waves skipped at random (the agent administers PHQ-2/GAD-2 only when
  a participant shows up). This is on top of dropout, so effective data loss is
  substantial and the power estimates are conservative.
- **Measurement model:** PHQ-2 treated as approximately continuous (0–6),
  baseline mean 2.2, between-person intercept SD 1.2, between-person slope SD
  0.04/week, residual SD 0.9, scores truncated to range. Nine occasions
  (Weeks 0–8).
- **Estimator realism:** the simulation runs the exact confirmatory estimator,
  including its variance-component estimation and cluster-robust inference —
  not an idealized closed-form power formula.

**Estimator selection (documented for transparency):** three pure-Python
estimators were compared at N = 120, d = 0.30 — naive two-stage per-person
slopes + t-test (power 0.32; early dropouts contribute extremely noisy
slopes), pooled OLS with cluster-robust SEs (0.68), and random-intercept FGLS
with cluster-robust SEs (0.85, within a few points of a full likelihood mixed
model). The FGLS estimator was selected and fixed in the pre-registered
analysis script before data collection.

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
