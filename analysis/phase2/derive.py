"""Derived analysis tables: population, study-time alignment, long panels.

Every rule in this file is an analysis decision. Each is listed, with its
source or its "proposal" status, in PREREGISTRATION.md sections 4 and 6.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .schema import Export

ACCESS_WEEKS = 8  # protocol: access period is 8 weeks
# Proposal (open decision D4): observations up to this many weeks after the
# access period still count as the end-of-access measurement. The exit survey
# only becomes due once 8 full weeks have elapsed (surveySchedule.service.ts),
# so it always lands after week 8.0.
GRACE_WEEKS = 2
# Proposal (D6): a participant is a completer if either co-primary outcome was
# observed at or after this study time.
COMPLETER_FROM_WEEK = 7.0
WEEK = pd.Timedelta(days=7)


def analysis_population(ex: Export) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return (population, exclusions).

    Population = pseudonymised participants with a finished Phase 2 baseline
    survey. The baseline survey is how a Phase 2 account is created
    (surveySchedule.service.ts: "account minted from the baseline survey"), so
    it is the only marker in the export that separates Phase 2 enrollees from
    Phase 1 or pilot accounts in the same database (gap G3).

    Study time zero ("anchor") = the baseline survey's recorded_at. The app's
    own study calendar is anchored on qualtrics_signups.registered_at, which
    is not exported (gap G1); the two should be minutes apart.
    """
    parts = ex["participants"]
    baseline = ex["surveys"][ex["surveys"]["survey_role"] == "baseline"]
    anchor = baseline.groupby("participant_id")["recorded_at"].min().rename("anchor")
    n_baselines = baseline.groupby("participant_id").size().rename("n_baseline_rows")
    pop = parts.merge(anchor, on="participant_id", how="left").merge(n_baselines, on="participant_id", how="left")
    excluded = pop[pop["anchor"].isna()][["participant_id"]].assign(reason="no_finished_baseline_survey")
    pop = pop[pop["anchor"].notna()].reset_index(drop=True)
    withdrawal = (
        ex["surveys"][ex["surveys"]["survey_role"] == "withdrawal"].groupby("participant_id")["recorded_at"].min().rename("withdrawal_at")
    )
    pop = pop.merge(withdrawal, on="participant_id", how="left")
    pop["withdrawal_week"] = (pop["withdrawal_at"] - pop["anchor"]) / WEEK
    return pop, excluded.reset_index(drop=True)


def _t_weeks(df: pd.DataFrame, ts_col: str, pop: pd.DataFrame) -> pd.DataFrame:
    out = df.merge(pop[["participant_id", "anchor"]], on="participant_id", how="inner")
    out["t_weeks"] = ((out[ts_col] - out["anchor"]) / WEEK).astype(float)
    return out


def outcome_panel(ex: Export, pop: pd.DataFrame, scale: str) -> tuple[pd.DataFrame, dict]:
    """All PHQ-2 or GAD-2 observations for the population, on study time.

    Two sources are pooled (open decision D2):
      in_app    screeners.csv, administered by the agent inside a session
      baseline / exit / week12   surveys_scored.csv, self-report in Qualtrics

    `primary` marks rows used by the confirmatory model: time 0 through the
    end of access plus the grace window. Week-12 follow-up rows are kept for
    the persistence analysis and are never in the primary window.
    """
    sc = ex["screeners"]
    sc = sc[(sc["scale"] == scale) & sc["participant_id"].notna()]
    a = _t_weeks(sc, "administered_at", pop)[["participant_id", "t_weeks", "score"]].assign(source="in_app", speeder=False)

    sv = ex["surveys_scored"]
    sv = sv[sv["survey_role"].isin(["baseline", "exit", "week12"]) & sv[scale].notna()]
    b = _t_weeks(sv, "recorded_at", pop).rename(columns={scale: "score", "survey_role": "source"})
    b = b.sort_values(["participant_id", "source", "t_weeks"])
    n_dupes = int(b.duplicated(["participant_id", "source"]).sum())
    b = b.drop_duplicates(["participant_id", "source"], keep="first")  # earliest response per role
    b = b[["participant_id", "t_weeks", "score", "source", "speeder"]]

    panel = pd.concat([a, b], ignore_index=True)
    panel["score"] = panel["score"].astype(float)
    panel["speeder"] = panel["speeder"].fillna(False).astype(bool)
    n_pre = int((panel["t_weeks"] < 0).sum())
    panel = panel[panel["t_weeks"] >= 0]
    panel["primary"] = (panel["source"] != "week12") & (panel["t_weeks"] <= ACCESS_WEEKS + GRACE_WEEKS)
    n_late = int(((panel["source"] != "week12") & ~panel["primary"]).sum())
    panel["qualtrics"] = (panel["source"] != "in_app").astype(int)
    panel = panel.sort_values(["participant_id", "t_weeks"]).reset_index(drop=True)
    info = {"duplicate_survey_rows_dropped": n_dupes, "rows_before_baseline_dropped": n_pre, "rows_after_grace_window": n_late}
    return panel, info


