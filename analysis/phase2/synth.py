"""Synthetic study generator. Emits files in the exact dataset-export format.

SYNTHETIC DATA ONLY. Nothing here reads a database or a real export. The
generator exists so that (a) the analysis is known to run end to end before any
real data exists and (b) the power simulation exercises the same data shape
and the same estimator as the real analysis.

Two stages, two independent random streams:
  simulate_outcomes()  the science: who enrols, who drops out, when each
                       PHQ-2 / GAD-2 / weekly survey is observed and its value.
                       The power simulation stops here.
  write_export()       the packaging: sessions, feedback, crisis events and the
                       other tables, then CSVs byte-shaped like the real export
                       (same quoting, null and boolean rendering as toCsv() in
                       src/server/services/datasetExport.service.ts).

    python -m phase2.synth --out build/synthetic-export --seed 20261116
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from .schema import expected_schema

DAY = 86400.0
WEEK = 7 * DAY
ACCESS_WEEKS = 8

# WAI-SR subscale keys, copied from qualtricsScoring.service.ts (ALLIANCE_KEYS).
WAI_TASK, WAI_BOND, WAI_GOAL = [1, 2, 10, 12], [3, 5, 7, 9], [4, 6, 8, 11]


@dataclass(frozen=True)
class SimParams:
    """Every number here is a planning ASSUMPTION unless a source is cited.

    Sources: [app] docs/irb-phase2-longitudinal-application.md,
    [power] docs/phase2-power-analysis.md, [lit] docs/irb-phase2-literature-review-2026-09.md.
    """

    n_enrolled: int = 120  # [app] Subject Enrollment: "Enroll up to 120"
    attrition: float = 0.30  # cumulative dropout by week 8; [app] anticipates 25-40%, [power] plans on 30%
    occasion_miss: float = 0.20  # [power] share of in-app screener weeks skipped among active participants
    d_change: float = 0.30  # standardized 8-week mean change (improvement = lower score); [power] "medium"
    icc: float = 0.64  # between-person share of baseline variance; [power] implies 1.2^2/(1.2^2+0.9^2)
    total_sd: float = 1.5  # [power] total baseline SD of PHQ-2
    baseline_mean: float = 2.2  # [power]
    slope_sd: float = 0.04  # [power] between-person SD of weekly slope
    # Arm effect: standardized difference in 8-week change between an
    # all-proactive and an all-reactive participant. 0 = no arm effect.
    d_arm: float = 0.0
    # 'session': each session is randomised 50/50 (what resolveProactiveOffering()
    # does today). 'participant': one arm per participant (the protocol's
    # reserve Option B; NOT implemented in the app).
    arm_assignment: str = "session"
    sessions_per_week: float = 2.0  # [app] "suggest at least two brief interactions per week"
    exit_response: float = 0.90  # assumption: share of retained participants who file the exit survey
    week12_response: float = 0.70  # assumption
    weekly_survey_response: float = 0.80  # assumption
    gad_baseline_mean: float = 2.4  # assumption
    gad_phq_corr: float = 0.6  # assumption: correlation of person-level PHQ-2 and GAD-2 levels
    alliance_mean: float = 3.2  # assumption (1-5 scale)
    alliance_slope: float = 0.05  # assumption: points per week
    study_start: str = "2027-01-11T15:00:00Z"  # arbitrary synthetic calendar

    def with_(self, **kw) -> "SimParams":
        return replace(self, **kw)

    @property
    def weekly_hazard(self) -> float:
        return 1 - (1 - self.attrition) ** (1 / ACCESS_WEEKS)

    @property
    def intercept_sd(self) -> float:
        return float(np.sqrt(self.icc) * self.total_sd)

    @property
    def resid_sd(self) -> float:
        return float(np.sqrt(1 - self.icc) * self.total_sd)


@dataclass
class Outcomes:
    params: SimParams
    participants: pd.DataFrame  # pid, anchor_s, dropout_week (9 = retained), arm, withdrew
    screeners: pd.DataFrame  # pid, scale, t_s, score, source ('in_app'|'baseline'|'exit'|'week12')
    weekly: pd.DataFrame  # pid, study_week, t_s, alliance items..., mood, stress
    session_counts: np.ndarray  # [n, 8] sessions per study week (excludes the onboarding session)
    proactive_counts: np.ndarray  # [n, 8] of which proactive
    onboarding_proactive: np.ndarray  # [n] bool
    extras: dict = field(default_factory=dict)


def _discrete(x: float, lo: int, hi: int) -> int:
    """Round a latent value to the instrument's integer response range."""
    return int(min(max(round(float(x)), lo), hi))


