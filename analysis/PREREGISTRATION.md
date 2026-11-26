# Pre-registration DRAFT: Human + AI Therapy, Phase 2 (Longitudinal Use)

**Status: DRAFT for PI review. Not ratified. Not registered anywhere.**
Analysis version `0.1.0-draft` (`analysis/phase2/__init__.py`). Drafted 2026-11-16 by an
AI coding agent from the repository's protocol documents and export code, before any
Phase 2 outcome data existed. No participant data, prod or stage, was read to write it.

How to read this document. Every statement is tagged:

- **[PROTOCOL]** the protocol documents say this; a file reference follows.
- **[PROPOSAL]** the protocol leaves it open and this draft picked a default. Each one is
  also listed in section 11 as an open decision. Nothing tagged PROPOSAL is decided.
- **[CODE]** a fact about how the app or the export behaves, read from source.

Sources, abbreviated below:

| Tag | File |
|---|---|
| APP | `docs/irb-phase2-longitudinal-application.md` (marked "WORKING DRAFT ... not reviewed by Nathan or Dr. Gaskin"; its Subject Enrollment and Risks text is stated to be superseded by the OneAegis form, which is not in the repo) |
| QN | `docs/irb-phase2-questions-for-nathan.md` (decision log) |
| PWR | `docs/phase2-power-analysis.md` (September 2026 power analysis) |
| SEP | `scripts/phase2-analysis-plan.py` (September 2026 analysis script) |
| LIT | `docs/irb-phase2-literature-review-2026-09.md` |
| INST | `docs/irb-phase2-instruments/` (Qualtrics survey sources `qualtrics_*.txt`) |
| EXPORT | `src/server/services/datasetExport.service.ts`, `src/server/db/datasetExport.queries.ts`, `src/server/db/qualtricsResponses.queries.ts` |

---

## 1. Design

- **[PROTOCOL]** Single-arm observational, within-subjects longitudinal cohort. QN,
  "Q13 design: single-arm observational. Proactive/reactive A/B stays as an exploratory
  under-the-hood condition. LOCKED." APP, Research Procedures, presents this as Option A
  and holds a two-arm randomised comparison (Option B) "in reserve".
