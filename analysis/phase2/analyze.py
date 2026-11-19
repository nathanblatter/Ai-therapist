"""Phase 2 analysis, end to end, from one unzipped dataset export.

    python -m phase2.analyze --data path/to/export_dir --out path/to/output_dir

Writes report.md (human-readable) and estimates.csv (every estimate, one row
each). Sections are labelled CONFIRMATORY, SENSITIVITY, SECONDARY or
EXPLORATORY; only the confirmatory section supports a hypothesis-test claim.

DRAFT (ANALYSIS_VERSION in phase2/__init__.py). Not ratified by the PI. See
analysis/PREREGISTRATION.md for what is protocol text and what is proposal.
"""

from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import stats
from statsmodels.duration.survfunc import SurvfuncRight

from . import ANALYSIS_VERSION, derive, qualitative
from .models import ALPHA, Fit, benjamini_hochberg, fgls_cr2, growth_model, growth_model_fast, holm, pattern_mixture_slope
from .schema import Export, SchemaError, load_export

ACCESS_WEEKS = derive.ACCESS_WEEKS


class Report:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.rows: list[dict] = []

    def h(self, text: str, level: int = 2) -> None:
        self.lines += ["", "#" * level + " " + text, ""]

    def p(self, text: str = "") -> None:
        self.lines.append(text)

    def table(self, df: pd.DataFrame, fmt: str = "{:.3f}") -> None:
        def cell(v) -> str:
            if isinstance(v, (float, np.floating)):
                return "" if np.isnan(v) else fmt.format(v)
            return str(v)

        self.lines.append("| " + " | ".join(map(str, df.columns)) + " |")
        self.lines.append("|" + "---|" * len(df.columns))
        for row in df.itertuples(index=False):
            self.lines.append("| " + " | ".join(cell(v) for v in row) + " |")
        self.lines.append("")

    def estimate(self, family: str, key: str, label: str, fit: Fit | dict, p_adj: float | None = None, extra: str = "") -> None:
        d = fit.as_dict() if isinstance(fit, Fit) else dict(fit)
        self.rows.append(
            {
                "family": family,
                "id": key,
                "label": label,
                "estimate": d.get("estimate"),
                "se": d.get("se"),
                "ci_low": d.get("ci_low"),
                "ci_high": d.get("ci_high"),
                "p": d.get("p"),
                "p_adjusted": p_adj,
                "n_participants": d.get("n_participants"),
                "n_obs": d.get("n_obs"),
                "model": d.get("model", ""),
                "note": "; ".join(x for x in [d.get("note", ""), extra] if x),
            }
        )


def _p(p: float) -> str:
    return "< 0.0001" if p < 0.0001 else f"= {p:.4f}"


def _fmt(fit: Fit | dict, unit: str = "") -> str:
    d = fit.as_dict() if isinstance(fit, Fit) else fit
    if d.get("estimate") is None or np.isnan(d["estimate"]):
        return f"not estimable ({d.get('note', '')})"
    s = f"{d['estimate']:+.4f}{unit} (95% CI {d['ci_low']:+.4f} to {d['ci_high']:+.4f})"
    if d.get("p") is not None:
        s += ", p " + _p(d["p"])
    if d.get("n_participants"):
        s += f"; {d['n_participants']} participants, {d['n_obs']} observations"
    if d.get("note"):
        s += f" [{d['note']}]"
    return s


def _try(fn, *args, **kwargs):
    """Secondary and exploratory analyses must not take the whole run down
    when a table is empty or too thin; the confirmatory section never uses this."""
    try:
        return fn(*args, **kwargs), None
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"


# --------------------------------------------------------------------------


