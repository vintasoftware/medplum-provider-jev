"""Record the guided demo as a real user would: follow the tutorial with a visible cursor and reading pauses.

Signs in off camera with DEMO_EMAIL / DEMO_PASSWORD (a practitioner in the demo project), then records
from the Guided demo page. Needs the dev server on http://localhost:3001 and makes real Jev calls.
Writes a .webm and events.json (a timestamp per step) to the directory given as argv[1]:

    DEMO_EMAIL=... DEMO_PASSWORD=... .venv/bin/python videos/demo/record.py videos/out/demo
"""
import json
import math
import os
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
APP = 'http://localhost:3001'
W, H = 1600, 900

# The notes come from the scenario file, as the e2e tests read them, so the take always types the
# text the app and the Bot were tested with (and never a hardcoded date).
SCENARIO = json.loads((Path(__file__).resolve().parents[2] / 'provider/src/data/guided-scenario.json').read_text())
NOTES = {v['id']: v['note'] for v in SCENARIO['variants']}
NOTE_1 = NOTES['shortcut-from-chart']
NOTE_2 = NOTES['resolved-after-edit']

CURSOR = """
(() => {
  const install = () => {
    if (document.getElementById('demo-cursor')) return;
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 14.8 L11.6 21.5 L14.3 20.3 L11.2 13.7 L17.5 13.2 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, {position: 'fixed', left: '0px', top: '0px', zIndex: '2147483647', pointerEvents: 'none',
      transform: 'translate(-3px,-2px)', transition: 'transform 80ms', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))'});
    document.documentElement.appendChild(c);
    const ring = document.createElement('div');
    ring.id = 'demo-ring';
    Object.assign(ring.style, {position: 'fixed', width: '34px', height: '34px', marginLeft: '-17px', marginTop: '-17px',
      borderRadius: '50%', border: '3px solid rgba(34,139,230,.8)', zIndex: '2147483646', pointerEvents: 'none', opacity: '0',
      transition: 'opacity 350ms, transform 350ms', transform: 'scale(.4)'});
    document.documentElement.appendChild(ring);
    window.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    window.addEventListener('mousedown', (e) => {
      ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px';
      ring.style.transition = 'none'; ring.style.opacity = '1'; ring.style.transform = 'scale(.4)';
      requestAnimationFrame(() => { ring.style.transition = 'opacity 450ms, transform 450ms'; ring.style.opacity = '0'; ring.style.transform = 'scale(1.3)'; });
      c.style.transform = 'translate(-3px,-2px) scale(.85)';
    }, true);
    window.addEventListener('mouseup', () => { c.style.transform = 'translate(-3px,-2px)'; }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();
"""



LINE_RECTS = """
(el) => {
  const range = document.createRange();
  range.selectNodeContents(el);
  const lines = [];
  for (const r of range.getClientRects()) {
    if (r.width < 4 || r.height < 4) continue;
    const line = lines.find((l) => Math.abs(l.bottom - r.bottom) < 4);
    if (line) { line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right); }
    else lines.push({left: r.left, right: r.right, bottom: r.bottom});
  }
  return lines.sort((a, b) => a.bottom - b.bottom);
}
"""
BELOW = 5  # px under the text line, so the cursor never covers the words being read


class Director:
    def __init__(self, page):
        self.page = page
        self.x, self.y = W / 2, H / 2
        self.t0 = time.monotonic()
        self.events = []

    def mark(self, name):
        self.events.append({'t': round(time.monotonic() - self.t0, 2), 'event': name})
        print(f'{self.events[-1]["t"]:7.2f}s  {name}', flush=True)

    def move(self, x, y):
        dist = math.hypot(x - self.x, y - self.y)
        steps = max(8, min(45, int(dist / 14)))
        self.page.mouse.move(x, y, steps=steps)
        self.x, self.y = x, y

    def to(self, locator, fx=0.5, fy=0.5, dx=0, dy=0):
        locator.scroll_into_view_if_needed()
        box = locator.bounding_box()
        self.move(box['x'] + box['width'] * fx + dx, box['y'] + box['height'] * fy + dy)
        return box

    def click(self, locator, fx=0.5, fy=0.5):
        self.to(locator, fx, fy)
        time.sleep(0.25)
        self.page.mouse.down()
        self.page.mouse.up()

    def under(self, locator, fx=0.5):
        """Point just below an element, not over its text."""
        locator.scroll_into_view_if_needed()
        box = locator.bounding_box()
        self.move(box['x'] + box['width'] * fx, box['y'] + box['height'] + BELOW)

    def trace_lines(self, lines, dx=0, dy=0, max_lines=4):
        """Follow text lines left to right, just under each line."""
        for line in lines[:max_lines]:
            y = line['bottom'] + dy + BELOW
            self.move(line['left'] + dx + 4, y)
            self.move(line['right'] + dx - 4, y)

    def read(self, text_or_seconds, locator=None):
        """Pause as a reader would: ~4 words/s, 1.2 s to 5 s. Optionally trace under the text."""
        seconds = text_or_seconds if isinstance(text_or_seconds, (int, float)) else \
            min(5.0, max(1.2, len(str(text_or_seconds).split()) / 4))
        start = time.monotonic()
        if locator is not None:
            locator.scroll_into_view_if_needed()
            self.trace_lines(locator.evaluate(LINE_RECTS))
        time.sleep(max(0, seconds - (time.monotonic() - start)))

    def type(self, text, delay):
        self.page.keyboard.type(text, delay=delay)


