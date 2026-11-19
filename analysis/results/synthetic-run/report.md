# Phase 2 analysis report (SYNTHETIC DATA: not study results)

- analysis version: 0.1.0-draft (DRAFT, not ratified by the PI)
- export as_of: 2027-05-17T15:00:00Z; export git_sha: synthetic-seed-20261116; expected schema version: 1
- schema validation: passed, 0 warning(s)

## 1. Analysis population and participant flow

- Rows in participants.csv: 120
- Excluded, no finished baseline survey (cannot be placed on study time): 0
- Analysis population: 120
- study_status: {'active': 109, 'withdrawn': 11}
- Completers (a PHQ-2 or GAD-2 observation at study week 7 or later): 83 (69.2%); attrition 30.8%
- Anonymous sessions ignored: 5

Primary-window observations by source:

| outcome | source | observations | participants | mean | sd |
|---|---|---|---|---|---|
| phq2 | baseline | 120 | 120 | 2.47 | 1.50 |
| phq2 | exit | 79 | 79 | 2.00 | 1.59 |
| phq2 | in_app | 636 | 115 | 2.23 | 1.54 |
| gad2 | baseline | 120 | 120 | 2.71 | 1.51 |
| gad2 | exit | 79 | 79 | 2.20 | 1.54 |
| gad2 | in_app | 636 | 115 | 2.41 | 1.48 |

PHQ-2 by study week (week 0 = baseline survey; week k = (k-1, k] weeks after it; week 8 includes the grace window):

| week | participants | mean | sd |
|---|---|---|---|
| 0 | 120 | 2.47 | 1.50 |
| 1 | 90 | 2.58 | 1.59 |
| 2 | 89 | 2.46 | 1.45 |
| 3 | 88 | 2.17 | 1.48 |
| 4 | 84 | 2.26 | 1.61 |
| 5 | 77 | 2.25 | 1.58 |
| 6 | 72 | 1.94 | 1.56 |
| 7 | 73 | 2.00 | 1.46 |
| 8 | 142 | 2.01 | 1.56 |


## 2. CONFIRMATORY: PHQ-2 and GAD-2 change over the access period (H1, H2)

Model: score ~ time (weeks since baseline), random intercept and random time slope per participant, REML;
two-sided alpha = 0.05, t reference on participants - 1; Holm adjustment across the two co-primary outcomes.

- **H1 PHQ-2** slope per week: -0.0644 (95% CI -0.0883 to -0.0406), p < 0.0001; 120 participants, 835 observations
  - Holm-adjusted p < 0.0001: **REJECT H0**
  - Standardized 8-week change d = slope x 8 / baseline SD (1.50) = -0.344
  - Variance components: intercept 1.489, slope 0.00198, residual 0.733; model: random_slope
  - Independent REML implementation (cross-check, not a second test): -0.0644, SE 0.0120 vs 0.0121
- **H2 GAD-2** slope per week: -0.0603 (95% CI -0.0850 to -0.0357), p < 0.0001; 120 participants, 835 observations
  - Holm-adjusted p < 0.0001: **REJECT H0**
  - Standardized 8-week change d = slope x 8 / baseline SD (1.51) = -0.320
  - Variance components: intercept 1.311, slope 0.00162, residual 0.812; model: random_slope
  - Independent REML implementation (cross-check, not a second test): -0.0603, SE 0.0124 vs 0.0125

## 3. SENSITIVITY analyses for H1 and H2 (pre-specified; not additional tests)

These show whether the confirmatory estimate depends on an analysis choice. They do not change the verdict above.

**PHQ2** slope per week:
- a. September estimator (random-intercept FGLS, CR2 SEs): -0.0641 (95% CI -0.0879 to -0.0402), p < 0.0001; 120 participants, 835 observations
- b. in-app screeners only: -0.0730 (95% CI -0.1070 to -0.0390), p < 0.0001; 115 participants, 636 observations
- c. adjusting for mode (Qualtrics vs in-app): -0.0643 (95% CI -0.0881 to -0.0404), p < 0.0001; 120 participants, 835 observations
- d. excluding survey responses flagged as speeders: -0.0644 (95% CI -0.0883 to -0.0406), p < 0.0001; 120 participants, 835 observations
- e. completers only: -0.0632 (95% CI -0.0881 to -0.0383), p < 0.0001; 83 participants, 693 observations
- f. pattern-mixture (completers and dropouts may differ; averaged over 30.8% dropouts): -0.0696 (95% CI -0.1021 to -0.0372); completers -0.0632, dropouts differ by -0.0209

**GAD2** slope per week:
- a. September estimator (random-intercept FGLS, CR2 SEs): -0.0602 (95% CI -0.0849 to -0.0355), p < 0.0001; 120 participants, 835 observations
- b. in-app screeners only: -0.0512 (95% CI -0.0873 to -0.0150), p = 0.0059; 115 participants, 636 observations
- c. adjusting for mode (Qualtrics vs in-app): -0.0601 (95% CI -0.0848 to -0.0354), p < 0.0001; 120 participants, 835 observations
- d. excluding survey responses flagged as speeders: -0.0603 (95% CI -0.0850 to -0.0357), p < 0.0001; 120 participants, 835 observations
- e. completers only: -0.0685 (95% CI -0.0936 to -0.0435), p < 0.0001; 83 participants, 693 observations
- f. pattern-mixture (completers and dropouts may differ; averaged over 30.8% dropouts): -0.0342 (95% CI -0.0676 to -0.0008); completers -0.0685, dropouts differ by +0.1113