- **[PROTOCOL]** 8 weeks of access to the AI support agent (APP Lay Summary, "8 weeks
  [DECIDED Q4]"; Research Procedures step 2, "Weeks 1-8").
- **[PROTOCOL]** Measurement schedule (APP Research Procedures; INST):
  - Week 0: baseline survey in Qualtrics, includes PHQ-2 and GAD-2 (`qualtrics_baseline.txt`).
  - Weeks 1-8: in-app PHQ-2 and GAD-2, "no more than once per week each", administered by
    the agent during a session; a weekly Qualtrics check-in with the 12-item WAI-SR, mood,
    stress, usage and helpfulness (`qualtrics_weekly.txt`). The weekly survey does not
    contain PHQ-2 or GAD-2.
  - Week 8: exit survey, includes PHQ-2 and GAD-2 (`qualtrics_exit.txt`); optional exit
    interview for a subsample of about 15-20 (QN Q7).
  - Week 12: one follow-up survey, includes PHQ-2 and GAD-2 (`qualtrics_week12.txt`; APP
    "DECIDED Q12").
- **[PROTOCOL]** Enrollment: up to 120 BYU students, expecting about 70-90 completers,
  anticipating 25-40% attrition (APP Subject Enrollment; QN Q15).
- **[CODE]** `proactive_offering` is not a participant-level arm. Each session draws its
  condition independently with probability one half (`resolveProactiveOffering()` in
  `src/server/utils/sessionHelpers.ts`: `Math.random() < 0.5`, mode `ab_test` by default),
  recorded per session in `session_configurations.proactive_offering`.

## 2. Hypotheses

Confirmatory (two, co-primary):

- **H1** Mean PHQ-2 score changes over the 8-week access period (fixed time slope differs from zero).
- **H2** Mean GAD-2 score changes over the 8-week access period (same test).

**[PROTOCOL]** PWR, header: "Primary confirmatory test: the within-person time slope of
PHQ-2 across the access period ... two-sided test against zero at alpha = .05. GAD-2 is
co-primary with Holm family-wise control." SEP docstring adds "improvement expected as a
negative slope" and "no interim looks". APP Analysis plan: "Mixed-effects models of
PHQ-2/GAD-2 trajectories over time."

**[PROPOSAL]** Interpretation rule. This is a single cohort with no comparison group. A
non-zero slope shows that scores changed while people had access; it cannot separate the
agent's effect from regression to the mean, natural course, repeated-testing effects or
the semester calendar. Reports will say "change over the access period", not "effect of"
or "efficacy". This matches APP Drug/Device: "we neither promise nor measure clinical
treatment efficacy as a primary endpoint" (see inconsistency I5).

No confirmatory hypothesis involves `proactive_offering`. **[PROTOCOL]** PWR: "the
proactive-vs-reactive exploratory contrast" is "not the basis for the sample-size target".

## 3. Outcomes and variables

| Role | Variable | Instrument and scoring | Where in the export |
|---|---|---|---|
| Co-primary | PHQ-2 total, 0-6 | **[PROTOCOL]** APP Instruments 1. Two items 0-3, summed | in-app: `screeners.csv` (`scale=phq2`, `score`); Qualtrics: `surveys_scored.csv` (`phq2`) for roles baseline, exit, week12 |
| Co-primary | GAD-2 total, 0-6 | **[PROTOCOL]** APP Instruments 2 | same, `gad2` |
| Secondary | WAI-SR total and Task, Bond, Goal subscales, 1-5 | **[PROTOCOL]** APP Instruments 3: 12 items, 4 per subscale, 5-point. **[CODE]** scored server-side as item means (`qualtricsScoring.service.ts`) | `surveys_scored.csv` (`weekly_alliance_*`), role weekly |
| Secondary | Engagement: sessions, timing | **[PROTOCOL]** APP Analysis plan, "engagement survival analysis (time-to-disengagement)" and "habit-formation analyses" | `sessions.csv` |
| Secondary | Safety-system performance | **[PROTOCOL]** APP Analysis plan, "flag rates, risk-score calibration against human review outcomes, time-to-researcher-acknowledgment, false-positive review outcomes" | `crisis_events.csv`, `crisis_adjudications.csv`, `sessions.csv` (acknowledgment time is not exported, gap G11) |
| Secondary | Weekly mood 1-6, stress 1-5 | **[CODE]** weekly survey single items | `surveys_scored.csv` |
| Exploratory | `proactive_offering` per session | **[PROTOCOL]** QN Q13, exploratory | `sessions.csv` |
| Exploratory | Post-session helpfulness 1-5 | **[CODE]** in-app session feedback | `feedback.csv` |
| Time | Study time in weeks since baseline | **[PROPOSAL]** see section 4 | derived |

## 4. Study time and wave alignment  **[PROPOSAL throughout]**

The export carries timestamps but no study week (gap G2), and not the enrollment
timestamp the app itself uses (gap G1). This draft derives time as follows
(`analysis/phase2/derive.py`):

1. **Time zero** for a participant is the `recorded_at` of their earliest finished
   baseline survey in `surveys.csv`. **[CODE]** The app's own study calendar is anchored
   on `qualtrics_signups.registered_at` (`getEnrollmentAnchor`), the moment the account is
   created from the baseline survey; the two should be minutes apart, but only the survey
   time is exported.
2. **Model time** is continuous: weeks since time zero, as a real number. Mixed models do
   not need observations on a common grid, and in-app screeners happen whenever the
   participant opens a session, not on a fixed day.
3. **Primary window**: observations from time 0 through week 10 (8 weeks of access plus a
   2-week grace window). **[CODE]** The exit survey only becomes due once 8 full weeks
   have elapsed (`surveySchedule.service.ts`, `EXIT_AFTER_WEEKS = 8`), so it always lands
   after week 8.0.
4. **Weekly surveys** use the app's calendar: study week k covers days 7(k-1) up to 7k
   after time zero (**[CODE]** `computeDueSurveys`), k = 1..8. A second weekly response in
   the same week is dropped (first kept).
5. **Sources pooled**: the baseline survey, in-app screeners and the exit survey all
   enter the primary model as PHQ-2 (or GAD-2) observations at their own times.
6. **Week-12 follow-up** is never in the primary window; it is used only in S4.
7. `occasion_index` in `screeners.csv` is not used. It counts administrations; it is not a week.
8. `phq2_first`, `phq2_last`, `phq2_delta` in `participants.csv` are not used (in-app only,
   no time window).

## 5. Models

### 5.1 Confirmatory model (H1, H2)

For participant i at observation j, with t = study time in weeks:

    score_ij = b0 + b1 * t_ij + u0_i + u1_i * t_ij + e_ij
    (u0_i, u1_i) ~ N(0, unstructured 2x2),  e_ij ~ N(0, s2)

- **[PROTOCOL]** "Mixed-effects models of PHQ-2/GAD-2 trajectories over time" (APP
  Analysis plan). Test of b1 against zero, two-sided, alpha = .05 (PWR).
- **[PROPOSAL]** Everything else: linear time; random intercept and random slope with
  unstructured covariance; REML; reference distribution t with (participants - 1) degrees
  of freedom; no covariates; fitted with statsmodels `MixedLM` using three optimisers and
  keeping the highest restricted log-likelihood (see `analysis/README.md`, Optimiser
  note); if no random-slope fit has finite standard errors, a random-intercept model is
  fitted and the report says so.
- **[PROTOCOL]** Reported effect size: standardized 8-week change d = b1 x 8 / SD of
  baseline scores (PWR, "Effect-size scale").
- Implemented in `models.growth_model`; called from `analyze.section_confirmatory`.

The September script used a different estimator for the same hypotheses: random-intercept
FGLS with cluster-robust (CR2) standard errors (SEP; PWR). The sample-size statement sent
to the IRB (LIT section 4: "120 enrolled, 97% power at d = 0.30") was computed with that
estimator. It is reproduced here as sensitivity analysis (a) and in the power simulation.
Which of the two is confirmatory is open decision D1.

### 5.2 Multiplicity

- **[PROTOCOL]** Holm adjustment across H1 and H2 (PWR; SEP).
- **[PROPOSAL]** Secondary analyses S2, S4, S5, S6: Benjamini-Hochberg q-values within the
  secondary family, reported beside unadjusted intervals. S1 and S3 are descriptive.
  Exploratory analyses: estimates and intervals only, no significance language.
- **[PROPOSAL]** Sensitivity analyses do not get their own alpha. They are read as
  "does the confirmatory estimate move", not as extra tests.

### 5.3 Missing data

- **[PROTOCOL]** "all available waves under MAR; no imputation for the confirmatory test;
  dropout is not filled" (SEP docstring).
- **[PROPOSAL]** The mixed model uses every observed score, including participants with
  only a baseline. Sensitivity: (e) completers only; (f) a pattern-mixture model that
  gives completers and dropouts separate slopes and reports the slope averaged over the
  observed dropout share (Hedeker and Gibbons 1997). A table of baseline PHQ-2 by
  completion status is always printed.
- Known limit, stated plainly: in-app screeners are only administered when a participant
  opens a session (**[CODE]**), so whether a weekly score exists depends on engagement.
  Missing-at-random is an assumption this design cannot verify. See inconsistency I6.

### 5.4 Sensitivity analyses for H1 and H2  **[PROPOSAL]**

(a) September estimator, FGLS + CR2. (b) In-app screeners only. (c) Adding a fixed effect
for mode (Qualtrics vs in-app). (d) Excluding survey responses flagged `speeder`.
(e) Completers only. (f) Pattern-mixture.

### 5.5 Secondary analyses (labelled SECONDARY in the report)

| ID | Analysis | Basis |
|---|---|---|
| S1 | Kaplan-Meier time to disengagement. Event: last session falls before the final access week; otherwise censored at week 8 | **[PROTOCOL]** APP "engagement survival analysis"; the event definition is **[PROPOSAL]**. The protocol's telemetry predictors are not exported (G11), so no predictor model is specified |
| S2 | WAI-SR total on study week, same mixed model; subscales descriptive | **[PROTOCOL]** APP "within-person alliance growth curves (WAI-SR)" |
| S3 | Counts and rates: flagged sessions, events by severity, human adjudication verdicts | **[PROTOCOL]** APP "safety-system performance metrics"; descriptive only |
| S4 | Week-12 minus exit PHQ-2 and GAD-2, paired, participants with both | **[PROTOCOL]** APP Instruments 8, "persistence of effects four weeks after access ends"; the test is **[PROPOSAL]** |
| S5 | In-app PHQ-2 on the same week's self-reported mood | **[PROTOCOL]** APP names convergent validity against the screeners for affect trajectories and acoustic features; neither is usable yet (G11), so weekly mood stands in. **[PROPOSAL]** |
| S6 | Sessions per participant-week on study week, Poisson GEE | **[PROTOCOL]** APP "habit-formation analyses ... (the novelty-decay question)"; model is **[PROPOSAL]** |

### 5.6 Exploratory analyses (labelled EXPLORATORY in the report)

| ID | Analysis | Note |
|---|---|---|
| E1a | Post-session helpfulness, proactive vs reactive session, random intercept per participant | The comparison per-session randomisation actually supports. Feedback is optional, so it is a selected subset of sessions |
| E1b | PHQ-2 and GAD-2: time by (participant's share of proactive sessions) | What the backlog item's "PHQ-2/GAD-2 deltas by proactive_offering arm" can mean under per-session assignment. Close to unpowered (section 7) |
| E2 | WAI-SR total on sessions in the same study week | **[PROTOCOL]** APP "behavioral engagement measures examined as correlates of self-reported alliance" |

### 5.7 Qualitative reliability placeholder

**[PROTOCOL]** APP Analysis plan: "qualitative thematic analysis of exit interviews and
de-identified transcripts." The planned "AI second coder" reliability check (Cohen's
kappa, item ai-therapist-171) has a hook at `analysis/phase2/qualitative.py` that raises
`NotImplementedError`. The kappa threshold is unset on purpose (D9). No coding data is in
the export (G10).

## 6. Analysis population and exclusions

- **[CODE]** The export already excludes demo and sandbox traffic and non-participant
  roles (EXPORT `ensurePseudonyms`).
- **[PROPOSAL]** Population: every row of `participants.csv` that has a finished baseline
  survey in `surveys.csv`. Participants without one are excluded and counted in the
  report. Reason: the baseline survey is the only Phase 2 marker in the export (G3) and
  the only source of time zero.
- **[PROPOSAL]** Anonymous sessions and screeners (empty `participant_id`) are excluded
  from every participant-level analysis.
- **[PROPOSAL]** Paused and withdrawn participants stay in, with the data they gave before
  stopping. **[PROTOCOL]** APP: "it collects nothing after withdrawal".
- **[PROPOSAL]** Observations before time zero are dropped and counted; observations
  after the grace window are excluded from the primary window and counted.
- **[PROPOSAL]** Speeder-flagged surveys are kept in the confirmatory analysis and removed
  in sensitivity (d). **[CODE]** the export says the flag is "never auto-excluded".
- **[PROPOSAL]** No outlier removal: scores are bounded 0-6.
- Not covered by this draft: a participant who asked for deletion on the withdrawal
  survey (INST `qualtrics_withdrawal.txt`). The analysis assumes deletions are applied
  before the export is cut; the export carries no flag to check that (G6).

## 7. Sample size and power

See `analysis/results/power/` for the full grid, the figure, and the source of every
assumption. All power numbers are simulated under planning assumptions.

- **[PROTOCOL]** Planned enrollment 120; planning attrition 30% within an anticipated
  25-40% (APP; PWR). No expected effect size is stated in the protocol; PWR reports power
  at d = 0.20, 0.30 and 0.45.
- **[PROPOSAL]** The grid adds ICC values below the 0.64 that PWR's assumptions imply, and
  the attrition extremes cited in LIT (17% and 52%).

Results at N = 120, 400 simulated studies per cell (Monte Carlo SE at most 0.025),
two-sided alpha = .05, for the confirmatory PHQ-2 slope:

| Scenario | d = 0.20 | d = 0.30 | d = 0.45 |
|---|---|---|---|
| Planning cell: ICC 0.64, 30% attrition | 0.77 | 0.98 | 1.00 |
| Same cell, alpha .025 (lower bound for the Holm pair) | 0.66 | 0.96 | 1.00 |
| Same cell, September estimator (FGLS + CR2) | 0.77 | 0.98 | 1.00 |
| Same cell as published in PWR | 0.73 | 0.97 | 1.00 |
| Least favourable cell: ICC 0.30, 52% attrition | 0.43 | 0.76 | 0.97 |
| Range across the whole grid | 0.43 to 0.79 | 0.76 to 0.99 | 0.97 to 1.00 |

- Type I error at d = 0, pooled over 4,800 null simulations: 0.041 for the mixed model,
  0.045 for FGLS + CR2, against a nominal 0.050.
- Reading: the study as designed is well powered for a standardized 8-week change of 0.30
  or more unless both the score's stability is low and attrition is at the 52% extreme. It
  is not reliably powered for d = 0.20 under any scenario examined. The September result
  (97% at d = 0.30) reproduces under this draft's estimator and data layout.
- The published N justification does not depend on the D1 choice: the two estimators give
  the same power to two decimals at the planning cell.

The arm contrast (exploratory; not a basis for the sample size):

| Assignment | d_arm = 0.30 | d_arm = 0.50 | d_arm = 0.80 |
|---|---|---|---|
| Per participant, 60 per arm, 30% attrition (reserve Option B; not what the app does) | 0.53 | 0.92 | 1.00 |
| Per session, as the app does today, 30% attrition | 0.08 | 0.12 | 0.29 |

- Reading: under the current per-session assignment, a PHQ-2 or GAD-2 contrast by
  `proactive_offering` cannot detect any plausible effect. If that contrast matters, the
  assignment has to become per-participant before launch (D11), and even then only a
  between-arm difference of about half a standard deviation is detectable at N = 120.

What the simulation does not cover: dropout that depends on the outcome, non-linear
trajectories, a mode difference between in-app and survey scores, and GAD-2 specifically.

## 8. Differences from the September 2026 script

| Topic | `scripts/phase2-analysis-plan.py` | This draft |
|---|---|---|
| Time variable | `occasion_index` (the n-th administration) used as "week" | weeks since the baseline survey, from timestamps |
| Baseline | first in-app screener | baseline survey PHQ-2/GAD-2 at time 0 |
| Data | `screeners.csv` only | baseline survey + in-app + exit survey |
| Estimator | random-intercept FGLS, CR2 standard errors | mixed model with random slope, REML; FGLS kept as sensitivity (a) |
| Schema | reads whatever columns exist, skips missing files | validates against `expected_schema.json`, stops on drift |
| WAI-SR | "analyzed from the Qualtrics answers at analysis time" | read from `surveys_scored.csv`, where the export now scores it |
| Engagement survival | every participant treated as an event at their last session | censored at week 8 when active in the final week |

## 9. Stopping and unblinding rules

- **[PROTOCOL]** "No interim looks" (SEP). "A pre-registered analysis script will be
  finalized before unblinding/analysis" (APP Analysis plan).
- **[PROTOCOL]** No efficacy or futility stopping rule exists. Safety is handled outside
  the analysis: crisis events are reviewed weekly and serious adverse events are reported
  to the IRB (APP Risks). Those reviews are operational and are not outcome analyses.
- **[PROPOSAL]** What "unblinding" means in a single-arm study: nobody on the team runs
  or views inferential summaries of PHQ-2, GAD-2 or WAI-SR, overall or by
  `proactive_offering`, until (1) this document is ratified by the PI, (2) the analysis
  is frozen at a git tag with `ANALYSIS_VERSION` 1.0.0, (3) the tag and this document are
  deposited in a public registry, and (4) the final export has been cut.
- **[PROPOSAL]** Data lock: one final export with `--as-of` set no earlier than the last
  enrolled participant's time zero plus 13 weeks (week-12 follow-up plus one week). The
  export is deterministic for a given `--as-of` (**[CODE]** EXPORT determinism contract),
  so the locked dataset can be regenerated and checked byte for byte.
- **[PROPOSAL]** The analysis may be run on synthetic data at any time, and on real
  exports before lock only through `schema.load_export` (structure checks, no outcome
  summaries), to catch drift early.
- **[PROPOSAL]** Deviations after the freeze are written into a dated "Deviations"
  section here with the reason, and reported in any paper.
- Caveat the PI should know about: operational surfaces already show outcome-adjacent
  summaries during the study, for example PHQ-2 first/last/delta in `participants.csv`
  and screener views in the admin insights routes
  (`src/server/routes/admin/insights.routes.ts`), and the study-ops dashboard tracks
  `proactive_offering` balance. Strict outcome blindness of the whole team is therefore
  not currently enforceable by the software; see D13.

## 10. Gaps and inconsistencies found

### 10.1 Export schema gaps

| ID | Gap | Why it matters | Cheapest fix |
|---|---|---|---|
| G1 | Enrollment timestamp not exported. `participants.csv` has `enrolled_month` only; the app's calendar anchor `qualtrics_signups.registered_at` is not in any file | Time zero has to be inferred from the baseline survey's `recorded_at` | Export days-since-enrollment on each dated row, or an `enrolled_at` column, if the re-identification review allows |
| G2 | No study week on any row. `occasion_index` is a running count per participant and scale, not a week | Wave alignment is re-derived outside the system that scheduled the waves; the September script treated the count as the week | Export `study_week` (and study day) computed with the same anchor the scheduler uses |
| G3 | No cohort or study-phase column | Phase 1, pilot or staff-created participant accounts in the same database cannot be told apart from Phase 2 enrollees except by having a baseline survey | Add a cohort column to `participants.csv` |
| G4 | A participant gets a pseudonym only after at least one session, and survey rows join on the pseudonym | Someone who consents and completes baseline but never opens a session is absent from every file, including their baseline scores. The true enrolled denominator and "never started" attrition are invisible | Assign pseudonyms to enrolled participants regardless of sessions |
| G5 | `proactive_offering` is per session; there is no participant-level arm, no record of the mode in force (`ab_test`, `always`, `never`), and the draw uses `Math.random()` with no allocation log | The arm contrast the backlog item describes cannot be formed; forced and randomised sessions are indistinguishable in the export; the allocation cannot be audited | Decide D11 first. If kept per-session, export the mode per session. If moved to per-participant, add a sticky arm column |
| G6 | `study_status` has no timestamp (the database has `study_status_changed_at`), access end is not exported, and there is no flag for a deletion request | Dropout timing is inferred from the last observation or the withdrawal survey; deletion compliance cannot be checked from the export | Export the status-change time as study day, and a deletion-request flag |
| G7 | `survey_role` is documented as baseline, weekly, exit, week12, but the export query has no role filter and migration 087 added `withdrawal` | Withdrawal rows will appear with an undocumented value. The loader accepts it and uses it for dropout timing | Add the value to the codebook; consider exporting the withdraw-vs-pause choice |
| G8 | Baseline survey content is not exported beyond PHQ-2 and GAD-2 | No demographics, therapy history or AI attitudes: no sample description table, no covariate adjustment, no moderator analysis | Export coarse, pre-reviewed categorical covariates |
| G9 | Weekly survey items beyond the scored ones are not exported: the adverse-experience item, the sought-human-support item, and the launch-gated dependence items | The protocol's dependency and adverse-experience monitoring cannot be analysed from the export | Export them as coded categories |
| G10 | No qualitative coding table; no flag for the exit-interview subsample | The AI second coder reliability analysis has no input | Define the table when D9 is decided |
| G11 | Telemetry named in the protocol's analysis plan is absent: per-turn response timing, interface-engagement events, per-turn affect trajectory, per-message risk-score history, time to researcher acknowledgment. `acoustic_features.csv` exists but is empty until its flag is on | The protocol's survival predictors, convergent-validity checks and safety-timing metrics cannot be run | Add per-session aggregates as these streams ship |
| G12 | Item-level WAI-SR responses and item-level survey PHQ-2/GAD-2 are not exported | No internal-consistency estimate for the adapted WAI-SR | Export item scores, as `screeners.csv` already does for in-app screeners |
| G13 | Only finished survey responses are exported, with no response sequence number | Partial responses are invisible and `finished` is constant; repeated submissions for one role can only be ordered by time | Export a per-participant, per-role sequence |
| G14 | All timestamps are UTC with no local offset | The protocol's time-of-day regularity analysis needs local time; assuming America/Denver is wrong for travelling participants | Export local hour-of-day bucket per session |
| G15 | `scripts/participant-sim/export-out/codebook.md` is a stale sample (6 investigator-written alliance items, 10 CSV files against the current 13) | Anyone using it as the schema reference is misled | Regenerate or delete the sample |

### 10.2 Protocol inconsistencies and ambiguities

| ID | Finding | Sources |
|---|---|---|
| I1 | Arms. The backlog item and APP's Option B text describe a two-arm randomised comparison by `proactive_offering`; the locked decision is single-arm; the app randomises per session. APP Subject Enrollment still carries Option B language ("120 enrolled is about 45/arm completing") | APP Research Procedures and Subject Enrollment; QN Q13; `sessionHelpers.ts` |
| I2 | Schedule length. The brief for this work says "8 weekly waves" and notes "12 weeks" appears in places. There is no conflict in the design: access is 8 weeks, the single follow-up is at week 12, and "12 weeks" is the total span (APP Time commitment). The screener asks about US presence for "the next 10 weeks" (QN notes this). What is not fixed anywhere is the number of PHQ-2/GAD-2 waves: PWR assumes nine weekly occasions (weeks 0-8); the instruments give a baseline survey, up to 8 in-app administrations and an exit survey, so up to 10 in the window, at irregular times | APP; PWR; INST; QN |
| I3 | Estimator. APP says mixed-effects models; PWR and SEP specify random-intercept FGLS with cluster-robust errors. SEP's docstring says CR0 while its code and PWR say CR2 | APP Analysis plan; PWR; SEP |
| I4 | Attrition. APP says 25-40% but "70-90 completers" of 120 is 25-42%. PWR plans on 30%. LIT replaces the cited benchmark with a pooled 17% and a 52% extreme. APP states its Subject Enrollment text is superseded by the OneAegis form, which is not in the repository, so the repository is not the source of truth for the enrollment justification | APP header and Subject Enrollment; PWR; LIT section 4 |
| I5 | Status of the outcome. APP says well-being indicators are "observational research measures" and that efficacy is not "a primary endpoint"; PWR calls the PHQ-2 slope the "primary confirmatory test" | APP Drug/Device; PWR |
| I6 | In-app screeners are opportunistic ("periodically", "no more than once per week"), and the weekly survey has no PHQ-2/GAD-2. There is no guaranteed weekly depression or anxiety measurement for someone who stops opening the app, so outcome missingness is tied to engagement by design | APP Research Procedures; INST `qualtrics_weekly.txt`; `src/server/utils/scales.ts` |
| I7 | Mode. PHQ-2/GAD-2 are collected two ways (agent-administered in a chat or voice session; self-report form) and no document says whether they are one series | APP; INST |
| I8 | Hypothesis direction. SEP expects improvement but tests two-sided; no document states a smallest effect of interest | SEP; PWR |
| I9 | The application is labelled a working draft not reviewed by the PI. Protocol citations here are to that draft | APP header |

## 11. Open decisions for the PI

Each has the default this draft implemented, so the script runs today. None is decided.

| ID | Decision | Default in this draft | Alternatives |
|---|---|---|---|
| D1 | Confirmatory estimator | Mixed model, random intercept and slope, REML, best of three optimisers | Keep the September FGLS + CR2 estimator that the IRB power statement was computed with. The two agree closely in simulation (section 7) |
| D2 | Which PHQ-2/GAD-2 observations enter the confirmatory model | Baseline survey + in-app + exit survey, pooled | In-app only; or surveys only (baseline to exit change); or pooled with a mode term |
| D3 | Time zero | Baseline survey `recorded_at` | Export and use the enrollment timestamp (G1) |
| D4 | Grace window after week 8 | 2 weeks | 1 week; none |
| D5 | Shape of time | Linear, continuous weeks | Integer waves; piecewise or quadratic |
| D6 | Completer and dropout definition | An outcome observation at week 7 or later | Exit survey completed; `study_status`; last session |
| D7 | Analysis population | Has a finished baseline survey | Add a cohort column (G3); decide what to do about enrolled-never-started (G4) |
| D8 | Speeder-flagged surveys | Kept; removed in sensitivity | Excluded from the confirmatory model |
| D9 | AI second coder: kappa threshold, coding unit, action below threshold, pinned coder model | Not set, not implemented | PI to specify (ai-therapist-171) |
| D10 | Multiplicity | Holm over H1, H2 (protocol); Benjamini-Hochberg within secondary (proposal) | Hierarchical testing (PHQ-2 first); no adjustment for secondary |
| D11 | The arm variable | Left as is: per-session, exploratory only | Make assignment sticky per participant before launch, which gives the contrast real power (section 7) but is a design change to raise with the IRB given Q13 |
| D12 | Direction and smallest effect of interest | Two-sided, none stated | One-sided; state a minimal important change |
| D13 | Who is blind to what, and from when | Section 9 proposal | Restrict outcome views in admin tools until lock; or accept and disclose |
| D14 | Missing-data sensitivity depth | Completers only + pattern-mixture | Add delta-adjusted multiple imputation with a tipping-point table |
| D15 | Where and when to register | Not chosen | OSF or AsPredicted, before the first participant's week 1 |
| D16 | Whether WAI-SR growth should be confirmatory | Secondary | Promote to a third confirmatory test (changes the Holm family) |

## 12. Deviations

None. Nothing has been frozen.
