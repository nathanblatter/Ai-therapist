"""Load a de-identified dataset export and validate it against the expected schema.

The loader fails loudly (SchemaError) on any structural drift:
  - a missing or unexpected CSV file,
  - a header that differs from expected_schema.json in names OR order,
  - a cell that does not parse as its declared type,
  - a value outside a declared enumeration or range,
  - broken keys (duplicate ids, rows pointing at unknown participants).

Softer findings that a human should look at, but that do not make the data
unusable, are returned as warnings and printed in the report.

Nothing here reads anything but the export directory handed to it.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "expected_schema.json"

_INT = re.compile(r"^-?\d+$")
_FLOAT = re.compile(r"^-?\d+(\.\d+)?$")
_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

# Enumerations for the columns the analysis branches on. Values come from the
# export registry's `values` strings and the migrations they cite. An
# unexpected value is drift: stop and look.
ENUMS: dict[tuple[str, str], set[str]] = {
    ("participants.csv", "study_status"): {"active", "paused", "withdrawn"},
    ("sessions.csv", "proactive_offering"): {"true", "false"},  # empty = not evaluated
    ("sessions.csv", "session_type"): {"realtime", "chat"},
    ("screeners.csv", "scale"): {"phq2", "gad2"},
    # The codebook lists four roles; migration 087 added 'withdrawal' and the
    # export query does not filter it out (see PREREGISTRATION.md, gap G7).
    ("surveys.csv", "survey_role"): {"baseline", "weekly", "exit", "week12", "withdrawal"},
    ("surveys_scored.csv", "survey_role"): {"baseline", "weekly", "exit", "week12", "withdrawal"},
    ("surveys_scored.csv", "weekly_usage"): {"0", "1", "2-3", "4-6", "7 or more"},
    ("moods.csv", "source"): {"checkin", "log_mood"},
    ("crisis_events.csv", "severity"): {"low", "medium", "high"},
    ("crisis_adjudications.csv", "verdict"): {"confirmed", "false_positive", "unclear"},
}

# Inclusive numeric ranges.
RANGES: dict[tuple[str, str], tuple[float, float]] = {
    ("screeners.csv", "score"): (0, 6),
    ("surveys_scored.csv", "phq2"): (0, 6),
    ("surveys_scored.csv", "gad2"): (0, 6),
    ("surveys_scored.csv", "weekly_mood"): (1, 6),
    ("surveys_scored.csv", "weekly_stress"): (1, 5),
    ("surveys_scored.csv", "weekly_helpfulness"): (1, 5),
    ("surveys_scored.csv", "weekly_alliance_task"): (1, 5),
    ("surveys_scored.csv", "weekly_alliance_bond"): (1, 5),
    ("surveys_scored.csv", "weekly_alliance_goal"): (1, 5),
    ("surveys_scored.csv", "weekly_alliance_total"): (1, 5),
    ("moods.csv", "mood"): (1, 10),
    ("feedback.csv", "helpfulness_rating"): (1, 5),
    ("crisis_events.csv", "risk_score"): (0, 100),
}

# Columns that must never be empty.
REQUIRED: dict[str, list[str]] = {
    "participants.csv": ["participant_id", "study_status", "n_sessions"],
    "sessions.csv": ["session_pseudo_id", "started_at", "is_anonymous"],
    "screeners.csv": ["session_pseudo_id", "scale", "score", "administered_at"],
    "surveys.csv": ["participant_id", "survey_role", "recorded_at"],
    "surveys_scored.csv": ["participant_id", "survey_role", "recorded_at"],
}

UNIQUE_KEYS: dict[str, list[str]] = {
    "participants.csv": ["participant_id"],
    "sessions.csv": ["session_pseudo_id"],
}


class SchemaError(Exception):
    """The export does not match the schema this analysis was written against."""


@dataclass
class Export:
    path: Path
    tables: dict[str, pd.DataFrame]
    as_of: str | None
    export_git_sha: str | None
    schema_version: int
    warnings: list[str] = field(default_factory=list)

    def __getitem__(self, name: str) -> pd.DataFrame:
        return self.tables[name if name.endswith(".csv") else f"{name}.csv"]


def expected_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


def _convert(file: str, col: str, typ: str, raw: pd.Series, errors: list[str]) -> pd.Series:
    """Strictly convert one column of raw strings ('' = null) to its declared type."""
    present = raw != ""
    vals = raw[present]

    def bad(mask: pd.Series, what: str) -> None:
        if mask.any():
            sample = vals[mask].head(3).tolist()
            errors.append(f"{file}:{col}: {int(mask.sum())} cell(s) are not {what}, e.g. {sample}")

    if typ == "int":
        ok = vals.str.match(_INT)
        bad(~ok, "integers")
        return pd.to_numeric(raw.where(present & raw.str.match(_INT)), errors="coerce").astype("Int64")
    if typ == "float":
        ok = vals.str.match(_FLOAT)
        bad(~ok, "numbers")
        return pd.to_numeric(raw.where(present & raw.str.match(_FLOAT)), errors="coerce").astype("Float64")
    if typ == "bool":
        ok = vals.isin(["true", "false"])
        bad(~ok, "true/false")
        return raw.map({"true": True, "false": False}).astype("boolean")
    if typ == "timestamp":
        ok = vals.str.match(_TS)
        bad(~ok, "ISO-8601 UTC timestamps (YYYY-MM-DDTHH:MM:SSZ)")
        return pd.to_datetime(raw.where(present & raw.str.match(_TS)), utc=True, format="%Y-%m-%dT%H:%M:%SZ")
    if typ == "json":
        def parse(v: str):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return None

        parsed = vals.map(parse)
        bad(parsed.isna(), "valid JSON")
        out = pd.Series([None] * len(raw), index=raw.index, dtype=object)
        out[present] = parsed
        return out
    if typ == "string":
        return raw.where(present, pd.NA).astype("string")
    errors.append(f"{file}:{col}: unknown declared type {typ!r}")
    return raw


def _read_codebook(path: Path) -> tuple[str | None, str | None]:
    if not path.exists():
        return None, None
    text = path.read_text()
    as_of = re.search(r"^- as_of[^:]*\):\s*(\S+)|^- as_of[^:]*:\s*(\S+)", text, re.M)
    sha = re.search(r"^- git_sha:\s*(\S+)", text, re.M)
    return (as_of.group(1) or as_of.group(2)) if as_of else None, sha.group(1) if sha else None


def load_export(path: str | Path) -> Export:
    """Read every CSV in an unzipped export directory. Raises SchemaError on drift."""
    root = Path(path)
    if not root.is_dir():
        raise SchemaError(f"{root} is not a directory (point at an UNZIPPED dataset export)")
    spec = expected_schema()
    errors: list[str] = []
    warnings: list[str] = []

    found = {p.name for p in root.glob("*.csv")}
    wanted = set(spec["files"])
    for missing in sorted(wanted - found):
        errors.append(f"missing file: {missing}")
    for extra in sorted(found - wanted):
        errors.append(f"unexpected file: {extra} (new export table? run sync_schema and review)")

    tables: dict[str, pd.DataFrame] = {}
    for file, columns in spec["files"].items():
        if file not in found:
            continue
        # dtype=str + keep_default_na=False: every cell arrives exactly as written.
        raw = pd.read_csv(root / file, dtype=str, keep_default_na=False, na_filter=False)
        want = [c["name"] for c in columns]
        got = list(raw.columns)
        if got != want:
            gone = [c for c in want if c not in got]
            new = [c for c in got if c not in want]
            detail = f"missing {gone}, unexpected {new}" if gone or new else "same columns, different order"
            errors.append(f"{file}: header drift ({detail})")
            continue
        df = pd.DataFrame({c["name"]: _convert(file, c["name"], c["type"], raw[c["name"]], errors) for c in columns})

        for col in REQUIRED.get(file, []):
            n = int(df[col].isna().sum())
            if n:
                errors.append(f"{file}:{col}: {n} empty cell(s) in a required column")
        for (f, col), allowed in ENUMS.items():
            if f == file:
                vals = set(df[col].dropna().astype(str).unique())
                if vals - allowed:
                    errors.append(f"{file}:{col}: unexpected value(s) {sorted(vals - allowed)}")
        for (f, col), (lo, hi) in RANGES.items():
            if f == file:
                v = df[col].dropna().astype(float)
                if ((v < lo) | (v > hi)).any():
                    errors.append(f"{file}:{col}: value(s) outside [{lo}, {hi}]")
        key = UNIQUE_KEYS.get(file)
        if key and df.duplicated(key).any():
            errors.append(f"{file}: duplicate {key}")
        tables[file] = df

    if not errors:
        _cross_checks(tables, errors, warnings)
    if errors:
        raise SchemaError(
            "Export does not match analysis/expected_schema.json "
            f"(schema_version {spec['schema_version']}):\n  - " + "\n  - ".join(errors)
        )
    as_of, sha = _read_codebook(root / "codebook.md")
    if as_of is None:
        warnings.append("codebook.md missing or has no as_of line: export provenance cannot be recorded")
    return Export(root, tables, as_of, sha, spec["schema_version"], warnings)


def _cross_checks(t: dict[str, pd.DataFrame], errors: list[str], warnings: list[str]) -> None:
    pids = set(t["participants.csv"]["participant_id"])
    sids = set(t["sessions.csv"]["session_pseudo_id"])

    for file in ["sessions.csv", "screeners.csv", "moods.csv", "feedback.csv"]:
        ref = set(t[file]["participant_id"].dropna())
        if ref - pids:
            errors.append(f"{file}: {len(ref - pids)} participant_id(s) not in participants.csv")
        sref = set(t[file]["session_pseudo_id"].dropna())
        if file != "sessions.csv" and sref - sids:
            errors.append(f"{file}: {len(sref - sids)} session_pseudo_id(s) not in sessions.csv")

    # Survey rows join research_pseudonyms directly, so they can only name
    # pseudonymised participants; anything else means the export logic changed.
    for file in ["surveys.csv", "surveys_scored.csv"]:
        ref = set(t[file]["participant_id"].dropna())
        if ref - pids:
            warnings.append(
                f"{file}: {len(ref - pids)} participant_id(s) have surveys but no participants.csv row "
                "(pseudonym assigned under an earlier as_of?)"
            )

    sc = t["screeners.csv"]
    if len(sc):
        sums = sc["item_scores"].map(lambda v: sum(v) if isinstance(v, list) and all(isinstance(i, int) for i in v) else None)
        if sums.isna().any():
            errors.append("screeners.csv:item_scores: not a JSON array of integers (codebook says it is)")
        elif (sums.astype(int) != sc["score"].astype(int)).any():
            errors.append("screeners.csv: score does not equal the sum of item_scores")
        linked = sc.dropna(subset=["participant_id"]).sort_values(["participant_id", "scale", "administered_at"])
        gap = linked.groupby(["participant_id", "scale"])["administered_at"].diff().dt.total_seconds() / 86400
        if (gap < 7).any():
            warnings.append(
                f"screeners.csv: {int((gap < 7).sum())} administration(s) less than 7 days after the previous one "
                "for the same participant and scale (the app is meant to enforce a 7-day minimum)"
            )
        if sc["participant_id"].isna().any():
            warnings.append(
                f"screeners.csv: {int(sc['participant_id'].isna().sum())} anonymous administration(s); "
                "excluded from every participant-level analysis"
            )

    scored, plain = t["surveys_scored.csv"], t["surveys.csv"]
    if len(scored) != len(plain):
        warnings.append(f"surveys.csv has {len(plain)} rows but surveys_scored.csv has {len(scored)}")
    unscorable = scored[scored["survey_role"].isin(["baseline", "exit", "week12"]) & scored["phq2"].isna()]
    if len(unscorable):
        warnings.append(
            f"surveys_scored.csv: {len(unscorable)} baseline/exit/week12 response(s) have no PHQ-2 score "
            "(skipped items, or a Qualtrics QID remap: verify qualtricsScoring.service.ts)"
        )
    weekly = scored[scored["survey_role"] == "weekly"]
    if len(weekly) and weekly["weekly_alliance_total"].isna().all():
        warnings.append(
            "surveys_scored.csv: every weekly response has an empty WAI-SR total "
            "(the scorer returns empty when the alliance matrix QID is stale)"
        )