Missing-data diagnostic: baseline PHQ-2 by completion status (a large gap argues against missing-completely-at-random):

| completer | count | mean | std |
|---|---|---|---|
| False | 37 | 2.38 | 1.48 |
| True | 83 | 2.51 | 1.52 |


## 4. SECONDARY analyses (pre-specified; estimates and intervals; Benjamini-Hochberg q-values within this family)

**S1 Engagement survival** (time to disengagement = last session, when no session falls in the final access week):
- 50 of 120 disengaged before the final week; Kaplan-Meier median not reached (more than half stayed engaged); still engaged at week 2: 86.7%, still engaged at week 4: 79.2%, still engaged at week 6: 74.2%

**S2 Working alliance growth** (WAI-SR total, weekly surveys, weeks 1-8; slope per week):
- total: +0.0435 (95% CI +0.0364 to +0.0506), p < 0.0001; 114 participants, 622 observations
- task subscale (descriptive, not in the q-value family): +0.0374 (95% CI +0.0259 to +0.0490), p < 0.0001; 114 participants, 622 observations
- bond subscale (descriptive, not in the q-value family): +0.0447 (95% CI +0.0312 to +0.0583), p < 0.0001; 114 participants, 622 observations
- goal subscale (descriptive, not in the q-value family): +0.0477 (95% CI +0.0350 to +0.0604), p < 0.0001; 114 participants, 622 observations

**S3 Safety-system descriptives** (no inference):
- sessions: 1707; crisis-flagged: 49 (2.87%); participants ever flagged: 36
- crisis events by severity: {'low': 38, 'medium': 10, 'high': 1}
- human adjudication verdicts: {'false_positive': 20, 'confirmed': 11, 'unclear': 8} (39 verdicts on 49 events)

**S4 Persistence after access ends** (week-12 follow-up minus exit survey, same participants):
- PHQ2: +0.1176 (95% CI -0.1886 to +0.4239), p = 0.4440; 51 participants, 102 observations
- GAD2: +0.2745 (95% CI -0.0539 to +0.6029), p = 0.0994; 51 participants, 102 observations

**S5 Convergent validity** (in-app PHQ-2 on the same study week's self-reported mood, 1-6, higher = better):
- PHQ-2 points per mood point: -0.2533 (95% CI -0.3585 to -0.1481), p < 0.0001; 112 participants, 495 observations

**S6 Novelty decay** (sessions per participant-week on study week; log rate ratio per week):
- -0.0798 (95% CI -0.1054 to -0.0543), p < 0.0001; 120 participants, 960 observations
  - rate ratio per week 0.923; note zero weeks after dropout are counted as zero sessions

| study_week | mean_sessions | share_with_any |
|---|---|---|
| 1 | 2.84 | 1.00 |
| 2 | 1.77 | 0.81 |
| 3 | 1.72 | 0.78 |
| 4 | 1.73 | 0.74 |
| 5 | 1.65 | 0.68 |
| 6 | 1.53 | 0.67 |
| 7 | 1.67 | 0.68 |
| 8 | 1.32 | 0.58 |

Benjamini-Hochberg q-values for the secondary family:

| id | analysis | q |
|---|---|---|
| S2 | WAI-SR total slope per week | 0.0000 |
| S4_phq2 | phq2 week-12 minus exit | 0.4440 |
| S4_gad2 | gad2 week-12 minus exit | 0.1242 |
| S5 | PHQ-2 per weekly mood point | 0.0000 |
| S6 | log rate ratio of weekly sessions per study week | 0.0000 |


## 5. EXPLORATORY analyses (hypothesis-generating; no significance claims, no adjustment)

proactive_offering is assigned per SESSION, not per participant. Sessions by condition: {'false': 864, 'true': 843}.
Participant share of proactive sessions: mean 0.50, SD 0.18 (a small SD means the participant-level contrast below has little leverage).

**E1a Session-level proactive effect on post-session helpfulness rating (1-5)** (the comparison the per-session randomisation supports):
- proactive minus reactive: +0.0157 (95% CI -0.1502 to +0.1817), p = 0.8525; 117 participants, 688 observations

**E1b PHQ-2 and GAD-2 slope by share of proactive sessions** (time x exposure; exposure is post-baseline and only random given the number of sessions):
- PHQ2, slope difference all-proactive vs all-reactive: -0.0975 (95% CI -0.2804 to +0.0855), p = 0.2937; 120 participants, 835 observations
- GAD2, slope difference all-proactive vs all-reactive: +0.0348 (95% CI -0.1567 to +0.2264), p = 0.7193; 120 participants, 835 observations

**E2 Alliance and engagement** (WAI-SR total on sessions that study week, within the mixed model):
- alliance points per additional session: -0.0172 (95% CI -0.0300 to -0.0044), p = 0.0090; 114 participants, 622 observations

## 6. PLACEHOLDER: AI second coder qualitative reliability (ai-therapist-171)

NOT IMPLEMENTED: AI second coder reliability analysis is a placeholder (ai-therapist-171): the kappa threshold, coding unit and input table are not yet defined.
Kappa threshold: None (to be set by the PI).