def simulate_outcomes(p: SimParams, rng: np.random.Generator) -> Outcomes:
    n = p.n_enrolled
    anchor = rng.uniform(0, 28 * DAY, n).round()  # rolling enrolment over four weeks
    dropout_week = np.minimum(rng.geometric(p.weekly_hazard, n), ACCESS_WEEKS + 1)  # 9 = retained
    withdrew = (dropout_week <= ACCESS_WEEKS) & (rng.random(n) < 0.3)

    # Sessions per study week while active, and how many were proactive.
    active = np.arange(1, ACCESS_WEEKS + 1)[None, :] < dropout_week[:, None]
    counts = rng.poisson(p.sessions_per_week, (n, ACCESS_WEEKS)) * active
    if p.arm_assignment == "participant":
        arm = rng.permutation(np.arange(n) % 2).astype(float)
        proactive = counts * arm[:, None].astype(int)
        onboarding_pro = arm.astype(bool)
        exposure = arm
    elif p.arm_assignment == "session":
        proactive = rng.binomial(counts, 0.5)
        onboarding_pro = rng.random(n) < 0.5
        total = counts.sum(1) + 1
        exposure = (proactive.sum(1) + onboarding_pro) / total
        arm = np.full(n, np.nan)
    else:
        raise ValueError(f"unknown arm_assignment {p.arm_assignment!r}")

    # Person-level random effects. Improvement is a NEGATIVE slope.
    u = rng.normal(0, p.intercept_sd, n)
    s = rng.normal(0, p.slope_sd, n)
    mean_slope = -p.d_change * p.total_sd / ACCESS_WEEKS
    arm_slope = -p.d_arm * p.total_sd / ACCESS_WEEKS
    slope = mean_slope + s + arm_slope * (exposure - 0.5)
    ug = p.gad_phq_corr * u + np.sqrt(1 - p.gad_phq_corr**2) * rng.normal(0, p.intercept_sd, n)
    v = rng.normal(0, 0.6, n)  # alliance level

    q_screen = min(1.0, (1 - p.occasion_miss) / (1 - np.exp(-p.sessions_per_week)))
    offset = rng.uniform(0.2, 4.0, n) * DAY
    rows: list[tuple] = []
    weekly_rows: list[tuple] = []

    def observe(i: int, t_s: float, source: str) -> None:
        tw = min(t_s / WEEK, ACCESS_WEEKS)  # the mean trend holds at its week-8 level afterwards
        e1, e2 = rng.normal(0, p.resid_sd, 2)
        rows.append((i, "phq2", t_s, int(_discrete(p.baseline_mean + u[i] + slope[i] * tw + e1, 0, 6)), source))
        rows.append((i, "gad2", t_s, int(_discrete(p.gad_baseline_mean + ug[i] + slope[i] * tw + e2, 0, 6)), source))

    for i in range(n):
        observe(i, 0.0, "baseline")
        prev = -np.inf
        for k in range(1, ACCESS_WEEKS + 1):
            if k >= dropout_week[i]:
                break
            if counts[i, k - 1] >= 1 and rng.random() < q_screen:
                # The app refuses a screener within 7 days of the previous one.
                t = max((k - 1) * WEEK + offset[i] + rng.uniform(0, 1.5) * DAY, prev + WEEK + 60)
                prev = t
                observe(i, float(round(t)), "in_app")
            if rng.random() < p.weekly_survey_response:
                t = (k - 1) * WEEK + rng.uniform(1.0, 6.9) * DAY
                latent = p.alliance_mean + v[i] + p.alliance_slope * k
                items = np.clip(np.rint(latent + rng.normal(0, 0.6, 12)), 1, 5).astype(int)
                mood = int(_discrete(4.2 - 0.5 * (u[i] + slope[i] * k) + rng.normal(0, 0.8), 1, 6))
                stress = int(_discrete(2.8 + 0.4 * ug[i] + rng.normal(0, 0.8), 1, 5))
                weekly_rows.append((i, k, float(round(t)), *items.tolist(), mood, stress))
        if dropout_week[i] > ACCESS_WEEKS:
            if rng.random() < p.exit_response:
                observe(i, float(round(ACCESS_WEEKS * WEEK + rng.uniform(0, 5) * DAY)), "exit")
            if rng.random() < p.week12_response:
                observe(i, float(round(12 * WEEK + rng.uniform(0, 7) * DAY)), "week12")

    participants = pd.DataFrame(
        {"pid": np.arange(n), "anchor_s": anchor, "dropout_week": dropout_week, "arm": arm, "withdrew": withdrew}
    )
    screeners = pd.DataFrame(rows, columns=["pid", "scale", "t_s", "score", "source"])
    weekly = pd.DataFrame(
        weekly_rows, columns=["pid", "study_week", "t_s", *[f"wai{j}" for j in range(1, 13)], "mood", "stress"]
    )
    return Outcomes(p, participants, screeners, weekly, counts, proactive, onboarding_pro)


