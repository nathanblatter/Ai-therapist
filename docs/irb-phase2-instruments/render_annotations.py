#!/usr/bin/env python3
"""Render annotation overlay PNGs for one tutorial-video segment.

Usage: render_annotations.py <slide.png> <duration_s> <narration_text_file> <out_prefix> < annotations.json

stdin: JSON array of annotations for this segment:
  {"phrase": "substring of narration used for timing",
   "rect": [x, y, w, h],          # in slide-image pixel coordinates
   "shape": "box" | "arrow",
   "hold": seconds (optional — force display length)}

Prints one line per annotation: <overlay.png> <t_in> <t_out>
Overlay canvases are 1920x1080 and already account for the scale+pad the
video pipeline applies to the slide (fit inside 1920x1080, centered).
"""
import json
import math
import pathlib
import sys

from PIL import Image, ImageDraw

ACCENT = (228, 87, 46, 255)      # orange-red
HALO = (255, 255, 255, 220)

slide_path, dur_s, narr_path, out_prefix = sys.argv[1:5]
dur = float(dur_s)
narration = pathlib.Path(narr_path).read_text()
annos = json.load(sys.stdin)

img = Image.open(slide_path)
iw, ih = img.size
scale = min(1920 / iw, 1080 / ih)
ox = (1920 - iw * scale) / 2
oy = (1080 - ih * scale) / 2


def to_canvas(x, y):
    return (ox + x * scale, oy + y * scale)


def rounded_box(d, x0, y0, x1, y1, width, color):
    d.rounded_rectangle([x0, y0, x1, y1], radius=12, outline=color, width=width)


def draw_arrow(d, tip, tail, width, color):
    dx, dy = tip[0] - tail[0], tip[1] - tail[1]
    length = math.hypot(dx, dy) or 1
    ux, uy = dx / length, dy / length
    head_len, head_w = 34, 26
    base = (tip[0] - ux * head_len, tip[1] - uy * head_len)
    px, py = -uy, ux
    p1 = (base[0] + px * head_w / 2, base[1] + py * head_w / 2)
    p2 = (base[0] - px * head_w / 2, base[1] - py * head_w / 2)
    d.line([tail, base], fill=color, width=width)
    d.polygon([tip, p1, p2], fill=color)


# --- timing: proportional position of the phrase within the narration text
total = max(len(narration), 1)
events = []
for a in annos:
    phrase = a.get("phrase", "")
    idx = narration.find(phrase) if phrase else 0
    if idx < 0:
        print(f"WARN phrase not found: {phrase!r}", file=sys.stderr)
        idx = 0
    frac = idx / total
    t0 = 0.25 + frac * max(dur - 0.8, 0.1)
    events.append((t0, a))
events.sort(key=lambda e: e[0])

lines = []
for n, (t0, a) in enumerate(events):
    if "hold" in a:
        t1 = min(t0 + float(a["hold"]), dur - 0.3)
    elif n + 1 < len(events):
        t1 = events[n + 1][0] - 0.2
    else:
        t1 = dur - 0.35
    t1 = max(t1, t0 + 1.2)

    ov = Image.new("RGBA", (1920, 1080), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    x, y, w, h = a["rect"]
    x0, y0 = to_canvas(x - 6, y - 6)
    x1, y1 = to_canvas(x + w + 6, y + h + 6)
    if a.get("shape", "box") == "box":
        rounded_box(d, x0 - 2, y0 - 2, x1 + 2, y1 + 2, 9, HALO)
        rounded_box(d, x0, y0, x1, y1, 5, ACCENT)
    else:  # arrow
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        from_right = cx < 1400
        from_below = cy < 800
        tail = (cx + (240 if from_right else -240), cy + (170 if from_below else -170))
        # tip lands just outside the rect toward the tail
        tip = (cx + (x1 - x0) / 2 * (0.35 if from_right else -0.35),
               (y1 + 10) if from_below else (y0 - 10))
        # keep tail on canvas
        tail = (min(max(tail[0], 20), 1900), min(max(tail[1], 20), 1060))
        draw_arrow(d, tip, tail, 14, HALO)
        draw_arrow(d, tip, tail, 8, ACCENT)

    out = f"{out_prefix}_a{n}.png"
    ov.save(out)
    lines.append(f"{out} {t0:.2f} {t1:.2f}")

print("\n".join(lines))
