"""Synthesize the UI sound effects with sox (no third-party audio, no licensing). No music: add it later.

    python3 videos/marketing/make_audio.py    # writes soundtrack.wav; effect times match composition.html
"""
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
A = HERE / 'audio'
A.mkdir(exist_ok=True)
RATE = ['-r', '44100', '-c', '2']
DURATION = 47.0


def sox(*args):
    subprocess.run(['sox', *map(str, args)], check=True)


# Effects.
sox('-n', *RATE, A / 'pop.wav', 'synth', 0.14, 'sine', '420-1350', 'fade', 'p', 0.002, 0.14, 0.12, 'vol', 0.9)
sox('-n', *RATE, A / 'click.wav', 'synth', 0.02, 'pinknoise', 'fade', 0, 0.02, 0.018, 'highpass', 2000, 'vol', 0.5)
sox('-m', A / 'pop.wav', A / 'click.wav', A / 'pop-full.wav', 'reverb', 20)
sparkle = []
for j, n in enumerate(['C6', 'E6', 'G6', 'C7', 'E7']):
    f = A / f'sp{j}.wav'
    sox('-n', *RATE, f, 'synth', 0.09, 'pluck', n, 'fade', 0.002, 0.09, 0.06, 'vol', 0.28)
    sparkle.append(f)
sox(*sparkle, A / 'sparkle.wav', 'reverb', 50)
sox('-n', *RATE, A / 'whoosh.wav', 'synth', 0.45, 'pinknoise', 'band', '-n', '1400', '900',
    'fade', 'h', 0.2, 0.45, 0.25, 'vol', 0.35)

EVENTS = [(3.2, 'whoosh'), (9.0, 'whoosh'), (15.5, 'whoosh'), (16.9, 'sparkle'), (20.1, 'pop-full'),
          (23.0, 'whoosh'), (30.5, 'whoosh'), (35.45, 'pop-full'), (37.5, 'whoosh'), (42.0, 'whoosh')]
layers = []
for i, (t, name) in enumerate(EVENTS):
    f = A / f'ev{i:02d}.wav'
    sox(A / f'{name}.wav', f, 'delay', t, t, 'pad', 0, 1)
    layers.append(f)
# Explicit per-input volume stops sox -m from dividing each layer by the input count.
sox('-m', *[x for f in layers for x in ('-v', 1, f)], A / 'sfx.wav', 'trim', 0, DURATION)

sox(A / 'sfx.wav', HERE / 'soundtrack.wav', 'vol', 1.3, 'pad', 0, DURATION, 'trim', 0, DURATION)
print('soundtrack.wav written')