def panel_from_outcomes(o: Outcomes, scale: str = "phq2") -> pd.DataFrame:
    """The primary-analysis panel straight from simulated outcomes: the same
    rows derive.outcome_panel() recovers after a round trip through the CSV
    export (tests/test_pipeline.py asserts this). Used by the power simulation
    to skip the disk round trip."""
    from .derive import GRACE_WEEKS  # local import: derive imports nothing from here

    s = o.screeners[(o.screeners["scale"] == scale) & (o.screeners["source"] != "week12")].copy()
    s["t_weeks"] = s["t_s"] / WEEK
    s = s[s["t_weeks"] <= ACCESS_WEEKS + GRACE_WEEKS]
    s["participant_id"] = s["pid"].map(lambda i: f"P{i + 1:03d}")
    exposure = (o.proactive_counts.sum(1) + o.onboarding_proactive) / (o.session_counts.sum(1) + 1)
    s["proactive_share_c"] = exposure[s["pid"].to_numpy()] - 0.5
    return s[["participant_id", "t_weeks", "score", "source", "proactive_share_c"]].reset_index(drop=True)


# --------------------------------------------------------------------------
# Export writer
# --------------------------------------------------------------------------


def to_csv(columns: list[dict], rows: list[dict]) -> str:
    """Byte-compatible with toCsv() in datasetExport.service.ts: bare header,
    null -> empty, booleans bare, everything else double-quoted."""
    lines = [",".join(c["name"] for c in columns)]
    for row in rows:
        cells = []
        for c in columns:
            v = row.get(c["name"])
            if v is None:
                cells.append("")
            elif isinstance(v, (bool, np.bool_)):
                cells.append("true" if v else "false")
            elif isinstance(v, (list, dict)):
                cells.append('"' + json.dumps(v, separators=(",", ":")).replace('"', '""') + '"')
            else:
                cells.append('"' + str(v).replace('"', '""') + '"')
        lines.append(",".join(cells))
    return "\n".join(lines) + "\n"


def _iso(base: datetime, seconds: float) -> str:
    return (base + timedelta(seconds=float(seconds))).strftime("%Y-%m-%dT%H:%M:%SZ")


def _num(x: float) -> str:
    """Render like JavaScript's String(number) for the short decimals used here."""
    return f"{round(float(x), 2):g}"


