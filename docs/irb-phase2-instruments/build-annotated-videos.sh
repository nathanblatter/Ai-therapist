#!/bin/bash
# Build the narrated tutorial videos (v3): title card, STATIC per-segment
# slides (no zoom) with fade in/out, TTS narration (voice: sage), and timed
# annotation overlays (boxes/arrows) synced to the narration via
# <dir>/<name>-annotations.json.
#
# Usage: OPENAI_API_KEY=... ./build-annotated-videos.sh [participant|researcher|therapist|caseworker ...]
set -euo pipefail
cd "$(dirname "$0")"
ROLES=("${@}")
[ ${#ROLES[@]} -eq 0 ] && ROLES=(participant researcher therapist caseworker)

for role in "${ROLES[@]}"; do
  if [ "$role" = participant ]; then
    DIR=tutorial-video; NARR=$DIR/narration-script.md; WORK=$DIR/work
    OUT=$DIR/tutorial-video.mp4; ANNOS=$DIR/annotations.json
    TTS_STYLE='Calm, warm, unhurried narrator for a university research app tutorial. Neutral pacing, friendly but not salesy.'
  else
    DIR=staff-tutorials; NARR=$DIR/${role}-narration.md; WORK=$DIR/work-${role}
    OUT=$DIR/${role}-tutorial-video.mp4; ANNOS=$DIR/${role}-annotations.json
    TTS_STYLE='Calm, professional narrator for a university research staff tutorial. Neutral pacing.'
  fi
  mkdir -p "$WORK"

  # 1) TTS (cached per segment) + slide list + per-segment narration text files
  ROLE="$role" NARR="$NARR" WORK="$WORK" TTS_STYLE="$TTS_STYLE" python3 - <<'EOF'
import re, pathlib, json, urllib.request, os
role, narr, work = os.environ['ROLE'], os.environ['NARR'], os.environ['WORK']
script = pathlib.Path(narr).read_text()
segments = re.findall(r'^\d+\. \[([0-9a-zA-Z-]+)\] (.+)$', script, re.M)
assert segments, f'no segments in {narr}'
key = os.environ['OPENAI_API_KEY']
for i, (slide, text) in enumerate(segments, 1):
    pathlib.Path(f'{work}/seg{i:02d}.txt').write_text(text)
    out = pathlib.Path(f'{work}/seg{i:02d}.mp3')
    if out.exists() and out.stat().st_size > 0:
        continue
    req = urllib.request.Request(
        'https://api.openai.com/v1/audio/speech',
        data=json.dumps({'model': 'gpt-4o-mini-tts', 'voice': 'sage', 'input': text,
            'instructions': os.environ['TTS_STYLE']}).encode(),
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        out.write_bytes(r.read())
    print(f'{role} seg{i:02d}: TTS ok')
slides = []
for i, (slide, _) in enumerate(segments, 1):
    if role == 'participant':
        path = 'tutorial-video/title.png' if i == 1 else f'tutorial-screenshots/{slide}.png'
    else:
        path = f'staff-tutorials/title-{role}.png' if slide.startswith('title-') else f'tutorial-screenshots/{slide}.png'
    assert pathlib.Path(path).exists(), path
    slides.append(f'{i:02d} {path}')
pathlib.Path(f'{work}/slides.txt').write_text('\n'.join(slides) + '\n')
EOF

  # 2) per-segment encode: static slide + fades + annotation overlays
  : > "$WORK/concat.txt"
  while read -r idx img; do
    aud="$WORK/seg${idx}.mp3"
    part="$WORK/part${idx}.mp4"
    dur=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$aud")
    total=$(python3 -c "print(round(float('$dur') + 0.7, 3))")
    fadeout=$(python3 -c "print(round(float('$total') - 0.45, 3))")

    # annotation overlays for this segment (none for title/outro or unlisted segs)
    olines=""
    if [ -f "$ANNOS" ]; then
      seg_json=$(python3 -c "
import json,sys
a=json.load(open('$ANNOS'))
print(json.dumps(a.get('$((10#$idx))', [])))")
      if [ "$seg_json" != "[]" ]; then
        olines=$(echo "$seg_json" | python3 render_annotations.py "$img" "$dur" "$WORK/seg${idx}.txt" "$WORK/seg${idx}")
      fi
    fi

    inputs=(-loop 1 -i "$img" -i "$aud")
    filter="[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0d1b2e[base0];"
    last="base0"; n=0
    if [ -n "$olines" ]; then
      while read -r opng t0 t1; do
        inputs+=(-loop 1 -i "$opng")
        oidx=$((n+2))
        filter+="[${oidx}:v]format=rgba,fade=t=in:st=${t0}:d=0.3:alpha=1,fade=t=out:st=${t1}:d=0.3:alpha=1[ov${n}];"
        filter+="[${last}][ov${n}]overlay=0:0[base$((n+1))];"
        last="base$((n+1))"; n=$((n+1))
      done <<< "$olines"
    fi
    filter+="[${last}]fade=t=in:st=0:d=0.35,fade=t=out:st=${fadeout}:d=0.45,format=yuv420p[v];"
    filter+="[1:a]apad=pad_dur=0.7,afade=t=out:st=${fadeout}:d=0.45[a]"

    ffmpeg -nostdin -y -loglevel error "${inputs[@]}" \
      -filter_complex "$filter" -map "[v]" -map "[a]" -t "$total" -r 30 \
      -c:v libx264 -preset medium -crf 22 -c:a aac -b:a 128k "$part"
    echo "file 'part${idx}.mp4'" >> "$WORK/concat.txt"
  done < "$WORK/slides.txt"

  # 3) participant outro card
  if [ "$role" = participant ]; then
    ffmpeg -nostdin -y -loglevel error -loop 1 -i "$DIR/outro.png" -f lavfi -i anullsrc=r=24000:cl=mono \
      -filter_complex "[0:v]scale=1920:1080,fade=t=in:st=0:d=0.4,fade=t=out:st=2.5:d=0.5,format=yuv420p[v]" \
      -map "[v]" -map 1:a -t 3 -r 30 -c:v libx264 -preset medium -crf 22 -c:a aac -b:a 64k "$WORK/outro.mp4"
    echo "file 'outro.mp4'" >> "$WORK/concat.txt"
  fi

  ffmpeg -nostdin -y -loglevel error -f concat -safe 0 -i "$WORK/concat.txt" -c copy "$OUT"
  echo "$role: $(ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 "$OUT" | tr '\n' ' ')"
done