def section_population(rep: Report, ex: Export, pop: pd.DataFrame, excluded: pd.DataFrame, panels: dict, comp: pd.DataFrame) -> None:
    rep.h("1. Analysis population and participant flow")
    rep.p(f"- Rows in participants.csv: {len(ex['participants'])}")
    rep.p(f"- Excluded, no finished baseline survey (cannot be placed on study time): {len(excluded)}")
    rep.p(f"- Analysis population: {len(pop)}")
    rep.p(f"- study_status: {pop['study_status'].value_counts().to_dict()}")
    rep.p(f"- Completers (a PHQ-2 or GAD-2 observation at study week {derive.COMPLETER_FROM_WEEK:g} or later): "
          f"{int(comp['completer'].sum())} ({comp['completer'].mean():.1%}); attrition {1 - comp['completer'].mean():.1%}")
    anon = int(ex["sessions"]["participant_id"].isna().sum())
    rep.p(f"- Anonymous sessions ignored: {anon}")
    rep.p()
    rows = []
    for scale, panel in panels.items():
        prim = panel[panel["primary"]]
        for source, g in prim.groupby("source"):
            rows.append({"outcome": scale, "source": source, "observations": len(g), "participants": g["participant_id"].nunique(),
                         "mean": g["score"].mean(), "sd": g["score"].std()})
    rep.p("Primary-window observations by source:")
    rep.p()
    rep.table(pd.DataFrame(rows), "{:.2f}")
    phq = panels["phq2"][panels["phq2"]["primary"]]
    by_week = phq.assign(week=np.minimum(np.ceil(phq["t_weeks"]).astype(int), ACCESS_WEEKS)).groupby("week")
    rep.p("PHQ-2 by study week (week 0 = baseline survey; week k = (k-1, k] weeks after it; week 8 includes the grace window):")
    rep.p()
    rep.table(by_week["score"].agg(participants="count", mean="mean", sd="std").reset_index(), "{:.2f}")


def section_confirmatory(rep: Report, panels: dict) -> dict[str, Fit]:
    rep.h("2. CONFIRMATORY: PHQ-2 and GAD-2 change over the access period (H1, H2)")
    rep.p("Model: score ~ time (weeks since baseline), random intercept and random time slope per participant, REML;")
    rep.p(f"two-sided alpha = {ALPHA}, t reference on participants - 1; Holm adjustment across the two co-primary outcomes.")
    rep.p()
    fits: dict[str, Fit] = {}
    for scale, panel in panels.items():
        fits[scale] = growth_model(panel[panel["primary"]])
    adj = holm([f.p for f in fits.values()])
    for (scale, fit), p_holm in zip(fits.items(), adj):
        panel = panels[scale]
        base_sd = float(panel[panel["source"] == "baseline"]["score"].std())
        d = fit.estimate * ACCESS_WEEKS / base_sd
        verdict = "REJECT H0" if p_holm < ALPHA else "do not reject H0"
        label = {"phq2": "H1 PHQ-2", "gad2": "H2 GAD-2"}[scale]
        rep.p(f"- **{label}** slope per week: {_fmt(fit)}")
        rep.p(f"  - Holm-adjusted p {_p(p_holm)}: **{verdict}**")
        rep.p(f"  - Standardized 8-week change d = slope x 8 / baseline SD ({base_sd:.2f}) = {d:+.3f}")
        rep.p(f"  - Variance components: intercept {fit.var_intercept:.3f}, slope {fit.var_slope:.5f}, residual {fit.var_resid:.3f}; model: {fit.model}")
        fast = growth_model_fast(panel[panel["primary"]])
        rep.p(f"  - Independent REML implementation (cross-check, not a second test): {fast.estimate:+.4f}, SE {fast.se:.4f} vs {fit.se:.4f}")
        rep.estimate("confirmatory", f"H_{scale}", f"{label} slope per week", fit, p_holm, f"d_8wk={d:+.3f}")
    return fits


