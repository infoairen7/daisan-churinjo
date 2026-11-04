#!/usr/bin/env python3
"""PV editor (Ver.2): cuts the captured shots into a ~50 s trailer, grades them, lays captions/UI/flashes on top,
mixes the soundtrack from the game's own sounds and music, and encodes an MP4 for X.

  python3 tools/trailer_edit.py <trailerDir> <out.mp4> [--preview sheet.jpg] [--lang ja|en]

<trailerDir> holds frames/<shot>/NNNN.jpg + meta.json (tools/trailer_capture.mjs) and title/ (tools/trailer_title.mjs).
"""
import json, os, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FPS, W, H, SR = 30, 1920, 1080, 48000
ROOT, OUT = sys.argv[1], sys.argv[2]
PREVIEW = sys.argv[sys.argv.index('--preview') + 1] if '--preview' in sys.argv else None
ASSETS = 'public/assets'
SERIF = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc'
SANS = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
rng = np.random.default_rng(7)

# ------------------------------------------------------------------ footage helpers
_meta = {}
def meta(shot):
    if shot not in _meta:
        _meta[shot] = json.load(open(f'{ROOT}/frames/{shot}/meta.json'))
    return _meta[shot]

def nframes(shot):
    return len(meta(shot))

def load_frame(shot, i):
    i = max(0, min(nframes(shot) - 1, i))
    im = Image.open(f'{ROOT}/frames/{shot}/{i:04d}.jpg').convert('RGB')
    if im.size != (W, H):  # v2 shots are filmed at 1280x720
        im = im.resize((W, H), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1.6, percent=55, threshold=2))
    return np.asarray(im, dtype=np.float32) / 255.0

_ui = {}
def ui_layer(name):
    if name not in _ui:
        im = Image.open(f'{ROOT}/frames/{name}').convert('RGBA')
        if im.size != (W, H):
            im = im.resize((W, H), Image.LANCZOS)
        a = np.asarray(im, dtype=np.float32) / 255.0
        _ui[name] = (a[..., :3], a[..., 3:4])
    return _ui[name]

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
r = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
VIGNETTE = np.clip(1.0 - 0.62 * np.clip(r - 0.35, 0, None) ** 1.6, 0, 1)[..., None]

def grade(img, bright=1.0, cold=1.0):
    x = np.clip((img - 0.025) / 0.975, 0, 1) ** 1.12 * bright
    lum = (x * np.array([0.299, 0.587, 0.114], np.float32)).sum(-1, keepdims=True)
    x = lum + (x - lum) * 0.72                                  # pull the colour down
    x = x * np.array([0.95, 0.99, 1.05 * cold], np.float32)     # cold night cast
    return np.clip(x * VIGNETTE, 0, 1)