def popover(page):
    return page.locator('.driver-popover')


def next_button(page):
    return popover(page).get_by_role('button', name=re.compile('^(Next|Done)$'))


with sync_playwright() as p:
    browser = p.chromium.launch()
    # Sign in off camera, then record with the saved session.
    login = browser.new_context(viewport={'width': W, 'height': H}, locale='en-US')
    lp = login.new_page()
    lp.goto(f'{APP}/signin')
    lp.locator('input[name=email]').fill(os.environ['DEMO_EMAIL'])
    lp.get_by_role('button', name='Continue').click()
    lp.locator('input[name=password]').fill(os.environ['DEMO_PASSWORD'])
    lp.locator('button[type=submit]').click()
    lp.wait_for_url('**/getstarted')
    lp.wait_for_timeout(1500)
    state = login.storage_state()
    login.close()

    context = browser.new_context(viewport={'width': W, 'height': H}, locale='en-US', storage_state=state,
                                  record_video_dir=str(OUT), record_video_size={'width': W, 'height': H})
    context.add_init_script(CURSOR)
    page = context.new_page()
    page.set_default_timeout(30000)
    d = Director(page)
    try:
        page.goto(f'{APP}/guided-demo')
        start = page.get_by_role('button', name='Start scenario')
        expect(start).to_be_visible()
        page.wait_for_timeout(600)
        d.mark('open-guided-demo')
        intro = page.locator('p').filter(has_text='You play a primary care provider').first
        d.read(intro.inner_text(), intro)
        d.mark('start-scenario')
        d.click(start)

        # 1 Welcome.
        expect(popover(page)).to_contain_text('Post-discharge follow-up', timeout=60000)
        d.mark('welcome')
        desc = popover(page).locator('.driver-popover-description')
        d.read(desc.inner_text(), desc)
        d.click(next_button(page))

        # 2 What the chart says.
        expect(popover(page)).to_contain_text('lisinopril 10 mg')
        d.mark('chart-medication')
        med = page.get_by_text('lisinopril 10 MG Oral Tablet').first
        d.under(med, 0.3)
        d.read(2.5)
        d.read(1.5, popover(page).locator('.driver-popover-description'))
        d.click(next_button(page))

        # 3 Open Documents.
        expect(popover(page)).to_contain_text('Open Documents')
        d.read(1.2)
        d.click(page.locator('.pill-tabs a[href$="/DocumentReference"]'))

        # 4 Read the discharge summary.
        expect(popover(page)).to_contain_text('comes from another organization')
        d.mark('discharge-summary')
        d.read(popover(page).locator('.driver-popover-description').inner_text())
        frame_el = page.locator('[data-tour="document-detail"] iframe').first
        expect(frame_el).to_be_visible()
        box = frame_el.bounding_box()
        frame = frame_el.element_handle().content_frame()
        frame.wait_for_selector('body')
        # Trace under the summary's lines; the medication change is on lines 2 and 3.
        lines = frame.locator('pre, body').first.evaluate(LINE_RECTS)
        for line in lines[:4]:
            d.trace_lines([line], dx=box['x'], dy=box['y'], max_lines=1)
            time.sleep(0.7)
        d.read(1.5)
        d.click(next_button(page))

        # 5 Open today's visit.
        expect(popover(page)).to_contain_text('Go to Visits')
        d.read(1.2)
        d.click(page.locator('.pill-tabs a[href$="/Encounter"]'))

        # 6 Start the visit.
        expect(popover(page)).to_contain_text('Set the visit to In Progress')
        d.mark('start-visit')
        d.read(1.2)
        d.click(page.locator('[data-tour="visit-status"]'))
        d.click(page.get_by_role('menuitem', name='In Progress'))

        # 7 Write the note, taking the plan from the chart's list.
        expect(popover(page)).to_contain_text('Write the visit note')
        d.mark('write-note')
        d.read(popover(page).locator('.driver-popover-description').inner_text())
        note = page.get_by_label('Chart note')
        d.click(note, 0.05, 0.3)
        d.type(NOTE_1, 32)
        expect(next_button(page)).to_be_enabled(timeout=20000)
        d.read(1.5)
        d.click(next_button(page))

        # 8 Finish the visit: the note is checked automatically.
        expect(popover(page)).to_contain_text('Set the visit to Finished')
        d.mark('finish-visit')
        d.read(1.5)
        d.click(page.locator('[data-tour="visit-status"]'))
        d.click(page.get_by_role('menuitem', name='Finished'))
        d.mark('checking')
        checking = page.locator('[data-tour="review-card"]')
        expect(checking).to_be_visible()
        d.under(checking.get_by_text('Checking the note'), 0.3)

        # 9 What the check found.
        expect(popover(page)).to_contain_text('What the check found', timeout=90000)
        d.mark('review-card')
        card = page.locator('[data-tour="review-card"]')
        d.under(card.locator('.mantine-Badge-label').first)
        d.read(1.8)
        summary = card.locator('p').filter(has_text='disagree about').first
        d.read(summary.inner_text(), summary)
        marks = card.locator('mark')
        d.read(2.5, marks.first)
        d.read(2.0, marks.last)
        d.click(card.get_by_role('button', name='Details'))
        d.mark('details')
        table = card.locator('table')
        expect(table).to_be_visible()
        d.under(table.locator('tr').filter(has_text='Potential conflict').locator('td').last, 0.5)
        d.read(2.5)
        d.click(next_button(page))

        # 10 Handle it: edit the note.
        expect(popover(page)).to_contain_text('Choose how to handle it')
        d.mark('handle')
        actions = page.locator('[data-tour="review-actions"]')
        d.read(popover(page).locator('.driver-popover-description').inner_text(),
               popover(page).locator('.driver-popover-description'))
        for name in ('Edit note', 'Sign with a documented reason', 'Create reconciliation task'):
            d.under(actions.get_by_role('button', name=name))
            d.read(0.9)
        d.click(page.get_by_role('button', name='Edit note'))
        d.mark('edit-note')
        page.keyboard.press('Control+a')
        time.sleep(0.4)
        d.type(NOTE_2, 22)

        # 11 Check again.
        expect(popover(page)).to_contain_text('Run Check note again', timeout=20000)
        d.mark('recheck')
        d.read(1.5)
        d.click(page.locator('[data-tour="check-note"]'))
        agreement = page.locator('[data-tour="review-card"] .mantine-Badge-label', has_text='Agreement')
        expect(agreement).to_be_visible(timeout=90000)
        d.mark('agreement')
        d.under(agreement)
        d.read(1.8)
        agree_text = card.locator('p').filter(has_text='agree about').first
        d.read(agree_text.inner_text(), agree_text)
        d.read(1.8, card.locator('mark').last)

        # 12 Sign and lock.
        expect(popover(page)).to_contain_text('Sign and lock the note', timeout=20000)
        d.mark('sign')
        d.read(1.2)
        d.click(page.locator('[data-tour="visit-sign"]'))
        lock = page.get_by_role('button', name='Sign & Lock Note')
        expect(lock).to_be_visible()
        d.read(1.2)
        d.click(lock)
        expect(page.get_by_text(re.compile('Signed and Locked by'))).to_be_visible()

        # 13 Done.
        expect(popover(page)).to_contain_text('The visit now shows your signature', timeout=20000)
        d.mark('done')
        desc = popover(page).locator('.driver-popover-description')
        d.read(desc.inner_text(), desc)
        d.click(next_button(page))
        d.mark('signed')
        d.under(page.locator('text=Signed and Locked by').first, 0.3)
        d.read(2.5)
        final_card = page.locator('[data-tour="review-card"]')
        final_card.scroll_into_view_if_needed()
        d.under(final_card.locator('.mantine-Badge-label').first)
        d.read(2.0)
        advisory = final_card.get_by_text('Advisory only')
        d.read(advisory.inner_text(), advisory)
        d.mark('end')
        time.sleep(1.0)
    except Exception as err:
        d.mark(f'FAILED: {type(err).__name__}: {str(err)[:300]}')
        page.screenshot(path=str(OUT / 'failure.png'))
    finally:
        context.close()
        browser.close()
        (OUT / 'events.json').write_text(json.dumps(d.events, indent=2))
    for v in OUT.glob('*.webm'):
        print('video:', v)