def section_sensitivity(rep: Report, panels: dict, comp: pd.DataFrame) -> None:
    rep.h("3. SENSITIVITY analyses for H1 and H2 (pre-specified; not additional tests)")
    rep.p("These show whether the confirmatory estimate depends on an analysis choice. They do not change the verdict above.")
    for scale, panel in panels.items():
        prim = panel[panel["primary"]]
        rep.p()
        rep.p(f"**{scale.upper()}** slope per week:")
        variants = {
            "a. September estimator (random-intercept FGLS, CR2 SEs)": lambda: fgls_cr2(prim),
            "b. in-app screeners only": lambda: growth_model(prim[prim["source"] == "in_app"]),
            "c. adjusting for mode (Qualtrics vs in-app)": lambda: growth_model(prim, covariates=("qualtrics",)),
            "d. excluding survey responses flagged as speeders": lambda: growth_model(prim[~prim["speeder"]]),
            "e. completers only": lambda: growth_model(prim.merge(comp[comp["completer"]][["participant_id"]], on="participant_id")),
        }
        for label, fn in variants.items():
            fit, err = _try(fn)
            rep.p(f"- {label}: {_fmt(fit) if fit else 'not estimable: ' + err}")
            if fit:
                rep.estimate("sensitivity", f"{scale}_{label[0]}", f"{scale} {label}", fit)
        pm, err = _try(pattern_mixture_slope, prim.merge(comp[["participant_id", "dropout"]], on="participant_id"))
        if pm and not np.isnan(pm["estimate"]):
            rep.p(f"- f. pattern-mixture (completers and dropouts may differ; averaged over {pm['dropout_share']:.1%} dropouts): "
                  f"{pm['estimate']:+.4f} (95% CI {pm['ci_low']:+.4f} to {pm['ci_high']:+.4f}); "
                  f"completers {pm['slope_completers']:+.4f}, dropouts differ by {pm['slope_difference_dropouts']:+.4f}")
            rep.estimate("sensitivity", f"{scale}_f", f"{scale} f. pattern-mixture averaged slope", pm)
        else:
            rep.p(f"- f. pattern-mixture: not estimable ({err or pm.get('note')})")
    rep.p()
    base = panels["phq2"][panels["phq2"]["source"] == "baseline"].merge(comp[["participant_id", "completer"]], on="participant_id")
    g = base.groupby("completer")["score"].agg(["count", "mean", "std"]).reset_index()
    rep.p("Missing-data diagnostic: baseline PHQ-2 by completion status (a large gap argues against missing-completely-at-random):")
    rep.p()
    rep.table(g, "{:.2f}")


def _km(sessions: pd.DataFrame, pop: pd.DataFrame) -> dict:
    last = sessions.groupby("participant_id")["t_weeks"].max().reindex(pop["participant_id"]).fillna(0.0)
    event = (last < ACCESS_WEEKS - 1).astype(int)  # no session in the final access week
    time = np.where(event == 1, np.maximum(last, 0.01), ACCESS_WEEKS)
    sf = SurvfuncRight(time, event.to_numpy())
    at = {w: float(sf.surv_prob[np.searchsorted(sf.surv_times, w, side="right") - 1]) if (sf.surv_times <= w).any() else 1.0 for w in (2, 4, 6)}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        median = sf.quantile(0.5)
    return {"n": len(pop), "events": int(event.sum()), "median_weeks": float(median) if np.isfinite(median) else float("nan"), "surv": at}


def _poisson_gee(counts: pd.DataFrame) -> dict:
    X = sm.add_constant(counts[["study_week"]].astype(float))
    res = sm.GEE(counts["n_sessions"].astype(float), X, groups=counts["participant_id"], family=sm.families.Poisson(),
                 cov_struct=sm.cov_struct.Exchangeable()).fit()
    est, se = float(res.params["study_week"]), float(res.bse["study_week"])
    return {"estimate": est, "se": se, "ci_low": est - 1.96 * se, "ci_high": est + 1.96 * se, "p": float(res.pvalues["study_week"]),
            "n_participants": int(counts["participant_id"].nunique()), "n_obs": len(counts), "model": "GEE Poisson, exchangeable, robust SE"}


def _paired_change(panel: pd.DataFrame) -> dict:
    wide = panel[panel["source"].isin(["exit", "week12"])].pivot_table(index="participant_id", columns="source", values="score").dropna()
    diff = wide["week12"] - wide["exit"]
    t = stats.ttest_1samp(diff, 0.0)
    ci = t.confidence_interval(0.95)
    return {"estimate": float(diff.mean()), "se": float(diff.std(ddof=1) / np.sqrt(len(diff))), "ci_low": float(ci.low), "ci_high": float(ci.high),
            "p": float(t.pvalue), "n_participants": len(diff), "n_obs": 2 * len(diff), "model": "paired t (week 12 minus exit)"}


