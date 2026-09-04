#!/bin/bash
# Build the narrated app-tutorial video (v2): title card, per-segment slides
# with a subtle push-in and fade in/out, narration from cached TTS, silent
# outro card. Usage: OPENAI_API_KEY=... ./build-video.sh
set -euo pipefail
cd "$(dirname "$0")"
SHOTS=../tutorial-screenshots
mkdir -p work

python3 - <<'EOF'
import re, pathlib, json, urllib.request, os

script = pathlib.Path('narration-script.md').read_text()
segments = re.findall(r'^\d+\. \[([0-9a-z-]+)\] (.+)$', script, re.M)
assert len(segments) == 12, f'expected 12 segments, got {len(segments)}'
key = os.environ['OPENAI_API_KEY']

for i, (slide, text) in enumerate(segments, 1):
    out = pathlib.Path(f'work/seg{i:02d}.mp3')
    if out.exists() and out.stat().st_size > 0:
        continue
    req = urllib.request.Request(
        'https://api.openai.com/v1/audio/speech',
        data=json.dumps({
            'model': 'gpt-4o-mini-tts',
            'voice': 'sage',
            'input': text,
            'instructions': 'Calm, warm, unhurried narrator for a university research app tutorial. Neutral pacing, friendly but not salesy.',
        }).encode(),
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        out.write_bytes(r.read())
    print(f'seg{i:02d}: TTS generated')

# v2 slide mapping: title card carries the welcome; narration slides follow.
slides = ['title.png'] + [f'../tutorial-screenshots/{s}.png' for s, _ in segments[1:]]
pathlib.Path('work/slides.txt').write_text(
    '\n'.join(f'{i:02d} {p}' for i, p in enumerate(slides, 1)) + '\n')
EOF

: > work/concat.txt
while read -r idx img; do
  aud="work/seg${idx}.mp3"
  part="work/v2part${idx}.mp4"
  dur=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$aud")
  total=$(python3 -c "print(round(float('$dur') + 0.7, 3))")
  fadeout=$(python3 -c "print(round(float('$total') - 0.45, 3))")
  # fit to 1920x1080, upscale, slow push-in (~4%/min), fade edges
  ffmpeg -nostdin -y -loglevel error -loop 1 -i "$img" -i "$aud" \
    -filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x16281e,scale=3840:2160,zoompan=z='1+0.00022*in':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=1920x1080:fps=30,fade=t=in:st=0:d=0.35,fade=t=out:st=${fadeout}:d=0.45,format=yuv420p[v];[1:a]apad=pad_dur=0.7,afade=t=out:st=${fadeout}:d=0.45[a]" \
    -map "[v]" -map "[a]" -t "$total" \
    -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 128k "$part"
  echo "file 'v2part${idx}.mp4'" >> work/concat.txt
  echo "part${idx}: ${total}s"
done < work/slides.txt

# Silent outro card (3s, fade in/out).
ffmpeg -nostdin -y -loglevel error -loop 1 -i outro.png -f lavfi -i anullsrc=r=24000:cl=mono \
  -filter_complex "[0:v]scale=1920:1080,fade=t=in:st=0:d=0.4,fade=t=out:st=2.5:d=0.5,format=yuv420p[v]" \
  -map "[v]" -map 1:a -t 3 -r 30 -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 64k work/v2outro.mp4
echo "file 'v2outro.mp4'" >> work/concat.txt

ffmpeg -nostdin -y -loglevel error -f concat -safe 0 -i work/concat.txt -c copy tutorial-video.mp4
echo "done: $(pwd)/tutorial-video.mp4"
ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 tutorial-video.mp4
