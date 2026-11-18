#!/usr/bin/env python3
"""Convert prompts.html into the IRB "AI Model System Prompts (Verbatim)" docx.

prompts.html is the source of truth. It is generated from the application
code by `npm run irb:prompts` (src/server/irb/promptsAttachment.ts), and
`npm test` fails when it is out of date, so the prompt text cannot drift from
the code silently. This script only re-lays that HTML out as a Word document
for upload; it never edits prompt text.

Usage: python3 docs/irb-phase2-instruments/build_prompts_doc.py
Writes AI_Model_System_Prompts_Verbatim_<MM.DD.YYYY>.docx next to this script,
dated from the "Prepared:" line of prompts.html. Requires python-docx.
"""
import html
import os
import re
from datetime import datetime

from docx import Document
from docx.shared import Inches, Pt, RGBColor

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "prompts.html")

with open(SRC, encoding="utf-8") as f:
    body = f.read().split("<body>", 1)[1].rsplit("</body>", 1)[0]

TOKEN = re.compile(
    r"<h(?P<lvl>[1-4])>(?P<h>.*?)</h[1-4]>"
    r"|<p class=\"note\">(?P<note>.*?)</p>"
    r"|<p>(?P<p>.*?)</p>"
    r"|<pre>(?P<pre>.*?)</pre>"
    r"|<table>(?P<table>.*?)</table>",
    re.S,
)

prepared = re.search(r"<b>Prepared:</b> ([A-Za-z]+ \d{1,2}, \d{4})", body)
if not prepared:
    raise SystemExit("prompts.html has no 'Prepared:' date")
stamp = datetime.strptime(prepared.group(1), "%B %d, %Y").strftime("%m.%d.%Y")
OUT = os.path.join(HERE, f"AI_Model_System_Prompts_Verbatim_{stamp}.docx")

doc = Document()
normal = doc.styles["Normal"]
normal.font.name = "Calibri"
normal.font.size = Pt(10.5)

for m in TOKEN.finditer(body):
    if m.group("h") is not None:
        level = int(m.group("lvl")) - 1  # h1 -> title (0), h2 -> 1, ...
        doc.add_heading(html.unescape(m.group("h")), level=level)
    elif m.group("note") is not None:
        r = doc.add_paragraph().add_run(html.unescape(m.group("note")))
        r.italic = True
        r.font.size = Pt(9.5)
    elif m.group("p") is not None:
        text = m.group("p")
        if "<b>" in text:  # the metadata block: "<b>Key:</b> value<br>"
            for line in text.split("<br>"):
                key, _, rest = line.strip().partition("</b> ")
                p = doc.add_paragraph()
                p.add_run(html.unescape(key.replace("<b>", ""))).bold = True
                p.add_run(" " + html.unescape(rest))
                p.paragraph_format.space_after = Pt(2)
        else:
            doc.add_paragraph(html.unescape(text))
    elif m.group("pre") is not None:
        for line in html.unescape(m.group("pre")).split("\n"):
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.left_indent = Inches(0.25)
            r = p.add_run(line if line else " ")
            r.font.name = "Consolas"
            r.font.size = Pt(8.5)
            r.font.color.rgb = RGBColor(0x33, 0x33, 0x33)
        doc.add_paragraph().paragraph_format.space_after = Pt(4)
    elif m.group("table") is not None:
        rows = re.findall(r"<tr>(.*?)</tr>", m.group("table"), re.S)
        t = doc.add_table(rows=0, cols=2)
        t.style = "Table Grid"
        for i, row in enumerate(rows):
            cells_src = re.findall(r"<t[hd]>(.*?)</t[hd]>", row, re.S)
            cells = t.add_row().cells
            for j, val in enumerate(cells_src):
                cells[j].text = html.unescape(val)
                if i == 0:
                    for r in cells[j].paragraphs[0].runs:
                        r.bold = True

doc.save(OUT)
print(f"wrote {OUT}")