def section_secondary(rep: Report, ex: Export, pop: pd.DataFrame, panels: dict, weekly: pd.DataFrame, sessions: pd.DataFrame) -> None:
    rep.h("4. SECONDARY analyses (pre-specified; estimates and intervals; Benjamini-Hochberg q-values within this family)")
    tested: list[tuple[str, str, dict | Fit]] = []

    rep.p("**S1 Engagement survival** (time to disengagement = last session, when no session falls in the final access week):")
    km, err = _try(_km, sessions, pop)
    if km:
        med = "not reached (more than half stayed engaged)" if np.isnan(km["median_weeks"]) else f"{km['median_weeks']:.1f} weeks"
        rep.p(f"- {km['events']} of {km['n']} disengaged before the final week; Kaplan-Meier median {med}; "
              + ", ".join(f"still engaged at week {w}: {s:.1%}" for w, s in km["surv"].items()))
    else:
        rep.p(f"- not estimable: {err}")

    rep.p()
    rep.p("**S2 Working alliance growth** (WAI-SR total, weekly surveys, weeks 1-8; slope per week):")
    al = weekly.dropna(subset=["weekly_alliance_total"]).assign(alliance=lambda d: d["weekly_alliance_total"].astype(float), week=lambda d: d["study_week"].astype(float))
    fit, err = _try(growth_model, al, outcome="alliance", time="week")
    rep.p(f"- total: {_fmt(fit) if fit else 'not estimable: ' + err}")
    if fit:
        tested.append(("S2", "WAI-SR total slope per week", fit))
    for sub in ("task", "bond", "goal"):
        d = weekly.dropna(subset=[f"weekly_alliance_{sub}"]).assign(alliance=lambda x: x[f"weekly_alliance_{sub}"].astype(float), week=lambda x: x["study_week"].astype(float))
        f2, e2 = _try(growth_model, d, outcome="alliance", time="week")
        rep.p(f"- {sub} subscale (descriptive, not in the q-value family): {_fmt(f2) if f2 else 'not estimable: ' + e2}")
        if f2:
            rep.estimate("secondary_descriptive", f"S2_{sub}", f"WAI-SR {sub} slope per week", f2)

    rep.p()
    rep.p("**S3 Safety-system descriptives** (no inference):")
    pop_sessions = ex["sessions"][ex["sessions"]["participant_id"].isin(pop["participant_id"])]
    ev = ex["crisis_events"][ex["crisis_events"]["participant_id"].isin(pop["participant_id"])]
    adj = ex["crisis_adjudications"][ex["crisis_adjudications"]["participant_id"].isin(pop["participant_id"])]
    rep.p(f"- sessions: {len(pop_sessions)}; crisis-flagged: {int(pop_sessions['crisis_flagged'].fillna(False).sum())} "
          f"({pop_sessions['crisis_flagged'].fillna(False).mean():.2%}); participants ever flagged: {int(pop['any_crisis_flagged'].fillna(False).sum())}")
    rep.p(f"- crisis events by severity: {ev['severity'].value_counts().to_dict()}")
    rep.p(f"- human adjudication verdicts: {adj['verdict'].value_counts().to_dict()} ({len(adj)} verdicts on {len(ev)} events)")

    rep.p()
    rep.p("**S4 Persistence after access ends** (week-12 follow-up minus exit survey, same participants):")
    for scale, panel in panels.items():
        r, err = _try(_paired_change, panel)
        rep.p(f"- {scale.upper()}: {_fmt(r) if r else 'not estimable: ' + err}")
        if r:
            tested.append((f"S4_{scale}", f"{scale} week-12 minus exit", r))

    rep.p()
    rep.p("**S5 Convergent validity** (in-app PHQ-2 on the same study week's self-reported mood, 1-6, higher = better):")
    phq = panels["phq2"]
    phq = phq[phq["source"] == "in_app"].assign(study_week=lambda d: np.floor(d["t_weeks"]).astype(int) + 1)
    both = phq.merge(weekly[["participant_id", "study_week", "weekly_mood"]].dropna(), on=["participant_id", "study_week"])
    both["mood"] = both["weekly_mood"].astype(float)
    fit, err = _try(growth_model, both, outcome="score", time="mood")
    rep.p(f"- PHQ-2 points per mood point: {_fmt(fit) if fit else 'not estimable: ' + err}")
    if fit:
        tested.append(("S5", "PHQ-2 per weekly mood point", fit))

    rep.p()
    rep.p("**S6 Novelty decay** (sessions per participant-week on study week; log rate ratio per week):")
    counts = derive.weekly_session_counts(sessions, pop)
    r, err = _try(_poisson_gee, counts)
    rep.p(f"- {_fmt(r) if r else 'not estimable: ' + err}")
    if r:
        rep.p(f"  - rate ratio per week {np.exp(r['estimate']):.3f}; note zero weeks after dropout are counted as zero sessions")
        tested.append(("S6", "log rate ratio of weekly sessions per study week", r))
    rep.p()
    rep.table(counts.groupby("study_week")["n_sessions"].agg(mean_sessions="mean", share_with_any=lambda s: (s > 0).mean()).reset_index(), "{:.2f}")

    if tested:
        qs = benjamini_hochberg([(t[2].p if isinstance(t[2], Fit) else t[2]["p"]) for t in tested])
        rep.p("Benjamini-Hochberg q-values for the secondary family:")
        rep.p()
        rep.table(pd.DataFrame([{"id": k, "analysis": label, "q": q} for (k, label, _), q in zip(tested, qs)]), "{:.4f}")
        for (k, label, f), q in zip(tested, qs):
            rep.estimate("secondary", k, label, f, q)


