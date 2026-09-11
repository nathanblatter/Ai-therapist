#!/usr/bin/env python3
"""Regenerate the Phase 2 participant consent docx from consent2.html.

The HTML is the single source of truth (it is what gets reviewed and diffed);
this emits the OneAegis submission artifact so the two cannot drift. Mirrors
the formatting of the 09.02.2026v2 docx exactly: everything is the Normal
style, headings are bold paragraphs, list items are "•\\t"-prefixed
paragraphs, and inline <strong> becomes a bold run.

  python3 docs/irb-phase2-instruments/build_consent_doc.py

Output: AI Longitudinal Participant Consent_Main Group_<MM.DD.YYYY>v3.docx
"""
import html as html_mod
import re
import sys
from datetime import date
from pathlib import Path

from docx import Document

HERE = Path(__file__).resolve().parent
SRC = HERE / "consent2.html"
STAMP = date.today().strftime("%m.%d.%Y")
OUT = HERE / f"AI Longitudinal Participant Consent_Main Group_{STAMP}v3.docx"

# Matches the top-level blocks we emit, in document order.
BLOCK_RE = re.compile(
    r"<(h1|h2|p|ul)\b[^>]*>(.*?)</\1>", re.IGNORECASE | re.DOTALL
)
LI_RE = re.compile(r"<li\b[^>]*>(.*?)</li>", re.IGNORECASE | re.DOTALL)
# Split a fragment into (is_bold, text) runs. <strong>/<b> only; everything
# else is stripped to text.
STRONG_RE = re.compile(r"<(strong|b)\b[^>]*>(.*?)</\1>", re.IGNORECASE | re.DOTALL)


BR_SENTINEL = "\x00BR\x00"


def clean(fragment: str) -> str:
    """HTML fragment -> plain text, preserving entities and collapsing space.

    <br> becomes a sentinel rather than a space so add_paragraph can emit a
    real soft line break — the title/PI block on page 1 depends on it.
    """
    text = re.sub(r"<br\s*/?>", BR_SENTINEL, fragment, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_mod.unescape(text)
    text = re.sub(r"[^\S\n]*" + BR_SENTINEL + r"[^\S\n]*", BR_SENTINEL, text)
    return re.sub(r"[ \t\r\n]+", " ", text).replace(BR_SENTINEL, BR_SENTINEL).strip()


def runs_of(fragment: str):
    """Yield (text, bold) pairs so inline <strong> survives into the docx."""
    pos, out = 0, []
    for m in STRONG_RE.finditer(fragment):
        before = clean(fragment[pos:m.start()])
        if before:
            out.append((before, False))
        inner = clean(m.group(2))
        if inner:
            out.append((inner, True))
        pos = m.end()
    tail = clean(fragment[pos:])
    if tail:
        out.append((tail, False))
    # Re-insert the single spaces that clean() ate at run boundaries — but not
    # across a <br>, where the break itself is the separator.
    for i in range(len(out) - 1):
        if out[i][0].endswith(" ") or out[i][0].endswith(BR_SENTINEL):
            continue
        if out[i + 1][0].startswith(BR_SENTINEL):
            continue
        out[i] = (out[i][0] + " ", out[i][1])
    return out


def add_paragraph(doc, fragment, *, bullet=False, all_bold=False):
    para = doc.add_paragraph()
    parts = runs_of(fragment)
    if bullet:
        para.add_run("•\t")
    for text, bold in parts:
        # Split on the <br> sentinel so each segment is its own run with a
        # real soft break between them (python-docx ignores "\n" in run text).
        segments = text.split(BR_SENTINEL)
        for i, segment in enumerate(segments):
            if i:
                para.add_run().add_break()
            if segment:
                run = para.add_run(segment)
                run.bold = bold or all_bold
    return para


def main():
    if not SRC.exists():
        sys.exit(f"missing source: {SRC}")
    html = SRC.read_text(encoding="utf-8")

    doc = Document()
    emitted = 0
    for m in BLOCK_RE.finditer(html):
        tag, body = m.group(1).lower(), m.group(2)
        if tag in ("h1", "h2"):
            add_paragraph(doc, body, all_bold=True)
            emitted += 1
        elif tag == "p":
            if not clean(body):
                continue
            add_paragraph(doc, body)
            emitted += 1
        elif tag == "ul":
            for li in LI_RE.finditer(body):
                add_paragraph(doc, li.group(1), bullet=True)
                emitted += 1

    doc.save(OUT)
    print(f"wrote {OUT.name}  ({emitted} paragraphs)")

    # Sanity-check the pieces that must survive: the new telemetry disclosures.
    text = "\n".join(p.text for p in Document(OUT).paragraphs)
    required = [
        "What the App Records and Analyzes",
        "automatically analyzes every message you send",
        "does not record your keystrokes",
        "kept indefinitely",
        "Mandatory reporting",
        "988",
    ]
    missing = [r for r in required if r not in text]
    if missing:
        sys.exit("MISSING from output: " + "; ".join(missing))
    print("verified: telemetry disclosure, non-collection boundary, "
          "retention, mandatory reporting, crisis resources all present")


if __name__ == "__main__":
    main()
