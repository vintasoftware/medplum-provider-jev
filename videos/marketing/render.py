"""Render composition.html frame by frame to frames/*.jpg, or preview stills with --preview t1,t2,...

Needs ui.webm (the demo take cut to start 2.4 s before its write-note step) and ui-events.json
(that take's events.json); build.sh prepares both.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
EVENTS = {e['event']: e['t'] for e in json.loads((HERE / 'ui-events.json').read_text())}
CUT = EVENTS['write-note'] - 2.4  # where ui.webm starts in the take (build.sh cuts it there)
# Fixed framing [x, y, w] of the 1600x900 take (no zoom or pan); start times follow the take's steps.
SHOTS = {
    'fix': {'start': EVENTS['edit-note'] + 0.7 - CUT, 'speed': 1.45, 'from': [720, 200, 880], 'to': [720, 200, 880],
            'caption': 'Fix the plan, check again.'},
}

preview = None
if len(sys.argv) > 2 and sys.argv[1] == '--preview':
    preview = [float(x) for x in sys.argv[2].split(',')]

frames = HERE / ('preview' if preview else 'frames')
frames.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    page = browser.new_page(viewport={'width': 1080, 'height': 1080}, device_scale_factor=1)
    page.add_init_script(f'window.SHOTS = {json.dumps(SHOTS)};')
    page.goto((HERE / 'composition.html').as_uri())
    page.evaluate('document.fonts.ready')
    page.wait_for_function("document.querySelector('#ui').readyState >= 2", timeout=30000)
    page.wait_for_timeout(500)
    duration, fps = page.evaluate('[window.DURATION, window.FPS]')
    times = preview if preview else [i / fps for i in range(int(duration * fps))]
    for i, t in enumerate(times):
        page.evaluate(f'window.renderAt({t})')
        name = f't{t:05.2f}.png' if preview else f'{i:05d}.jpg'
        page.screenshot(path=str(frames / name), type='png' if preview else 'jpeg', **({} if preview else {'quality': 93}))
        if not preview and i % 150 == 0:
            print(f'frame {i}/{len(times)}', flush=True)
    browser.close()
print('done', len(times), 'frames in', frames)