def _session_arm_effect(feedback: pd.DataFrame) -> dict:
    d = feedback.dropna(subset=["helpfulness_rating", "proactive"])
    X = pd.DataFrame({"Intercept": 1.0, "proactive": d["proactive"].to_numpy(dtype=float)})
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        res = sm.MixedLM(d["helpfulness_rating"].to_numpy(dtype=float), X, groups=d["participant_id"].to_numpy()).fit(reml=True)
    est, se = float(res.fe_params["proactive"]), float(res.bse_fe["proactive"])
    return {"estimate": est, "se": se, "ci_low": est - 1.96 * se, "ci_high": est + 1.96 * se, "p": float(res.pvalues["proactive"]),
            "n_participants": int(d["participant_id"].nunique()), "n_obs": len(d), "model": "random intercept, REML"}


def section_exploratory(rep: Report, ex: Export, pop: pd.DataFrame, panels: dict, weekly: pd.DataFrame, sessions: pd.DataFrame) -> None:
    rep.h("5. EXPLORATORY analyses (hypothesis-generating; no significance claims, no adjustment)")
    arm = sessions["proactive_offering"].fillna("not evaluated").value_counts().to_dict()
    rep.p(f"proactive_offering is assigned per SESSION, not per participant. Sessions by condition: {arm}.")
    expo = derive.proactive_exposure(sessions)
    if len(expo):
        rep.p(f"Participant share of proactive sessions: mean {expo['proactive_share'].mean():.2f}, SD {expo['proactive_share'].std():.2f} "
              "(a small SD means the participant-level contrast below has little leverage).")
    rep.p()
    rep.p("**E1a Session-level proactive effect on post-session helpfulness rating (1-5)** (the comparison the per-session randomisation supports):")
    fb = ex["feedback"].merge(sessions[["session_pseudo_id", "proactive"]], on="session_pseudo_id")
    r, err = _try(_session_arm_effect, fb)
    rep.p(f"- proactive minus reactive: {_fmt(r) if r else 'not estimable: ' + err}")
    if r:
        rep.estimate("exploratory", "E1a", "helpfulness: proactive minus reactive session", r)
    rep.p()
    rep.p("**E1b PHQ-2 and GAD-2 slope by share of proactive sessions** (time x exposure; exposure is post-baseline and only random given the number of sessions):")
    for scale, panel in panels.items():
        d = panel[panel["primary"]].merge(expo[["participant_id", "proactive_share_c"]], on="participant_id")
        fit, err = _try(growth_model, d, moderator="proactive_share_c")
        rep.p(f"- {scale.upper()}, slope difference all-proactive vs all-reactive: {_fmt(fit) if fit else 'not estimable: ' + err}")
        if fit:
            rep.estimate("exploratory", f"E1b_{scale}", f"{scale} time x proactive share", fit)
    rep.p()
    rep.p("**E2 Alliance and engagement** (WAI-SR total on sessions that study week, within the mixed model):")
    counts = derive.weekly_session_counts(sessions, pop)
    d = weekly.dropna(subset=["weekly_alliance_total"]).merge(counts, on=["participant_id", "study_week"])
    d = d.assign(alliance=d["weekly_alliance_total"].astype(float), n_sessions=d["n_sessions"].astype(float))
    fit, err = _try(growth_model, d, outcome="alliance", time="n_sessions")
    rep.p(f"- alliance points per additional session: {_fmt(fit) if fit else 'not estimable: ' + err}")
    if fit:
        rep.estimate("exploratory", "E2", "WAI-SR total per additional weekly session", fit)


