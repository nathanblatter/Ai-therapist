"""Tests for the Phase 2 analysis. Synthetic data only.

    make test          # from analysis/
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from phase2 import analyze, derive, models, qualitative, schema, sync_schema, synth

PARAMS = synth.SimParams(n_enrolled=60, d_change=0.45)


@pytest.fixture(scope="module")
def export_dir(tmp_path_factory) -> tuple[Path, synth.Outcomes]:
    out = tmp_path_factory.mktemp("export")
    return out, synth.generate(out, seed=7, params=PARAMS)


def _copy(src: Path, tmp_path: Path) -> Path:
    dst = tmp_path / "export"
    shutil.copytree(src, dst)
    return dst


# ---- export format ---------------------------------------------------------


def test_csv_writer_matches_the_typescript_serializer():
    # Same cases as the toCsv tests in datasetExport.service.test.ts.
    cols = [{"name": "a"}, {"name": "b"}, {"name": "c"}]
    assert synth.to_csv(cols[:2], [{"a": 'he said "hi"', "b": "x,y"}]) == 'a,b\n"he said ""hi""","x,y"\n'
    assert synth.to_csv(cols, [{"a": None, "c": True}]) == "a,b,c\n,,true\n"
    assert synth.to_csv([{"name": "item_scores"}], [{"item_scores": [1, 2, 3]}]) == 'item_scores\n"[1,2,3]"\n'


def test_expected_schema_is_in_sync_with_the_export_registry():
    assert sync_schema.extract() == json.loads(schema.SCHEMA_PATH.read_text())["files"]


def test_synthetic_export_loads_clean(export_dir):
    ex = schema.load_export(export_dir[0])
    assert ex.warnings == []
    assert set(ex.tables) == set(schema.expected_schema()["files"])
    assert ex.as_of and ex.export_git_sha == "synthetic-seed-7"
    assert len(ex["participants"]) == PARAMS.n_enrolled
    assert ex["sessions"]["participant_id"].isna().sum() == 5  # anonymous sessions survive loading


# ---- schema drift fails loudly ----------------------------------------------


def _rewrite(path: Path, fn) -> None:
    path.write_text(fn(path.read_text()))


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda d: (d / "moods.csv").unlink(), "missing file: moods.csv"),
        (lambda d: (d / "extra.csv").write_text("a\n"), "unexpected file: extra.csv"),
        (lambda d: _rewrite(d / "screeners.csv", lambda s: s.replace("occasion_index", "occasion", 1)), "header drift"),
        (lambda d: _rewrite(d / "surveys.csv", lambda s: s.replace("participant_id,survey_role", "survey_role,participant_id", 1)), "different order"),
        (lambda d: _rewrite(d / "surveys.csv", lambda s: s.replace('"weekly"', '"week_4"', 1)), "unexpected value"),
        (lambda d: _rewrite(d / "sessions.csv", lambda s: s.replace(',"true",', ',"yes",', 1)), "unexpected value"),
        (lambda d: _rewrite(d / "participants.csv", lambda s: s.replace('"P001"', '"P002"', 1)), "duplicate"),
        (lambda d: _rewrite(d / "surveys.csv", lambda s: s.replace("Z", "+00:00", 1)), "ISO-8601"),
        (lambda d: _rewrite(d / "feedback.csv", lambda s: s.replace(",false,", ",0,", 1)), "true/false"),
    ],
)
def test_drift_raises(export_dir, tmp_path, mutate, message):
    d = _copy(export_dir[0], tmp_path)
    mutate(d)
    with pytest.raises(schema.SchemaError, match=message):
        schema.load_export(d)


def test_out_of_range_score_raises(export_dir, tmp_path):
    d = _copy(export_dir[0], tmp_path)
    df = pd.read_csv(d / "surveys_scored.csv", dtype=str, keep_default_na=False)
    df.loc[df["phq2"] != "", "phq2"] = "9"
    df.to_csv(d / "surveys_scored.csv", index=False)
    with pytest.raises(schema.SchemaError, match=r"phq2: value\(s\) outside"):
        schema.load_export(d)


# ---- derivation --------------------------------------------------------------


def test_export_round_trip_recovers_the_simulated_panel(export_dir):
    path, outcomes = export_dir
    ex = schema.load_export(path)
    pop, excluded = derive.analysis_population(ex)
    assert len(pop) == PARAMS.n_enrolled and len(excluded) == 0
    for scale in ("phq2", "gad2"):
        panel, info = derive.outcome_panel(ex, pop, scale)
        assert info == {"duplicate_survey_rows_dropped": 0, "rows_before_baseline_dropped": 0, "rows_after_grace_window": 0}
        got = panel[panel["primary"]].sort_values(["participant_id", "t_weeks"]).reset_index(drop=True)
        want = synth.panel_from_outcomes(outcomes, scale).sort_values(["participant_id", "t_weeks"]).reset_index(drop=True)
        assert len(got) == len(want)
        assert (got["participant_id"] == want["participant_id"]).all()
        assert np.allclose(got["t_weeks"], want["t_weeks"], atol=1e-5)
        assert (got["score"] == want["score"]).all()