def completion(pop: pd.DataFrame, panels: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Per participant: completer flag and last primary-outcome observation time."""
    both = pd.concat([p[p["primary"]] for p in panels.values()], ignore_index=True)
    last = both.groupby("participant_id")["t_weeks"].max().rename("last_outcome_week")
    out = pop[["participant_id", "study_status", "withdrawal_week"]].merge(last, on="participant_id", how="left")
    out["completer"] = out["last_outcome_week"].fillna(-1) >= COMPLETER_FROM_WEEK
    out["dropout"] = (~out["completer"]).astype(int)
    return out


def weekly_panel(ex: Export, pop: pd.DataFrame) -> pd.DataFrame:
    """Weekly check-in surveys on the app's study calendar: study week k covers
    days [7(k-1), 7k) after the anchor (surveySchedule.service.ts). One row per
    participant-week; if a week has two responses the first is used."""
    sv = ex["surveys_scored"]
    w = _t_weeks(sv[sv["survey_role"] == "weekly"], "recorded_at", pop)
    w["study_week"] = np.floor(w["t_weeks"]).astype(int) + 1
    w = w[(w["study_week"] >= 1) & (w["study_week"] <= ACCESS_WEEKS)]
    w = w.sort_values(["participant_id", "t_weeks"]).drop_duplicates(["participant_id", "study_week"], keep="first")
    return w.reset_index(drop=True)


def session_panel(ex: Export, pop: pd.DataFrame) -> pd.DataFrame:
    """Sessions of population members during the access period. Anonymous
    sessions cannot be linked to anyone and are dropped."""
    s = ex["sessions"]
    s = _t_weeks(s[s["participant_id"].notna()], "started_at", pop)
    s = s[(s["t_weeks"] >= 0) & (s["t_weeks"] < ACCESS_WEEKS)].copy()
    s["study_week"] = np.floor(s["t_weeks"]).astype(int) + 1
    s["proactive"] = s["proactive_offering"].map({"true": 1.0, "false": 0.0})
    return s.reset_index(drop=True)


def proactive_exposure(sessions: pd.DataFrame) -> pd.DataFrame:
    """Share of each participant's access-period sessions that were randomised
    to the proactive condition, centred at the design value 0.5."""
    g = sessions.dropna(subset=["proactive"]).groupby("participant_id")["proactive"]
    out = pd.DataFrame({"n_sessions_assigned": g.size(), "proactive_share": g.mean()}).reset_index()
    out["proactive_share_c"] = out["proactive_share"] - 0.5
    return out


def weekly_session_counts(sessions: pd.DataFrame, pop: pd.DataFrame) -> pd.DataFrame:
    """Sessions per participant per study week, zero-filled for weeks 1-8."""
    grid = pd.MultiIndex.from_product([pop["participant_id"], range(1, ACCESS_WEEKS + 1)], names=["participant_id", "study_week"])
    counts = sessions.groupby(["participant_id", "study_week"]).size().reindex(grid, fill_value=0).rename("n_sessions")
    return counts.reset_index()