def grain(img, amount=0.022):
    n = rng.normal(0, amount, (H // 2, W // 2, 1)).astype(np.float32)
    n = np.repeat(np.repeat(n, 2, 0), 2, 1)
    return np.clip(img + n, 0, 1)

def shake(img, px):
    if px <= 0:
        return img
    dx, dy = rng.integers(-px, px + 1, 2)
    return np.roll(np.roll(img, int(dy), 0), int(dx), 1)

# ------------------------------------------------------------------ captions
def tracked(draw, xy, text, font, fill, tracking):
    x, y = xy
    for i, ch in enumerate(text):
        draw.text((x, y), ch, font=font, fill=fill)
        joined = ch == '―' and i + 1 < len(text) and text[i + 1] == '―'   # keep a double dash unbroken
        x += draw.textlength(ch, font=font) + (0 if joined else tracking)

def text_width(text, font, tracking):
    d = ImageDraw.Draw(Image.new('L', (1, 1)))
    return sum(d.textlength(c, font=font) for c in text) + tracking * max(0, len(text) - 1)

_caps = {}
def caption_layer(ja, en, where):
    key = (ja, en, where)
    if key in _caps:
        return _caps[key]
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    fj = ImageFont.truetype(SERIF, 70 if where == 'center' else 60, index=0)
    fe = ImageFont.truetype(SANS, 28, index=0)
    tj, te = 6, 4
    wj, we = text_width(ja, fj, tj), text_width(en, fe, te)
    y0 = H // 2 - 70 if where == 'center' else int(H * 0.74)
    if where == 'top':
        y0 = int(H * 0.08)
    sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ds = ImageDraw.Draw(sh)
    tracked(ds, ((W - wj) / 2, y0), ja, fj, (0, 0, 0, 230), tj)
    if en:
        tracked(ds, ((W - we) / 2, y0 + 104), en, fe, (0, 0, 0, 230), te)
    sh = sh.filter(ImageFilter.GaussianBlur(9))
    im.alpha_composite(sh)
    d = ImageDraw.Draw(im)
    tracked(d, ((W - wj) / 2, y0), ja, fj, (240, 235, 221, 255), tj)
    if en:
        tracked(d, ((W - we) / 2, y0 + 104), en, fe, (185, 177, 165, 255), te)
    a = np.asarray(im, dtype=np.float32) / 255.0
    _caps[key] = (a[..., :3], a[..., 3:4])
    return _caps[key]

def over(img, layer, alpha=1.0):
    rgb, a = layer
    a = a * alpha
    return img * (1 - a) + rgb * a

# ------------------------------------------------------------------ the edit (Ver.2)
# Each segment produces frames; `cap` = (ja, en, where, from_s, to_s) relative to the segment start.
segs = []
def seg(kind, n, **kw):
    segs.append(dict(kind=kind, n=int(n), **kw))

def find(shot, pred, default):
    for i, m in enumerate(meta(shot)):
        if pred(m):
            return i
    return default

K5 = os.environ.get('PV_K5', 'kill5')
k5 = find(K5, lambda m: m['lunge'], 70)
o8 = find('open8', lambda m: m['lunge'], 40)
SAID = os.environ.get('PV_SAID', '1071')

seg('black', 2.0 * FPS, cap=('深夜23時。', '11 P.M.', 'center', 0.3, 1.8))
seg('shot', 96, shot='exterior', start=20, cap=('10階の自転車を、取りに来ただけだった。', 'I only came back for my bike on the tenth floor.', 'bottom', 0.3, 3.1), bright=1.05)
seg('shot', 105, shot='ride10', start=45, cap=('誰も呼んでいない階で、止まる。', 'It stops on a floor nobody called.', 'bottom', 1.8, 3.45), bright=1.1)
seg('shot', 30, shot='ride10', start=208, bright=1.1)
seg('shot', 80, shot='dup7', start=35, cap=('通路の奥に、自分の自転車が停まっていた。', 'At the end of the aisle stood my own bike.', 'bottom', 0.2, 2.6), bright=1.25)
seg('shot', 26, shot='scrawl7', start=30, flash=(0, 0.8, 4), bright=1.6)
seg('shot', 70, shot='hands4', start=20, cap=('扉を叩く音は、内側からだった。', 'The banging came from the inside.', 'bottom', 0.6, 2.3), bright=1.3)
seg('black', 1.5 * FPS, cap=('間違えなくても、', 'Even if you get nothing wrong,', 'center', 0.15, 1.5))
seg('black', 1.6 * FPS, cap=('管理人は、来る。', 'the caretaker comes.', 'center', 0.0, 1.6))
seg('shot', 100, shot='lights8', start=10, cap=('照明が消えたら、動かないこと。', 'If the lights go out, do not move.', 'bottom', 1.6, 3.3), bright=1.15)
seg('black', 2.6 * FPS, cap=('目を閉じて、足音が遠ざかるまで。', 'Eyes closed, until the footsteps are gone.', 'center', 0.2, 2.5))
seg('black', 2.4 * FPS, cap=('……もう、明るくなりましたよ。', '...The lights are back on now.', 'center', 0.3, 2.3))
seg('shot', o8 + 12 - max(0, o8 - 26), shot='open8', start=max(0, o8 - 26), bright=1.15, pounce=o8 - max(0, o8 - 26))
seg('black', 0.5 * FPS)
seg('shot', 150, shot='ride5_open', start=20, cap=('止まるはずのない階で、乗ってくる。', 'He gets on where the car should never stop.', 'bottom', 2.4, 4.8), bright=1.2)
seg('shot', 150, shot='ride5_turn', start=10, cap=('……何階ですか', '...Which floor?', 'top', 2.1, 3.65), bright=1.2, uilayer=('ui_choice5.png', 112))
seg('shot', 120, shot='roll3', start=0, cap=(f'……{SAID}番の方ですね？', f"...You're number {SAID}, aren't you?", 'bottom', 1.9, 3.9), bright=1.15)
seg('shot', k5 + 12 - max(0, k5 - 50), shot=K5, start=max(0, k5 - 50), bright=1.1, pounce=k5 - max(0, k5 - 50))
seg('black', 1.6 * FPS, cap=('選択を誤れば、そこで終わり。', 'Choose wrong, and that is where it ends.', 'center', 0.25, 1.55))
seg('title', 5.6 * FPS)
seg('shot', 100, shot='foot8', start=0, cap=('……誰かが、すぐ横を通っていった。', '...Someone walked right past you.', 'bottom', 0.9, 3.3), bright=1.25)
seg('black', 0.6 * FPS)

t = 0
for s in segs:
    s['t0'] = t
    t += s['n']
TOTAL = t
print(f'timeline {TOTAL} frames = {TOTAL / FPS:.1f} s; kill5 lunge {k5}, open8 lunge {o8}')

title_logo = np.asarray(Image.open(f'{ROOT}/title/title_logo.png').convert('RGBA'), dtype=np.float32) / 255.0
title_info = np.asarray(Image.open(f'{ROOT}/title/title_info.png').convert('RGBA'), dtype=np.float32) / 255.0

def render(fi):
    s = next(x for x in segs if x['t0'] <= fi < x['t0'] + x['n'])
    j = fi - s['t0']
    ts = j / FPS
    if s['kind'] == 'black':
        img = np.zeros((H, W, 3), np.float32)
    elif s['kind'] == 'title':
        img = np.zeros((H, W, 3), np.float32)
        a1 = min(1, ts / 0.9) * (0.75 + 0.25 * (rng.random() > 0.12 or ts > 1.0))
        a2 = min(1, max(0, (ts - 1.3) / 0.8))
        img = over(img, (title_logo[..., :3], title_logo[..., 3:4]), a1)
        img = over(img, (title_info[..., :3], title_info[..., 3:4]), a2)
        out_a = min(1, max(0, (s['n'] / FPS - ts) / 0.4))
        img = img * out_a
    else:
        src = s['start'] + j
        img = load_frame(s['shot'], src)
        bright = s.get('bright', 1.0)
        if s.get('bright_from') and src >= s['bright_from'][0]:
            bright = s['bright_from'][1]
        if s.get('flicker'):
            bright *= 1.0 if rng.random() > 0.45 else rng.uniform(0.05, 0.4)
        img = grade(img, bright)
        m = meta(s['shot'])[min(src, nframes(s['shot']) - 1)]
        if m.get('ui'):
            img = over(img, ui_layer(m['ui']))
        ul = s.get('uilayer')
        if ul and j >= ul[1]:
            img = over(img, ui_layer(ul[0]), min(1, (j - ul[1]) / 6))
        if s.get('pounce') is not None and j >= s['pounce']:
            k = j - s['pounce']
            img = shake(img, max(0, 18 - k * 2))
            if k < 7:
                img = over(img, (np.ones((H, W, 3), np.float32) * np.array([1, 0.85, 0.8], np.float32), np.ones((H, W, 1), np.float32)), 0.85 * (1 - k / 7))
            if k > 10:
                img = np.zeros_like(img)
        if s.get('endflash') and j >= s['n'] - 2:
            img = over(img, (np.ones((H, W, 3), np.float32), np.ones((H, W, 1), np.float32)), 0.9)
        if s.get('shakepx'):
            img = shake(img, s['shakepx'])
        sa = s.get('shake_at')
        if sa and sa[0] <= src < sa[0] + sa[2]:
            img = shake(img, round(sa[1] * (1 - (src - sa[0]) / sa[2])))
    f = s.get('flash')
    if f and f[0] <= j < f[0] + f[2]:
        col = np.array(f[3] if len(f) > 3 else (1, 1, 1), np.float32)
        img = over(img, (np.ones((H, W, 3), np.float32) * col, np.ones((H, W, 1), np.float32)), f[1] * (1 - (j - f[0]) / f[2]))
    if s.get('cap'):
        ja, en, where, a, b = s['cap']
        if a <= ts <= b:
            alpha = min(1, (ts - a) / 0.25, (b - ts) / 0.3)
            img = over(img, caption_layer(ja, en, where), max(0, alpha))
    if s['kind'] != 'black':
        img = grain(img)
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)

# ------------------------------------------------------------------ preview sheet
if PREVIEW:
    # --at seg:frac,seg:frac picks specific moments instead of 60% into every segment
    at = sys.argv[sys.argv.index('--at') + 1].split(',') if '--at' in sys.argv else None
    picks = [int(segs[int(a.split(':')[0])]['t0'] + segs[int(a.split(':')[0])]['n'] * float(a.split(':')[1])) for a in at] if at else [int(s['t0'] + s['n'] * 0.6) for s in segs]
    tiles = [Image.fromarray(render(p)).resize((384, 216)) for p in picks]
    cols = 5 if not at else min(3, len(tiles))
    if at:
        tiles = [Image.fromarray(render(p)).resize((960, 540)) for p in picks]
    tw, th = tiles[0].size
    sheet = Image.new('RGB', (tw * cols, th * ((len(tiles) + cols - 1) // cols)))
    for i, tl in enumerate(tiles):
        sheet.paste(tl, ((i % cols) * tw, (i // cols) * th))
    sheet.save(PREVIEW, quality=88)
    print('preview', PREVIEW)
    sys.exit(0)

# ------------------------------------------------------------------ sound
def decode(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()

snd = {}
for f in os.listdir(f'{ASSETS}/audio'):
    if f.endswith('.wav'):
        snd[f[:-4]] = decode(f'{ASSETS}/audio/{f}')
for f in os.listdir(f'{ASSETS}/music'):
    if f.endswith('.mp3'):
        snd[f[:-4]] = decode(f'{ASSETS}/music/{f}')

N = int(TOTAL / FPS * SR) + SR
mix = np.zeros((N, 2), np.float32)

def place(x, t, gain=1.0, pan=0.0, dur=None, fade_in=0.0, fade_out=0.0, loop=False):
    if isinstance(x, str):
        x = snd[x]
    n0 = int(t * SR)
    if dur is not None:
        n = int(dur * SR)
        if loop and len(x) < n:
            x = np.tile(x, (n // len(x) + 1, 1))
        x = x[:n]
    x = x.copy() * gain
    if pan:
        x[:, 0] *= min(1, 1 - pan)
        x[:, 1] *= min(1, 1 + pan)
    if fade_in:
        k = min(len(x), int(fade_in * SR)); x[:k] *= np.linspace(0, 1, k)[:, None]
    if fade_out:
        k = min(len(x), int(fade_out * SR)); x[-k:] *= np.linspace(1, 0, k)[:, None]
    n1 = min(N, n0 + len(x))
    if n1 > n0:
        mix[n0:n1] += x[: n1 - n0]

def tone(freq, dur, gain, decay=6.0, noise=0.0):
    tt = np.arange(int(dur * SR)) / SR
    y = np.sin(2 * np.pi * freq * tt) * np.exp(-tt * decay)
    if noise:
        nz = rng.normal(0, 1, len(tt)) * np.exp(-tt * decay * 2.5)
        nz = np.convolve(nz, np.ones(24) / 24, 'same')
        y = y + nz * noise
    return np.stack([y, y], 1).astype(np.float32) * gain

def drone(dur, base=43.0, gain=0.25, rise=0.0):
    tt = np.arange(int(dur * SR)) / SR
    y = sum(np.sin(2 * np.pi * (base * m + rise * tt * m) * tt + p) / (i + 1) for i, (m, p) in enumerate([(1, 0), (1.5, 1), (2.01, 2), (3.0, .5)]))
    nz = np.convolve(rng.normal(0, 1, len(tt)), np.ones(400) / 400, 'same') * 6
    y = (y * 0.6 + nz) * (0.55 + 0.45 * np.sin(2 * np.pi * 0.18 * tt))
    env = np.minimum(1, tt / 1.5) * np.minimum(1, (dur - tt) / 1.0)
    return np.stack([y, np.roll(y, 300)], 1).astype(np.float32) * gain * env[:, None]

def heartbeat(t, beats, bpm, gain=0.5):
    for b in range(beats):
        tb = t + b * 60 / bpm
        place(tone(52, 0.25, gain, 18), tb)
        place(tone(46, 0.22, gain * 0.7, 18), tb + 0.24)

def knock(t, gain=0.7):
    place(tone(110, 0.3, gain, 22, noise=1.6), t)

def breath(t, dur=1.6, gain=0.18):
    tt = np.arange(int(dur * SR)) / SR
    nz = rng.normal(0, 1, len(tt))
    nz = np.convolve(nz, np.ones(14) / 14, 'same') - np.convolve(nz, np.ones(90) / 90, 'same')
    env = np.sin(np.pi * tt / dur) ** 2
    place(np.stack([nz * env, nz * env], 1).astype(np.float32) * gain, t)

T = {}
for i, s in enumerate(segs):
    T[i] = s['t0'] / FPS
S = lambda i: T[i]
D = lambda i: segs[i]['n'] / FPS

# 0 black / 1 exterior: night air, footsteps
place('outdoor_air_loop', 0.0, 0.55, dur=S(2) + 0.3, fade_in=1.2, fade_out=0.4, loop=True)
place(drone(S(7), 41, 0.15, rise=0.04), 0.0)
for k in range(5):
    place('footstep_left' if k % 2 else 'footstep_right', S(1) + 0.3 + k * 0.58, 0.42, pan=(0.15 if k % 2 else -0.15))
# 2-3 ride up: motor, the unasked stop, one knock
place('elevator_motor_loop', S(2), 0.5, dur=1.75, fade_in=0.3, fade_out=0.15, loop=True)
place('power_cut', S(2) + 1.7, 0.25)
knock(S(2) + 3.1, 0.8)
place('st_hit', S(2) + 3.1, 0.35)
place('elevator_motor_loop', S(3), 0.5, dur=D(3), fade_in=0.1, fade_out=0.2, loop=True)
# 4 dup bike: music under, a whisper
place('bgm_explore1', S(4), 0.5, dur=D(4) + D(5) + D(6), fade_in=0.4, fade_out=0.3)
place('st_whisper', S(4) + 0.8, 0.5, pan=0.2)
place('st_stab', S(5), 0.7)
# 6 handprints: bangs from inside
for tk in (0.15, 0.78, 1.35, 2.05):  # the frames where each print appears (filmed: 25, 44, 61, 82)
    knock(S(6) + tk, 0.95)
place('st_hit', S(6) + 0.15, 0.5)
# 7-8 the line
place('st_braam', S(7) + 0.05, 0.7, dur=3.0, fade_out=0.8)
place(drone(D(7) + D(8) + D(9), 36, 0.2), S(7))
# 9 lights out at frame 40 of the shot (30 into the segment)
place('garage_air_loop', S(9), 0.35, dur=D(9) + D(10) + D(11), fade_in=0.3, fade_out=0.3, loop=True)
lights_off = S(9) + (40 - 10) / FPS
place('power_cut', lights_off - 0.05, 1.0)
place('st_impact', lights_off, 0.8)
for k in range(5):
    place('footstep_left' if k % 2 else 'footstep_right', lights_off + 1.0 + k * 0.6, 0.25 + k * 0.12, pan=-0.3 + k * 0.06)
# 10 eyes closed: steps arrive, breathing right in front
for k in range(3):
    place('footstep_left' if k % 2 else 'footstep_right', S(10) + 0.2 + k * 0.62, 0.9, pan=-0.1)
breath(S(10) + 1.4, 2.0, 0.24)
heartbeat(S(10) + 0.4, 4, 70, 0.4)
# 11 the voice (the line is on screen); a whisper under it
place('st_whisper', S(11) + 0.2, 0.55)
breath(S(11) + 1.2, 1.4, 0.18)
# 12 eyes open: his face — riser, scream, cut
o8_pounce = S(12) + segs[12]['pounce'] / FPS
place('st_riser', o8_pounce - 0.9, 0.9)
place('st_scare', o8_pounce - 0.03, 1.05)
# 14 5F: stop, doors open, he walks in
place('power_cut', S(14), 0.3)
place('elevator_open', S(14) + 0.05, 0.8)
for k in range(5):
    place('footstep_left' if k % 2 else 'footstep_right', S(14) + 2.3 + k * 0.62, 0.8, pan=0.05)
place('caretaker_presence', S(14) + 2.0, 0.6)
place(drone(D(14) + D(15), 40, 0.17, rise=0.06), S(14))
# 15 the head turns (creak), the question
for k in range(int(3.4 / 0.03)):
    tc = S(15) + 0.4 + k * 0.03 + rng.random() * 0.02
    place(tone(900 + 700 * rng.random(), 0.02, 0.06 * (0.5 + 0.5 * np.sin(np.pi * k / 113)), 220, noise=0.8), tc)
place('st_whisper', S(15) + 3.1, 0.5)
heartbeat(S(15) + 2.6, 3, 84, 0.42)
# 16 3F: the doors open on him
place('elevator_open', S(16), 0.85)
place('st_hit', S(16) + 0.45, 0.55)
place('caretaker_presence', S(16) + 0.5, 0.7)
# 17 the kill
k5_pounce = S(17) + segs[17]['pounce'] / FPS
place('st_riser', k5_pounce - 1.9, 1.0)
place('st_scare', k5_pounce - 0.03, 1.15)
# 18 black line, 19 title
place('st_braam', S(19), 0.7, fade_out=1.5)
place(drone(D(19), 38, 0.18), S(19))
place('bgm_title', S(19) + 0.6, 0.45, dur=D(19) - 0.6, fade_in=1.2, fade_out=0.6)
# 20 tag: lights back, footprints
place('power_cut', S(20), 0.3)
place('garage_air_loop', S(20), 0.5, dur=D(20), fade_in=0.2, loop=True)
breath(S(20) + 1.6, 1.4, 0.16)
place('st_hit', S(21) - 0.02, 0.9)

# hard cuts to black under each scream: the tail stops dead, then silence
def duck(t0, t1, keep=0.0):
    a, b = int(t0 * SR), int(t1 * SR)
    mix[a:b] *= keep
fade = int(0.04 * SR)
for p, until in ((o8_pounce, S(14)), (k5_pounce, S(18) + 0.2)):
    cut = p + 11 / FPS
    mix[int(cut * SR): int(cut * SR) + fade] *= np.linspace(1, 0, fade)[:, None]
    duck(cut + 0.04, until)
print(f'mix peak before soft clip: {np.abs(mix).max():.2f}')
mix = (np.tanh(mix * 1.1) * 0.97).astype(np.float32)  # soft clip below full scale; keep float32 (a float64 scalar would promote it)
wav = f'{ROOT}/pv_mix.wav'
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', '-c:a', 'pcm_s16le', wav], input=mix.tobytes(), check=True)
print('mix written', wav)

# ------------------------------------------------------------------ encode
# linear gain to about -14 LUFS (true peak kept under -1 dBTP); a dynamic loudnorm pass would flatten the scares
ln = subprocess.run(['ffmpeg', '-hide_banner', '-i', wav, '-af', 'loudnorm=I=-14:TP=-1:print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
ln = json.loads(ln[ln.rindex('{'):ln.rindex('}') + 1])
GAIN_DB = min(-14 - float(ln['input_i']), -1.0 - float(ln['input_tp']))
print(f"mix {ln['input_i']} LUFS, TP {ln['input_tp']} -> gain {GAIN_DB:+.2f} dB")
if '--audio-only' in sys.argv:
    print('gain_db', GAIN_DB)
    sys.exit(0)
enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-i', wav,
                        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
                        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-af', f'volume={GAIN_DB:.2f}dB',
                        '-movflags', '+faststart', '-shortest', OUT], stdin=subprocess.PIPE)
for fi in range(TOTAL):
    enc.stdin.write(render(fi).tobytes())
    if fi % 150 == 0:
        print('frame', fi, '/', TOTAL, flush=True)
enc.stdin.close()
enc.wait()
print('done', OUT)
