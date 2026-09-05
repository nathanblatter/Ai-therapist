#!/bin/bash
# Build the three staff tutorial videos (researcher/therapist/caseworker) in
# the same style as the participant tour: title card, per-segment slides with
# a subtle push-in and fades, TTS narration (voice: sage), silent outro.
# Usage: OPENAI_API_KEY=... ./build-staff-videos.sh [role ...]
set -euo pipefail
cd "$(dirname "$0")"
SHOTS=../tutorial-screenshots
ROLES=("${@:-researcher therapist caseworker}")
[ $# -eq 0 ] && ROLES=(researcher therapist caseworker)

# Title cards (rendered once, headless Chrome)
for role in "${ROLES[@]}"; do
  if [ ! -f "title-${role}.png" ]; then
    cat > "/tmp/title-${role}.html" <<EOF
<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;width:1920px;height:1080px;display:flex;align-items:center;justify-content:center;background:#12233b;font-family:-apple-system,'Segoe UI',sans-serif}
.wrap{text-align:center;color:#fff}
h1{font-size:78px;margin:0 0 18px;font-weight:700;letter-spacing:-1px}
h2{font-size:42px;margin:0 0 46px;font-weight:400;color:#c9d8ea;text-transform:capitalize}
p{font-size:26px;color:#93a9c4;margin:0}
</style></head><body><div class="wrap">
<h1>Research Portal</h1><h2>${role} guide</h2>
<p>AI Support Agent Longitudinal Study &middot; Brigham Young University</p>
</div></body></html>
EOF
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
      --user-data-dir=/tmp/chrome-title-$role --no-first-run --window-size=1920,1080 \
      --screenshot="$(pwd)/title-${role}.png" "file:///tmp/title-${role}.html" >/dev/null 2>&1 || true
    sleep 2
    [ -f "title-${role}.png" ] || { echo "title card failed for $role"; exit 1; }
  fi
done

for role in "${ROLES[@]}"; do
  mkdir -p "work-${role}"
  ROLE="$role" python3 - <<'EOF'
import re, pathlib, json, urllib.request, os
role = os.environ['ROLE']
script = pathlib.Path(f'{role}-narration.md').read_text()
segments = re.findall(r'^\d+\. \[([0-9a-zA-Z-]+)\] (.+)$', script, re.M)
assert segments, f'no segments in {role}-narration.md'
key = os.environ['OPENAI_API_KEY']
for i, (slide, text) in enumerate(segments, 1):
    out = pathlib.Path(f'work-{role}/seg{i:02d}.mp3')
    if out.exists() and out.stat().st_size > 0:
        continue
    req = urllib.request.Request(
        'https://api.openai.com/v1/audio/speech',
        data=json.dumps({'model': 'gpt-4o-mini-tts', 'voice': 'sage', 'input': text,
            'instructions': 'Calm, professional narrator for a university research staff tutorial. Neutral pacing.'}).encode(),
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        out.write_bytes(r.read())
    print(f'{role} seg{i:02d}: TTS ok')
slides = []
for i, (slide, _) in enumerate(segments, 1):
    path = f'title-{role}.png' if slide.startswith('title-') else f'../tutorial-screenshots/{slide}.png'
    assert pathlib.Path(path).exists(), path
    slides.append(f'{i:02d} {path}')
pathlib.Path(f'work-{role}/slides.txt').write_text('\n'.join(slides) + '\n')
EOF

  : > "work-${role}/concat.txt"
  while read -r idx img; do
    aud="work-${role}/seg${idx}.mp3"
    part="work-${role}/part${idx}.mp4"
    dur=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$aud")
    total=$(python3 -c "print(round(float('$dur') + 0.7, 3))")
    fadeout=$(python3 -c "print(round(float('$total') - 0.45, 3))")
    ffmpeg -nostdin -y -loglevel error -loop 1 -i "$img" -i "$aud" \
      -filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0d1b2e,scale=3840:2160,zoompan=z='1+0.00022*in':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=1920x1080:fps=30,fade=t=in:st=0:d=0.35,fade=t=out:st=${fadeout}:d=0.45,format=yuv420p[v];[1:a]apad=pad_dur=0.7,afade=t=out:st=${fadeout}:d=0.45[a]" \
      -map "[v]" -map "[a]" -t "$total" \
      -c:v libx264 -preset medium -crf 25 -c:a aac -b:a 128k "$part"
    echo "file 'part${idx}.mp4'" >> "work-${role}/concat.txt"
  done < "work-${role}/slides.txt"

  ffmpeg -nostdin -y -loglevel error -f concat -safe 0 -i "work-${role}/concat.txt" -c copy "${role}-tutorial-video.mp4"
  echo "${role}: $(ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 ${role}-tutorial-video.mp4 | tr '\n' ' ')"
done
