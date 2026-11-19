# Phase 2 analysis (ai-therapist-108)

Status: **DRAFT, not ratified by the PI.** Written before any Phase 2 outcome data exists.
Nothing in this folder has touched participant data; every number under `results/` comes
from synthetic data produced by `phase2/synth.py`.

This folder holds the analysis that will run on the study's de-identified dataset export
(`npm run export:dataset`, see `src/database/scripts/exportDataset.ts`), a synthetic-data
generator that writes files in that exact format, and a power simulation built on both.

Read `PREREGISTRATION.md` first if you are the PI. It separates what the protocol says
from what this draft proposes, and lists the export gaps, protocol inconsistencies and
open decisions that need a human answer.

## Relationship to the September 2026 scripts

`scripts/phase2-analysis-plan.py`, `scripts/phase2-power-sim.py` and
`docs/phase2-power-analysis.md` are the first pass at this item (pure numpy, written
2026-09-02). They are left in place because the power result they produced is quoted in
the IRB application. This folder is intended to supersede them once the PI ratifies it;
until then both exist. The differences that matter are listed in `PREREGISTRATION.md`
section 8 (the September script uses `occasion_index` as if it were the study week, and
its estimator differs from the "mixed-effects models" the application names).

## Layout

| Path | What it is |
|---|---|
| `PREREGISTRATION.md` | Draft pre-registration: hypotheses, variables, models, exclusions, unblinding rules, gaps, open decisions |
| `expected_schema.json` | Files, column order and column types the analysis accepts. Copied from the export registry |
| `phase2/schema.py` | Loads an export and validates it. Raises `SchemaError` on drift |
| `phase2/derive.py` | Analysis population, study-time alignment, long panels |
| `phase2/models.py` | Mixed-effects estimator, Holm and Benjamini-Hochberg, sensitivity estimators |
| `phase2/analyze.py` | The analysis, end to end. Writes `report.md` and `estimates.csv` |
| `phase2/synth.py` | Synthetic study generator, writes an export directory in the real format |
| `phase2/power.py` | Power simulation |
| `phase2/qualitative.py` | Placeholder hook for the AI second coder reliability analysis (ai-therapist-171). Not implemented |
| `phase2/sync_schema.py` | Regenerates `expected_schema.json` from the TypeScript registry |
| `tests/` | pytest suite, synthetic data only |
| `results/power/` | Committed power results: grid CSV, summary tables, figure, assumptions |
| `results/synthetic-run/` | Committed output of the full analysis on one synthetic export. Proof that it executes; not study results |

## Run it

Python 3.12, no network access needed after install, nothing in the cloud.

```
cd analysis
make setup        # creates .venv from the pinned requirements.txt
make test         # pytest, about 30 seconds
make synthetic    # writes a synthetic export to build/, runs the full analysis on it
make power        # re-runs the full power grid (about 30 CPU-minutes); make power-quick for a smoke run
```

On a real export, after unblinding rules in `PREREGISTRATION.md` section 9 are satisfied:

```
npm run export:dataset -- --out ~/docker-services/ai-therapist-exports/dataset-final --as-of <cutoff>
cd analysis
.venv/bin/python -m phase2.analyze --data ~/docker-services/ai-therapist-exports/dataset-final --out <output dir>
```

Point `--data` at the unzipped directory (the loose CSVs plus `codebook.md`). The report
records the export's `as_of` and `git_sha` from the codebook, the analysis version, and
the schema version, so a result can be traced to an exact export and an exact script.

Python is deliberately not part of the Node CI gates. The one link between the two is a
vitest case in `src/server/services/datasetExport.service.test.ts` that compares the
export registry to `expected_schema.json`: changing an export column fails `npm test`
until someone runs `python -m phase2.sync_schema` and looks at whether the analysis uses
that column. That is the point of the check.

## What "fail loudly" covers

`load_export()` stops with a `SchemaError` listing every problem when:

- a CSV is missing, or one the analysis does not know about is present;
- a header differs from `expected_schema.json` in names or order;
- a cell does not parse as its declared type (integer, number, `true`/`false`, UTC timestamp, JSON);
- a branching column holds a value outside its known set (`scale`, `survey_role`, `study_status`, `proactive_offering`, and others in `schema.ENUMS`);
- a score is outside its range, an id is duplicated, a row points at an unknown participant or session, or a screener's score is not the sum of its items.

It returns warnings, printed at the top of the report, for things a person should look at
but that do not make the data unusable: screeners less than 7 days apart, anonymous
screener rows, baseline or exit surveys with no PHQ-2 score, or weekly surveys with no
WAI-SR score at all (the server-side scorer returns empty when a Qualtrics question id is
stale, so an all-empty column is the symptom of a silent remap).

## Optimiser note (found while building this)

statsmodels' `MixedLM` with a single optimiser sometimes stops short of the REML optimum
on data shaped like this study's (small slope variance, 1 to 10 observations per person),
in some cases while reporting `converged=True`. In 24 synthetic datasets fitted with
L-BFGS alone, two stopped without converging (slope standard error up to 8% too small,
and 13% too small with a p-value moving from .061 to .034 if one then falls back to a
random-intercept model), and two reported convergence at a lower likelihood than BFGS or
Powell reached (standard error off by about 2%). The estimator in `models.growth_model` therefore fits with three optimisers (L-BFGS, BFGS,
Powell) and keeps the fit with the highest restricted log-likelihood. That rule is part
of the pre-specification. `models.growth_model_fast` is an independent implementation of
the same REML criterion from sufficient statistics; the analysis report prints it beside
each confirmatory estimate, and the power simulation uses it for speed and re-checks it
against statsmodels in every grid cell.

## Versioning

`phase2/__init__.py` holds `ANALYSIS_VERSION`. Bump it on any change to an estimand, a
model, an exclusion rule or a derived variable. The pre-registration, once frozen, cites
that string and a git tag (proposed name `prereg-phase2-v1.0`). Changes after the freeze
go in a dated "Deviations" section of `PREREGISTRATION.md`, never as silent edits.
