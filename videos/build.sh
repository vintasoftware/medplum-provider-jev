#!/usr/bin/env bash
# Build both videos from a fresh recording of the guided demo.
#
#   DEMO_EMAIL=tester@example.com DEMO_PASSWORD=... videos/build.sh
#
# Needs: the project set up per the root README, the dev server running
# (npm --prefix provider run dev), the Python venv with Playwright (.venv), ffmpeg and sox.
# The recording makes real Jev calls and creates one synthetic patient.
#
# Outputs (ignored by Git):
#   videos/out/demo/guided-demo.mp4           the real demo with captions (about 2 min)
#   videos/out/demo/guided-demo-no-captions.mp4
#   videos/out/vinta-jev-medplum-square.mp4   the 1080x1080 marketing video (47 s, sound effects only)
#
# To iterate on the marketing video without re-recording, edit videos/marketing/composition.html
# and run `python videos/marketing/render.py --preview 5,20,36` for still frames, then rerun the
# last two steps below.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DEMO_EMAIL:?set DEMO_EMAIL}" "${DEMO_PASSWORD:?set DEMO_PASSWORD}"
PY=.venv/bin/python
OUT=videos/out/demo

# 1. Record the real demo and burn in its captions.
rm -f "$OUT"/*.webm
$PY videos/demo/record.py "$OUT"
mv "$OUT"/page@*.webm "$OUT/raw.webm"
python3 videos/demo/captions.py "$OUT"
TRIM=$(python3 -c "import json; e={x['event']:x['t'] for x in json.load(open('$OUT/events.json'))}; print(max(0, e['open-guided-demo'] - 0.2))")
ffmpeg -hide_banner -loglevel error -y -i "$OUT/raw.webm" -ss "$TRIM" -c:v libx264 -preset slow -crf 20 \
  -pix_fmt yuv420p -movflags +faststart "$OUT/guided-demo-no-captions.mp4"

# 2. Prepare the marketing composition: the demo take cut for exact per-frame seeking.
cp "$OUT/events.json" videos/marketing/ui-events.json
CUT=$(python3 -c "import json; e={x['event']:x['t'] for x in json.load(open('$OUT/events.json'))}; print(e['write-note'] - 2.4)")
ffmpeg -hide_banner -loglevel error -y -i "$OUT/raw.webm" -ss "$CUT" -t 67 -c:v libvpx -g 1 -b:v 8M -an \
  videos/marketing/ui.webm

# 3. Render frames (same names every run, so they are overwritten), synthesize the effects, and mux.
$PY videos/marketing/render.py
python3 videos/marketing/make_audio.py
ffmpeg -hide_banner -loglevel error -y -framerate 30 -i videos/marketing/frames/%05d.jpg \
  -i videos/marketing/soundtrack.wav -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -shortest -movflags +faststart videos/out/vinta-jev-medplum-square.mp4
ls -la "$OUT"/*.mp4 videos/out/*.mp4
