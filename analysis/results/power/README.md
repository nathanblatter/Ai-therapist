# Power simulation: assumptions and how to read the results

Everything in this folder is SIMULATED. Results: `power_summary.md` (tables),
`power_grid.csv` (every cell), `power_primary.png` (figure). Reproduce with `make power`
from `analysis/` (fixed seed; the numbers are deterministic for a given
`requirements.txt`).

## What is simulated

One replicate is one whole study from `phase2/synth.py::simulate_outcomes`: 120 people
enrol, each gets a baseline survey PHQ-2 at time 0, in-app PHQ-2 screeners in the weeks
they are still active and show up, and an exit-survey PHQ-2 after week 8 if they were
retained. The planned mixed model is fitted to those observations and the replicate
counts as a detection when the two-sided p-value for the tested term is below .05.

Scores are generated as a person-specific line plus noise, then rounded to whole numbers
and clipped to 0-6, because the real instrument only produces integers 0-6. That
attenuates slopes slightly; the simulation and the analysis share the attenuation.

## Assumptions and where each comes from

| Quantity | Value(s) | Source |
|---|---|---|
| Enrollment | 120 | Protocol. `docs/irb-phase2-longitudinal-application.md`, Subject Enrollment: "Enroll up to 120 BYU students" |
| Access period | 8 weeks | Protocol, Lay Summary and Research Procedures ("Weeks 1-8") |
| Attrition by week 8 | 17%, 30%, 40%, 52% | 30% is the planning value in `docs/phase2-power-analysis.md`; the protocol anticipates 25-40%; 17% is the pooled rate in Yang 2026 and 52% the rate in Kuta 2026, both cited in `docs/irb-phase2-literature-review-2026-09.md` |
| Shape of attrition | constant weekly hazard | ASSUMPTION, carried over from `docs/phase2-power-analysis.md` |
| Dropout mechanism | unrelated to the outcome | ASSUMPTION. If people who are getting worse leave, real power and real bias both differ. The analysis has a pattern-mixture sensitivity check; the simulation does not model informative dropout |
| In-app screener weeks missed while active | 20% | ASSUMPTION, carried over from `docs/phase2-power-analysis.md` |
| Exit survey response among retained | 90% | ASSUMPTION (new in this draft) |
| Effect size d | 0, 0.20, 0.30, 0.45 | d = mean change by week 8 / baseline SD. Same grid as `docs/phase2-power-analysis.md`, plus 0 to measure type I error. The protocol does not state an expected effect |
| Baseline PHQ-2 mean, SD | 2.2, 1.5 | ASSUMPTION, carried over from `docs/phase2-power-analysis.md`. No Phase 1 estimate is cited in the protocol |
| ICC (between-person share of variance) | 0.30, 0.50, 0.64 | 0.64 is what the September assumptions imply (1.2^2 / (1.2^2 + 0.9^2)). 0.30 and 0.50 are ASSUMPTIONS added to show sensitivity; a two-item screener may well be less stable than 0.64 |
| Between-person SD of weekly slope | 0.04 points | ASSUMPTION, carried over from `docs/phase2-power-analysis.md` |
| Sessions per active week | Poisson, mean 2 | Protocol suggests "at least two brief interactions per week"; the distribution is an ASSUMPTION |
| Arm effect d_arm (parts B and C) | 0, 0.30, 0.50, 0.80 | ASSUMPTION. The protocol states no expected arm effect |

## Three questions, three sections

- **A** is the protocol's design: one cohort, test whether the mean PHQ-2 slope differs from zero.
- **B** answers "what if the study were the two-arm randomised comparison the backlog item
  and the protocol's reserve Option B describe". Participants are split 1:1; the test is
  the time by arm interaction. The app does not assign arms this way today.
- **C** is the arm contrast under what the app actually does: every session is assigned
  proactive or reactive by an independent coin flip (`resolveProactiveOffering()` in
  `src/server/utils/sessionHelpers.ts`). A participant's exposure is then the share of
  their sessions that were proactive, which clusters near one half for everyone, so the
  participant-level contrast has very little to work with. C also assumes the effect of
  exposure on the slope is linear in that share, which is an ASSUMPTION.

## Reading the numbers

- Each power value carries Monte Carlo error; `power_grid.csv` has the standard error per
  cell (`mc_se`). Differences of two or three points between neighbouring cells are noise.
- "alpha .025" in the summary is the Bonferroni bound for the co-primary pair. The Holm
  procedure the analysis uses rejects at least as often as that and at most as often as
  the alpha .05 column.
- GAD-2 is not simulated separately for power. It is analysed with the same model and, if
  its variance structure resembles PHQ-2's, has similar power. That similarity is an
  ASSUMPTION.
- The simulation fits `models.growth_model_fast`, which is the same model and criterion as
  the statsmodels estimator the real analysis uses. Every cell refits a few replicates
  with statsmodels; the summary reports the largest gap found.
