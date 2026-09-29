"""Render the article figures in figures.html to images/<figure id>.png.

    python article/render_figures.py

Needs Playwright (requirements-dev.txt) and ffmpeg, which pulls the poster frame from
videos/out/demo/guided-demo.mp4 (the captioned guided demo recorded by videos/build.sh).
"""
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
IMAGES = HERE / 'images'
DEMO_VIDEO = HERE.parent / 'videos/out/demo/guided-demo.mp4'
POSTER_AT = '72'  # seconds into the demo video: the review card showing the potential conflict

IMAGES.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory() as tmp:
    frame = Path(tmp) / 'frame.png'
    subprocess.run(
        ['ffmpeg', '-loglevel', 'error', '-y', '-ss', POSTER_AT, '-i', str(DEMO_VIDEO),
         '-frames:v', '1', str(frame)],
        check=True,
    )
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1280, 'height': 900}, device_scale_factor=2)
        page.goto((HERE / 'figures.html').as_uri())
        page.evaluate('document.fonts.ready')
        page.evaluate(
            "src => new Promise(r => { const i = document.getElementById('demo-frame'); i.onload = r; i.src = src; })",
            frame.as_uri(),
        )
        for fig in page.query_selector_all('figure'):
            name = fig.get_attribute('id')
            fig.screenshot(path=str(IMAGES / f'{name}.png'), omit_background=True)
            print('wrote', f'images/{name}.png')
        browser.close()
