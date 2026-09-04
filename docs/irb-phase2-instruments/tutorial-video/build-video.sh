#!/bin/bash
# Build the narrated app-tutorial video from screenshots + TTS narration.
# Usage: OPENAI_API_KEY=... ./build-video.sh
# Segments are read from narration-script.md ([NN-slide] lines); audio is
# OpenAI TTS (voice: sage); slides are the tutorial screenshots scaled to
# 1280x1080 with padding; output tutorial-video.mp4 (H.264 + AAC).
set -euo pipefail
cd "$(dirname "$0")"
SHOTS=../tutorial-screenshots
mkdir -p work

python3 - <<'EOF'
import re, pathlib, json, urllib.request, os

script = pathlib.Path('narration-script.md').read_text()
segments = re.findall(r'^\d+\. \[([0-9a-z-]+)\] (.+)$', script, re.M)
assert segments, 'no segments parsed'
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
    print(f'seg{i:02d} {slide}: {out.stat().st_size} bytes')

pathlib.Path('work/segments.txt').write_text(
    '\n'.join(f'{i:02d} {slide}' for i, (slide, _) in enumerate(segments, 1)) + '\n')
EOF

# One video part per segment: still image + narration + 0.6s tail padding.
: > work/concat.txt
while read -r idx slide; do
  img="$SHOTS/${slide}.png"
  aud="work/seg${idx}.mp3"
  part="work/part${idx}.mp4"
  if [ ! -f "$part" ]; then
    ffmpeg -nostdin -y -loglevel error -loop 1 -i "$img" -i "$aud" \
      -vf "scale=1280:1080:force_original_aspect_ratio=decrease,pad=1280:1080:(ow-iw)/2:(oh-ih)/2:color=0x1f3d2b,format=yuv420p" \
      -af "apad=pad_dur=0.6" -shortest -r 30 \
      -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 128k "$part"
  fi
  echo "file 'part${idx}.mp4'" >> work/concat.txt
done < work/segments.txt

ffmpeg -y -loglevel error -f concat -safe 0 -i work/concat.txt -c copy tutorial-video.mp4
echo "done: $(pwd)/tutorial-video.mp4"
ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 tutorial-video.mp4
