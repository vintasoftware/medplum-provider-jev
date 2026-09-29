# Videos

Two videos are built from one fresh recording of the guided demo:

- [Guided demo](https://github.com/user-attachments/assets/ce413f25-983d-4384-9b5a-30054e6a4ebd): the real app with captions, about two minutes.
- [Marketing cut](https://github.com/user-attachments/assets/2b8a33b3-a247-4fbf-ad4f-538a8b152da4): 1080x1080, 47 s, sound effects only.

## Build

You need the project set up as in the [root README](../README.md), ffmpeg, sox, and a practitioner login in the demo project (the `--email` invite from setup works). From the repository root:

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/playwright install chromium
npm --prefix provider run dev    # in another terminal
DEMO_EMAIL=you+tester@example.com DEMO_PASSWORD=... videos/build.sh
```

The recording makes real Jev calls and creates one synthetic patient. Outputs go to `videos/out/`, which Git ignores:

| File | Video |
| --- | --- |
| `videos/out/demo/guided-demo.mp4` | Guided demo with captions |
| `videos/out/demo/guided-demo-no-captions.mp4` | Same take without captions |
| `videos/out/vinta-jev-medplum-square.mp4` | Marketing cut |

## How it works

| Path | Role |
| --- | --- |
| `build.sh` | Runs every step below in order |
| `demo/record.py` | Signs in off camera, then follows the tutorial with a visible cursor and reading pauses. Writes the raw `.webm` and `events.json` (a timestamp per step) |
| `demo/captions.py` | Trims the take to the Guided demo page and burns in captions timed from `events.json` |
| `marketing/composition.html` | The marketing video as one HTML page: redrawn app UI, titles and the demo take, seeked to each frame |
| `marketing/render.py` | Screenshots `composition.html` frame by frame. `--preview 5,20,36` renders stills at those seconds instead |
| `marketing/make_audio.py` | Synthesizes the sound effects with sox, timed to `composition.html` |
| `marketing/assets/` | Vinta, TypeSafe and Medplum logos, trademarks of their owners |

To iterate on the marketing video without recording again, edit `marketing/composition.html`, check stills with `.venv/bin/python videos/marketing/render.py --preview 5,20,36`, then rerun step 3 of `build.sh`.

The article's poster frame comes from `videos/out/demo/guided-demo.mp4`: after a new build, run `python article/render_figures.py` to render the figures again.

`demo/captions.py` uses the DejaVu Sans font at its Linux path; change `FONT` there on other systems.
