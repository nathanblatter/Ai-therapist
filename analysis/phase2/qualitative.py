"""PLACEHOLDER HOOK: "AI second coder" qualitative reliability analysis.

NOT IMPLEMENTED ON PURPOSE. See flightdeck item ai-therapist-171.

Planned analysis (protocol: "qualitative thematic analysis of exit interviews
and de-identified transcripts"): a human coder and an AI second coder each
apply the thematic codebook to the same excerpts, and agreement is summarised
with Cohen's kappa per code.

What must be decided by the PI before this can be written (PREREGISTRATION.md,
open decision D9):
  1. The kappa threshold that counts as acceptable agreement. Deliberately
     left as None here: this draft does not propose a number.
  2. The unit of coding (excerpt, turn, or interview) and whether codes are
     mutually exclusive (plain kappa) or multi-label (kappa per code).
  3. What happens below threshold (codebook revision and recode, or human
     double-coding of the full set).
  4. Which model and prompt version act as the second coder, pinned before
     any coding starts.

What the export must provide first (schema gap G10): there is no coding table
in the dataset export. Expected input, one row per (excerpt, coder, code):
    excerpt_id, coder ('human' | 'ai'), code, applied (bool)
"""

from __future__ import annotations

from pathlib import Path

# Set by the PI at ratification. Do not fill in a default.
KAPPA_THRESHOLD: float | None = None

EXPECTED_COLUMNS = ["excerpt_id", "coder", "code", "applied"]


def second_coder_reliability(coding_table: Path | None = None) -> dict:
    """Would return Cohen's kappa per code and the share of codes at or above
    KAPPA_THRESHOLD. Raises until the decisions above are made."""
    raise NotImplementedError(
        "AI second coder reliability analysis is a placeholder (ai-therapist-171): "
        "the kappa threshold, coding unit and input table are not yet defined."
    )