def section_qualitative(rep: Report) -> None:
    rep.h("6. PLACEHOLDER: AI second coder qualitative reliability (ai-therapist-171)")
    try:
        qualitative.second_coder_reliability()
    except NotImplementedError as exc:
        rep.p(f"NOT IMPLEMENTED: {exc}")
        rep.p(f"Kappa threshold: {qualitative.KAPPA_THRESHOLD} (to be set by the PI).")


def run(data_dir: str | Path, out_dir: str | Path) -> Report:
    ex = load_export(data_dir)
    pop, excluded = derive.analysis_population(ex)
    if len(pop) < 3:
        raise SchemaError(f"only {len(pop)} participant(s) have a finished baseline survey; nothing to analyse")
    panels, infos = {}, {}
    for scale in ("phq2", "gad2"):
        panels[scale], infos[scale] = derive.outcome_panel(ex, pop, scale)
    comp = derive.completion(pop, panels)
    weekly = derive.weekly_panel(ex, pop)
    sessions = derive.session_panel(ex, pop)

    rep = Report()
    synthetic = (ex.export_git_sha or "").startswith("synthetic")
    rep.lines.append("# Phase 2 analysis report" + (" (SYNTHETIC DATA: not study results)" if synthetic else ""))
    rep.p()
    rep.p(f"- analysis version: {ANALYSIS_VERSION} (DRAFT, not ratified by the PI)")
    rep.p(f"- export as_of: {ex.as_of}; export git_sha: {ex.export_git_sha}; expected schema version: {ex.schema_version}")
    rep.p(f"- schema validation: passed, {len(ex.warnings)} warning(s)")
    for w in ex.warnings:
        rep.p(f"  - WARNING: {w}")
    for scale, info in infos.items():
        for k, v in info.items():
            if v:
                rep.p(f"  - NOTE ({scale}): {k} = {v}")

    section_population(rep, ex, pop, excluded, panels, comp)
    section_confirmatory(rep, panels)
    section_sensitivity(rep, panels, comp)
    section_secondary(rep, ex, pop, panels, weekly, sessions)
    section_exploratory(rep, ex, pop, panels, weekly, sessions)
    section_qualitative(rep)

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.md").write_text("\n".join(rep.lines) + "\n")
    pd.DataFrame(rep.rows).to_csv(out / "estimates.csv", index=False, float_format="%.6g")
    return rep


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="path to an UNZIPPED dataset export directory")
    ap.add_argument("--out", required=True, help="directory for report.md and estimates.csv")
    args = ap.parse_args()
    try:
        rep = run(args.data, args.out)
    except SchemaError as exc:
        print(f"SCHEMA ERROR: {exc}", file=sys.stderr)
        return 2
    print("\n".join(rep.lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