def test_participants_without_baseline_are_excluded_and_counted(export_dir, tmp_path):
    d = _copy(export_dir[0], tmp_path)
    for name in ("surveys.csv", "surveys_scored.csv"):
        df = pd.read_csv(d / name, dtype=str, keep_default_na=False)
        df = df[~((df["participant_id"] == "P001") & (df["survey_role"] == "baseline"))]
        (d / name).write_text(synth.to_csv([{"name": c} for c in df.columns], [
            {k: (v == "true" if v in ("true", "false") else (None if v == "" else v)) for k, v in row.items()} for row in df.to_dict("records")
        ]))
    ex = schema.load_export(d)
    pop, excluded = derive.analysis_population(ex)
    assert list(excluded["participant_id"]) == ["P001"]
    assert "P001" not in set(pop["participant_id"])


def test_weekly_panel_uses_the_app_study_calendar(export_dir):
    path, outcomes = export_dir
    ex = schema.load_export(path)
    pop, _ = derive.analysis_population(ex)
    weekly = derive.weekly_panel(ex, pop)
    assert len(weekly) == len(outcomes.weekly)
    assert weekly["study_week"].between(1, 8).all()
    assert not weekly.duplicated(["participant_id", "study_week"]).any()


# ---- estimators ---------------------------------------------------------------


def test_multiplicity_adjustments():
    assert models.holm([0.01, 0.04, 0.03]) == pytest.approx([0.03, 0.06, 0.06])
    assert models.benjamini_hochberg([0.01, 0.04, 0.03]) == pytest.approx([0.03, 0.04, 0.04])


@pytest.mark.parametrize("moderator", [None, "proactive_share_c"])
def test_fast_reml_agrees_with_statsmodels(moderator):
    rng = np.random.default_rng(11)
    for _ in range(3):
        o = synth.simulate_outcomes(synth.SimParams(n_enrolled=80, d_arm=0.5, arm_assignment="participant", slope_sd=0.08), rng)
        panel = synth.panel_from_outcomes(o)
        ref = models.growth_model(panel, moderator=moderator)
        fast = models.growth_model_fast(panel, moderator=moderator)
        assert ref.model == "random_slope"
        assert abs(ref.estimate - fast.estimate) < 0.05 * ref.se
        assert abs(ref.se - fast.se) < 0.03 * ref.se


def test_growth_model_recovers_a_known_slope():
    rng = np.random.default_rng(3)
    p = synth.SimParams(n_enrolled=400, d_change=0.45, attrition=0.17)
    fit = models.growth_model_fast(synth.panel_from_outcomes(synth.simulate_outcomes(p, rng)))
    truth = -0.45 * 1.5 / 8
    # Integer scoring on a bounded 0-6 scale attenuates the slope slightly, hence the tolerance.
    assert fit.ci_low - 0.01 < truth < fit.ci_high + 0.01
    assert fit.p < 0.001


def test_fgls_port_matches_the_september_script():
    # Load the original function from scripts/phase2-analysis-plan.py and compare on the same data.
    import importlib.util

    src = Path(__file__).resolve().parents[2] / "scripts" / "phase2-analysis-plan.py"
    spec = importlib.util.spec_from_file_location("september_plan", src)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    panel = synth.panel_from_outcomes(synth.simulate_outcomes(PARAMS, np.random.default_rng(5)))
    slope, se, df, *_ = mod.random_intercept_fgls(panel["participant_id"].to_numpy(), panel["t_weeks"].to_numpy(), panel["score"].to_numpy(dtype=float))
    port = models.fgls_cr2(panel)
    assert port.estimate == pytest.approx(slope, rel=1e-9)
    assert port.se == pytest.approx(se, rel=1e-9)
    assert port.df == df


# ---- end to end ----------------------------------------------------------------


def test_full_analysis_runs_end_to_end(export_dir, tmp_path):
    rep = analyze.run(export_dir[0], tmp_path / "out")
    text = (tmp_path / "out" / "report.md").read_text()
    assert "SYNTHETIC DATA" in text.splitlines()[0]
    for heading in ["CONFIRMATORY", "SENSITIVITY", "SECONDARY", "EXPLORATORY", "PLACEHOLDER"]:
        assert heading in text
    assert "not estimable" not in text
    est = pd.read_csv(tmp_path / "out" / "estimates.csv")
    confirmatory = est[est["family"] == "confirmatory"]
    assert list(confirmatory["id"]) == ["H_phq2", "H_gad2"]
    assert (confirmatory["p_adjusted"] >= confirmatory["p"]).all()
    assert (confirmatory["estimate"] < 0).all()  # d = 0.45 improvement was simulated
    assert {"sensitivity", "secondary", "exploratory"} <= set(est["family"])
    assert len(rep.rows) == len(est)


def test_qualitative_hook_is_a_placeholder():
    assert qualitative.KAPPA_THRESHOLD is None
    with pytest.raises(NotImplementedError):
        qualitative.second_coder_reliability()