def write_export(o: Outcomes, out_dir: str | Path, seed: int = 0) -> Path:
    """Write a complete synthetic export directory (13 CSVs + codebook.md)."""
    rng = np.random.default_rng([seed, 1])  # packaging stream, independent of the outcome stream
    p = o.params
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    spec = expected_schema()["files"]
    base = datetime.strptime(p.study_start, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    pid = lambda i: f"P{i + 1:03d}"  # noqa: E731
    anchor = o.participants["anchor_s"].to_numpy()

    # ---- sessions (one onboarding session + the weekly counts) ----
    sessions: list[dict] = []
    screen_t = {
        (int(r.pid), int(r.t_s // WEEK) + 1): r.t_s
        for r in o.screeners[(o.screeners.source == "in_app") & (o.screeners.scale == "phq2")].itertuples()
    }
    for i in range(p.n_enrolled):
        plan = [(1800.0, bool(o.onboarding_proactive[i]))]
        for k in range(1, ACCESS_WEEKS + 1):
            c, pro = int(o.session_counts[i, k - 1]), int(o.proactive_counts[i, k - 1])
            flags = rng.permutation([True] * pro + [False] * (c - pro)).tolist()
            times = sorted(((k - 1) * WEEK + rng.uniform(0.1, 6.9, c) * DAY).tolist())
            if (i, k) in screen_t and c:
                times[0] = screen_t[(i, k)] - 300  # the session the screener was administered in
            plan += list(zip(times, flags))
        for t, pro in plan:
            dur = float(np.clip(rng.gamma(4, 4), 2, 60))
            n_user = int(rng.integers(3, 15))
            flagged = bool(rng.random() < 0.03)
            sessions.append(
                {
                    "_i": i,
                    "_abs": anchor[i] + t,
                    "_dur": dur,
                    "participant_id": pid(i),
                    "is_anonymous": False,
                    "status": "ended",
                    "ended_by": "user",
                    "session_type": "chat" if rng.random() < 0.6 else "realtime",
                    "modality_condition": "supportive",
                    "proactive_offering": "true" if pro else "false",
                    "theme": "default",
                    "language": "en",
                    "voice": "alloy",
                    "ai_model": "synthetic-model",
                    "transcription_model": None,
                    "temperature": "0.80",
                    "checkin_mood": int(rng.integers(1, 11)) if rng.random() < 0.7 else None,
                    "had_recording": False,
                    "recording_duration_s": None,
                    "n_messages": 2 * n_user,
                    "n_user_messages": n_user,
                    "n_assistant_messages": n_user,
                    "n_tool_invocations": int(rng.integers(0, 3)),
                    "crisis_flagged": flagged,
                    "crisis_severity": str(rng.choice(["low", "medium", "high"], p=[0.6, 0.3, 0.1])) if flagged else None,
                    "crisis_max_risk_score": int(rng.integers(25, 90)) if flagged else None,
                    "n_crisis_events": int(flagged),
                    "n_crisis_events_auto": int(flagged),
                    "n_crisis_events_manual": 0,
                    "n_risk_check_steps": int(flagged) * 2,
                    "llm_tokens_in": int(rng.integers(5000, 40000)),
                    "llm_tokens_out": int(rng.integers(500, 3000)),
                }
            )
    # A few anonymous sessions: the real export includes them and every
    # participant-level analysis must ignore them.
    for _ in range(5):
        sessions.append(
            {**sessions[0], "_i": -1, "_abs": rng.uniform(0, 60 * DAY), "participant_id": None, "is_anonymous": True,
             "crisis_flagged": False, "crisis_severity": None, "crisis_max_risk_score": None, "n_crisis_events": 0,
             "n_crisis_events_auto": 0, "n_risk_check_steps": 0, "checkin_mood": None}
        )
    sessions.sort(key=lambda s: s["_abs"])
    for j, s in enumerate(sessions):
        s["session_pseudo_id"] = f"S{j + 1:04d}"
        s["started_at"] = _iso(base, s["_abs"])
        s["ended_at"] = _iso(base, s["_abs"] + s["_dur"] * 60)
        s["duration_minutes"] = f"{s['_dur']:.1f}"
    by_pid: dict[int, list[dict]] = {}
    for s in sessions:
        by_pid.setdefault(s["_i"], []).append(s)

    def session_at(i: int, abs_t: float) -> str:
        """Pseudonym of participant i's latest session starting at or before abs_t."""
        cands = [s for s in by_pid[i] if s["_abs"] <= abs_t + 1]
        return (cands[-1] if cands else by_pid[i][0])["session_pseudo_id"]

    # ---- screeners (in-app only) ----
    scr = o.screeners[o.screeners.source == "in_app"].sort_values(["pid", "scale", "t_s"])
    screeners = []
    for (i, scale), g in scr.groupby(["pid", "scale"], sort=False):
        for occ, r in enumerate(g.itertuples(), start=1):
            a = int(rng.integers(max(0, r.score - 3), min(3, r.score) + 1))
            abs_t = anchor[i] + r.t_s
            screeners.append(
                {
                    "participant_id": pid(i),
                    "session_pseudo_id": session_at(i, abs_t),
                    "scale": scale,
                    "item_scores": [a, int(r.score) - a],
                    "score": int(r.score),
                    "screen_positive": bool(r.score >= 3),
                    "administered_at": _iso(base, abs_t),
                    "occasion_index": occ,
                }
            )
    screeners.sort(key=lambda r: (r["session_pseudo_id"], r["scale"], r["administered_at"]))

    # ---- surveys ----
    scored: list[dict] = []
    blank = {c["name"]: None for c in spec["surveys_scored.csv"]}
    wide = o.screeners[o.screeners.source != "in_app"].pivot_table(index=["pid", "source"], columns="scale", values=["score", "t_s"])
    floors = {"baseline": 120, "weekly": 20, "exit": 90, "week12": 45, "withdrawal": 10}
    typical = {"baseline": 600, "weekly": 180, "exit": 700, "week12": 300, "withdrawal": 50}

    def paradata(role: str) -> dict:
        secs = int(max(5, rng.lognormal(np.log(typical[role]), 0.5)))
        return {"completion_seconds": secs, "speeder": secs < floors[role]}

    for (i, role), r in wide.iterrows():
        phq, gad = int(r[("score", "phq2")]), int(r[("score", "gad2")])
        scored.append(
            {**blank, "participant_id": pid(i), "survey_role": role, "recorded_at": _iso(base, anchor[i] + r[("t_s", "phq2")]),
             **paradata(role), "phq2": phq, "gad2": gad, "phq2_positive": phq >= 3, "gad2_positive": gad >= 3}
        )
    usage_bucket = lambda c: "0" if c == 0 else "1" if c == 1 else "2-3" if c <= 3 else "4-6" if c <= 6 else "7 or more"  # noqa: E731
    for r in o.weekly.itertuples():
        items = {j: getattr(r, f"wai{j}") for j in range(1, 13)}
        sub = [round(sum(items[j] for j in keys) / 4 * 100) / 100 for keys in (WAI_TASK, WAI_BOND, WAI_GOAL)]
        c = int(o.session_counts[r.pid, r.study_week - 1])
        scored.append(
            {**blank, "participant_id": pid(r.pid), "survey_role": "weekly", "recorded_at": _iso(base, anchor[r.pid] + r.t_s),
             **paradata("weekly"), "weekly_mood": int(r.mood), "weekly_stress": int(r.stress),
             "weekly_helpfulness": int(rng.integers(1, 6)) if c else None, "weekly_usage": usage_bucket(c),
             "weekly_alliance_task": _num(sub[0]), "weekly_alliance_bond": _num(sub[1]), "weekly_alliance_goal": _num(sub[2]),
             "weekly_alliance_total": _num(round(sum(sub) / 3 * 100) / 100)}
        )
    for r in o.participants[o.participants.withdrew].itertuples():
        t = (r.dropout_week - 1) * WEEK + rng.uniform(0, 2) * DAY
        scored.append({**blank, "participant_id": pid(r.pid), "survey_role": "withdrawal",
                       "recorded_at": _iso(base, r.anchor_s + t), **paradata("withdrawal")})
    scored.sort(key=lambda r: (r["participant_id"], r["recorded_at"]))
    surveys = [{"participant_id": r["participant_id"], "survey_role": r["survey_role"], "finished": True,
                "recorded_at": r["recorded_at"]} for r in scored]

    # ---- per-session side tables ----
    linked = [s for s in sessions if s["_i"] >= 0]
    moods = [{"participant_id": s["participant_id"], "session_pseudo_id": s["session_pseudo_id"], "source": "checkin",
              "mood": s["checkin_mood"], "recorded_at": s["started_at"]} for s in sessions if s["checkin_mood"] is not None]
    feedback = [{"participant_id": s["participant_id"], "session_pseudo_id": s["session_pseudo_id"],
                 "helpfulness_rating": int(rng.integers(2, 6)), "ease_rating": int(rng.integers(3, 6)),
                 "would_return_rating": int(rng.integers(2, 6)), "has_comments": bool(rng.random() < 0.2),
                 "submitted_at": s["ended_at"]} for s in linked if rng.random() < 0.4]
    dims = ["safety_protocol", "empathy", "modality_fidelity", "disclaimer_compliance", "non_directiveness", "clinical_claims"]
    evals = [{"session_pseudo_id": s["session_pseudo_id"], "prompt_version": "synthetic-v1", "judge_model": "synthetic-judge",
              **{f"{d}_score": int(rng.integers(3, 6)) for d in dims}, "evaluated_at": s["ended_at"]} for s in sessions]
    ratings = [{"session_pseudo_id": s["session_pseudo_id"], "rater_role": "researcher", "rater_seq": 1,
                "rubric_version": "synthetic-v1", **{f"{d}_score": int(rng.integers(3, 6)) for d in dims},
                "queue_source": "stratified", "stratum": "supportive|low|2027-W03", "rated_at": s["ended_at"]}
               for s in linked if rng.random() < 0.05]
    crisis = [{"session_pseudo_id": s["session_pseudo_id"], "participant_id": s["participant_id"], "thread_origin": False,
               "event_type": "risk_detected", "severity": s["crisis_severity"], "risk_score": s["crisis_max_risk_score"],
               "trigger_method": "auto", "occurred_at": s["started_at"]} for s in linked if s["crisis_flagged"]]
    adjud = [{**{k: e[k] for k in ["session_pseudo_id", "participant_id", "thread_origin", "event_type", "severity",
                                   "risk_score", "occurred_at"]}, "adjudicator_role": "researcher",
              "verdict": str(rng.choice(["confirmed", "false_positive", "unclear"], p=[0.3, 0.6, 0.1])),
              "adjudicated_at": e["occurred_at"]} for e in crisis if rng.random() < 0.8]
    semantic = [{"participant_id": s["participant_id"], "session_pseudo_id": s["session_pseudo_id"],
                 "n_embedded_turns": s["n_messages"], "mean_adjacent_similarity": f"{rng.uniform(0.4, 0.8):.4f}",
                 "mean_user_adjacent_similarity": f"{rng.uniform(0.3, 0.8):.4f}",
                 "first_last_similarity": f"{rng.uniform(0.1, 0.7):.4f}"} for s in sessions]

    # ---- participants ----
    participants = []
    scr_df = pd.DataFrame(screeners)
    for r in o.participants.itertuples():
        mine = by_pid[r.pid]

        def first_last(scale: str) -> dict:
            g = scr_df[(scr_df.participant_id == pid(r.pid)) & (scr_df.scale == scale)].sort_values("administered_at") if len(scr_df) else scr_df
            if len(g) == 0:
                return {f"{scale}_first": None, f"{scale}_last": None, f"{scale}_delta": None}
            f, la = int(g.iloc[0].score), int(g.iloc[-1].score)
            return {f"{scale}_first": f, f"{scale}_last": la, f"{scale}_delta": la - f if len(g) > 1 else None}

        participants.append(
            {"participant_id": pid(r.pid), "enrolled_month": _iso(base, r.anchor_s)[:7], "memory_enabled": bool(rng.random() < 0.5),
             "study_status": "withdrawn" if r.withdrew else "active", "consent_version_first": "synthetic-1",
             "consent_version_last": "synthetic-1", "n_sessions": len(mine), "n_sessions_ended": len(mine),
             "total_session_minutes": f"{sum(s['_dur'] for s in mine):.1f}", "first_session_at": mine[0]["started_at"],
             "last_session_at": mine[-1]["started_at"], **first_last("phq2"), **first_last("gad2"),
             "n_crisis_events": sum(s["n_crisis_events"] for s in mine), "any_crisis_flagged": any(s["crisis_flagged"] for s in mine)}
        )

    tables = {
        "participants.csv": participants, "sessions.csv": sessions, "screeners.csv": screeners, "moods.csv": moods,
        "feedback.csv": feedback, "evals.csv": evals, "crisis_events.csv": crisis, "human_ratings.csv": ratings,
        "crisis_adjudications.csv": adjud, "surveys.csv": surveys, "surveys_scored.csv": scored,
        "semantic_metrics.csv": semantic, "acoustic_features.csv": [],  # empty until the Phase 2 flag is on
    }
    for name, columns in spec.items():
        (out / name).write_text(to_csv(columns, tables[name]))
    as_of = _iso(base, 28 * DAY + 14 * WEEK)
    (out / "codebook.md").write_text(
        "# SYNTHETIC dataset (generated by analysis/phase2/synth.py; NOT participant data)\n\n"
        f"- generated_at: {as_of}\n"
        f"- as_of (inclusion cutoff, created_at <= as_of): {as_of}\n"
        f"- git_sha: synthetic-seed-{seed}\n\n"
        "Column definitions: see the codebook of a real export, or analysis/expected_schema.json.\n\n"
        f"Simulation parameters: `{json.dumps(p.__dict__, sort_keys=True)}`\n"
    )
    return out


def generate(out_dir: str | Path, seed: int = 20261116, params: SimParams | None = None) -> Outcomes:
    p = params or SimParams()
    o = simulate_outcomes(p, np.random.default_rng([seed, 0]))
    write_export(o, out_dir, seed)
    return o


def main() -> None:
    ap = argparse.ArgumentParser(description="Write a SYNTHETIC export directory in the real export format.")
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=20261116)
    ap.add_argument("--n", type=int, default=120)
    ap.add_argument("--d-change", type=float, default=0.30)
    ap.add_argument("--d-arm", type=float, default=0.0)
    ap.add_argument("--attrition", type=float, default=0.30)
    args = ap.parse_args()
    p = SimParams(n_enrolled=args.n, d_change=args.d_change, d_arm=args.d_arm, attrition=args.attrition)
    generate(args.out, args.seed, p)
    print(f"synthetic export written to {args.out} (seed {args.seed}, params {p})")


if __name__ == "__main__":
    main()
