#!/usr/bin/env python3
"""Preview: composite every annotated segment's overlays onto its slide.

Usage: preview_annotations.py <annotations.json> <narration.md> <out.png> [participant]
Produces a vertical montage (one row per annotated segment, 900px wide).
"""
import json
import re
import subprocess
import sys
import pathlib
import tempfile

from PIL import Image, ImageDraw

annos_path, narr_path, out_path = sys.argv[1:4]
participant = len(sys.argv) > 4
annos = json.load(open(annos_path))
script = pathlib.Path(narr_path).read_text()
segments = re.findall(r"^\d+\. \[([0-9a-zA-Z-]+)\] (.+)$", script, re.M)

rows = []
for key in sorted(annos, key=int):
    i = int(key)
    slide, text = segments[i - 1]
    img_path = f"tutorial-screenshots/{slide}.png"
    with tempfile.TemporaryDirectory() as td:
        tf = pathlib.Path(td) / "n.txt"
        tf.write_text(text)
        out = subprocess.run(
            [sys.executable, "render_annotations.py", img_path, "30", str(tf), f"{td}/seg"],
            input=json.dumps(annos[key]), capture_output=True, text=True, check=True)
        base = Image.open(img_path).convert("RGBA")
        iw, ih = base.size
        s = min(1920 / iw, 1080 / ih)
        canvas = Image.new("RGBA", (1920, 1080), (13, 27, 46, 255))
        scaled = base.resize((round(iw * s), round(ih * s)))
        canvas.paste(scaled, (round((1920 - scaled.width) / 2), round((1080 - scaled.height) / 2)))
        for line in out.stdout.strip().splitlines():
            png = line.split()[0]
            canvas = Image.alpha_composite(canvas, Image.open(png))
        d = ImageDraw.Draw(canvas)
        d.text((12, 8), f"seg {i} [{slide}]", fill=(255, 255, 0, 255))
        rows.append(canvas.resize((900, 506)))

m = Image.new("RGBA", (900, 510 * len(rows)), (0, 0, 0, 255))
for n, r in enumerate(rows):
    m.paste(r, (0, n * 510))
m.convert("RGB").save(out_path)
print(f"{out_path}: {len(rows)} segments")
