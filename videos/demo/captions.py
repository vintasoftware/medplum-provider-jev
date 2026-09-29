"""Trim a recorded take to the Guided demo page and burn in its captions (ffmpeg drawtext, one box each).

    python3 videos/demo/captions.py videos/out/demo    # reads raw.webm + events.json, writes guided-demo.mp4
"""
import json
import subprocess
import sys
from pathlib import Path

take = Path(sys.argv[1]).resolve()
t = {e['event']: e['t'] for e in json.loads((take / 'events.json').read_text())}
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

CAPTIONS = [
    (t['open-guided-demo'] + 0.3, t['start-scenario'] - 0.3, 'A test practitioner.\nSynthetic data only.'),
    (t['start-scenario'] + 0.2, t['welcome'] - 0.2, 'Each run creates a new\nsynthetic patient.'),
    (t['checking'], t['review-card'] + 1.5, 'Jev compares the note\nwith the discharge summary.'),
    (t['edit-note'], t['recheck'] - 0.2, 'The provider fixes the plan\nand checks again.'),
]

# Start the video on the loaded Guided demo page; caption times are relative to that.
TRIM = max(0.0, t['open-guided-demo'] - 0.2)
CAPTIONS = [(a - TRIM, b - TRIM, x) for a, b, x in CAPTIONS]
filters = [f'trim=start={TRIM:.2f}', 'setpts=PTS-STARTPTS']
for i, (start, end, text) in enumerate(CAPTIONS):
    path = take / f'caption-{i + 1}.txt'
    path.write_text(text)
    filters.append(
        f"drawtext=fontfile={FONT}:textfile='{path}':fontsize=22:fontcolor=white:line_spacing=7"
        f":box=1:boxcolor=0x181a20@0.86:boxborderw=14:x=78:y=h-th-44"
        f":enable='between(t,{start:.2f},{end:.2f})'"
    )
(take / 'captions.txt').write_text(
    '\n'.join(f'{a:7.2f}-{b:7.2f}  {x.replace(chr(10), " / ")}' for a, b, x in CAPTIONS) + '\n')
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(take / 'raw.webm'),
                '-vf', ','.join(filters), '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(take / 'guided-demo.mp4')], check=True)
print((take / 'captions.txt').read_text())
