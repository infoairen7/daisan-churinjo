#!/usr/bin/env python3
"""PV editor: cuts the captured shots into a ~40 s trailer, grades them, lays captions/UI/flashes on top,
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
    return np.asarray(Image.open(f'{ROOT}/frames/{shot}/{i:04d}.jpg').convert('RGB'), dtype=np.float32) / 255.0

_ui = {}
def ui_layer(name):
    if name not in _ui:
        im = Image.open(f'{ROOT}/frames/{name}').convert('RGBA')
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

# ------------------------------------------------------------------ the edit
# Each segment produces frames; `cap` = (ja, en, where, from_s, to_s) relative to the segment start.
segs = []
def seg(kind, n, **kw):
    segs.append(dict(kind=kind, n=int(n), **kw))

def find(shot, pred, default):
    for i, m in enumerate(meta(shot)):
        if pred(m):
            return i
    return default

fig_gone = find('figure', lambda m: m['sil'] == 'gone', 84)
rv = meta('reveal')
lunge_frames = [i for i, m in enumerate(rv) if m['lunge']]
lunge0 = lunge_frames[0] if lunge_frames else 150
lunge1 = lunge_frames[-1] if lunge_frames else lunge0 + 10

seg('black', 2.6 * FPS, cap=('深夜23時。', '11 P.M.', 'center', 0.4, 2.3))
seg('shot', 132, shot='exterior', start=0, cap=('5階の自転車を、取りに来ただけだった。', 'I only came back for my bike.', 'bottom', 0.5, 4.1), bright=1.05)
seg('shot', 96, shot='ride', start=30)
seg('shot', 24, shot='blackout', start=0)
seg('shot', 12, shot='blackout', start=24, flash=(0, 1.0, 7), shakepx=10, bright=0.2)
seg('shot', 84, shot='blackout', start=36, cap=('扉が、開かない。', "The doors won't open.", 'bottom', 0.4, 2.7), bright=1.15)
seg('shot', 72, shot='panel_on', start=8, cap=('駐輪車を数えて、照合票に答えろ。', 'Count the parked bikes. Answer the checklist.', 'bottom', 0.5, 2.4 + 2.8), bright=1.1, bright_from=(19, 0.62))
seg('shot', 84, shot='inspect', start=20, capcont=True)
wrong_warn = find('wrong', lambda m: m['warn'] or (m['ui'] or '').endswith('warn.png'), 48)
seg('shot', wrong_warn + 32, shot='wrong', start=0, cap=('1回目は、警告。', 'First mistake: a warning.', 'top', wrong_warn / FPS + 0.05, wrong_warn / FPS + 1.0),
    bright_from=(wrong_warn, 0.5), flash=(wrong_warn, 0.55, 8, (1.0, 0.12, 0.08)), shake_at=(wrong_warn, 9, 8))
seg('black', 30, cap=('2回目は――', 'The second time...', 'center', 0.0, 1.0))
seg('shot', fig_gone + 1, shot='figure', start=0, bright=1.25, endflash=True)
seg('shot', 18, shot='door3f', start=4, flash=(0, 0.85, 3), bright=1.15)
seg('shot', 18, shot='wheel', start=10, flash=(0, 0.85, 3), bright=0.8)
seg('shot', 18, shot='blackout', start=60, flash=(0, 0.85, 3), flicker=True, bright=1.2)
seg('shot', 48, shot='reveal', start=6, bright=1.05)
seg('shot', (lunge1 + 9) - (lunge0 - 64), shot='reveal', start=lunge0 - 64, cap=('管理人が、来る。', 'And the caretaker comes.', 'bottom', 0.3, 1.9), bright=1.05, pounce=64)
seg('black', 1.0 * FPS)
seg('title', 5.6 * FPS)
seg('shot', 78, shot='bedroom', start=6, cap=('……帰れたと、思った？', '...Thought you made it home?', 'bottom', 0.5, 2.5), bright=1.15)
seg('black', 0.6 * FPS)

t = 0
for s in segs:
    s['t0'] = t
    t += s['n']
TOTAL = t
print(f'timeline {TOTAL} frames = {TOTAL / FPS:.1f} s; figure cut {fig_gone}, lunge {lunge0}-{lunge1}')

# a caption can span two shots (panel_on → inspect)
for k, s in enumerate(segs):
    if s.get('capcont'):
        p = segs[k - 1]
        ja, en, where, a, b = p['cap']
        s['cap'] = (ja, en, where, a - p['n'] / FPS, b - p['n'] / FPS)

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

# 0 black / 1 exterior: night air, distant city, footsteps
place('outdoor_air_loop', 0.0, 0.55, dur=S(2) + 0.3, fade_in=1.2, fade_out=0.4, loop=True)
place(drone(S(4) + 0.4, 41, 0.16, rise=0.05), 0.0)
for k in range(7):
    place('footstep_left' if k % 2 else 'footstep_right', S(1) + 0.4 + k * 0.58, 0.45, pan=(0.15 if k % 2 else -0.15))
# 2 ride
place('elevator_close', S(2), 0.8)
place('elevator_motor_loop', S(2) + 1.2, 0.5, dur=S(4) - S(2) - 1.2 + 0.4, fade_in=0.4, loop=True)
# 4 power cut
place('power_cut', S(4) - 0.05, 1.0)
place('st_impact', S(4), 1.0)
# 5 locked in the dark
place('garage_air_loop', S(5), 0.4, dur=S(9) - S(5), fade_in=0.8, fade_out=0.2, loop=True)
place('st_hit', S(5) + 0.3, 0.45)
heartbeat(S(5) + 0.9, 4, 62, 0.45)
# 6 panel wakes / 7 inspect / 8 wrong
place('answer_correct', S(6) + 10 / FPS, 0.6)
place('bgm_explore2', S(6), 0.55, dur=S(8) + 1.4 - S(6), fade_in=0.6, fade_out=0.4)
place('panel_press', S(7) + (52 - 20) / FPS, 0.5)
for k in range(3):
    place('footstep_right' if k % 2 else 'footstep_left', S(7) + 0.2 + k * 0.6, 0.35)
wm = meta('wrong')
for k in range(1, len(wm)):
    if wm[k]['ui'] != wm[k - 1]['ui'] and wm[k]['ui'] and 'warn' not in wm[k]['ui']:
        place('panel_press', S(8) + k / FPS, 0.6)
wrong_open = S(8) + find('wrong', lambda m: m['warn'] or (m['ui'] or '').endswith('warn.png'), 50) / FPS
place('panel_press', wrong_open - 0.12, 0.7)
place('warning_buzzer', wrong_open - 0.1, 0.9)
place('st_hit', wrong_open - 0.05, 0.8)
place('bgm_warning', wrong_open + 0.1, 0.6, dur=S(9) - wrong_open - 0.1, fade_in=0.2, fade_out=0.15)
heartbeat(wrong_open + 0.2, 3, 96, 0.5)
# 9 black: the drop
place('st_whisper', S(9) + 0.15, 0.6)
# 10 figure: silence, it is there, it runs
place('garage_air_loop', S(10), 0.25, dur=segs[10]['n'] / FPS, loop=True, fade_out=0.05)
place('st_whisper', S(10) + 1.3, 0.55, pan=0.2)
fig_charge = S(10) + find('figure', lambda m: m['lunge'], max(0, fig_gone - 26)) / FPS
place('st_stab', fig_charge, 0.95)
place('st_impact', S(11) - 0.02, 1.0)
# 11-13 quick cuts
knock(S(11) + 0.02); knock(S(11) + 0.2); knock(S(11) + 0.38)
place('bicycle_roll_loop', S(12), 0.6, dur=0.6, fade_out=0.1)
place('st_hit', S(12), 0.5)
place('st_braam', S(13), 0.9, dur=2.4, fade_out=0.6)
# 14-15 reveal
place('elevator_open', S(14), 0.8)
place('caretaker_presence', S(14) + 0.9, 0.85)
pounce_t = S(15) + 64 / FPS
place('st_riser', pounce_t - 2.15, 1.0)
place('st_scare', pounce_t - 0.03, 1.15)
# 16 black: nothing. 17 title
place('st_braam', S(17), 0.7, fade_out=1.5)
place(drone(segs[17]['n'] / FPS, 38, 0.18), S(17))
place('bgm_title', S(17) + 0.6, 0.45, dur=segs[17]['n'] / FPS - 0.6, fade_in=1.2, fade_out=0.6)
# 18 bedroom tag
place('bedroom_roomtone_loop', S(18), 0.6, dur=segs[18]['n'] / FPS, fade_in=0.3, loop=True)
breath(S(18) + 0.4, 1.7, 0.22); breath(S(18) + 1.9, 1.5, 0.26)
place('st_hit', S(19) - 0.02, 0.9)

# kill everything under the hard cuts to black (scream tail stops dead, then silence)
def duck(t0, t1, keep=0.0):
    a, b = int(t0 * SR), int(t1 * SR)
    mix[a:b] *= keep
cut = pounce_t + 11 / FPS
fade = int(0.04 * SR)
mix[int(cut * SR): int(cut * SR) + fade] *= np.linspace(1, 0, fade)[:, None]
duck(cut + 0.04, S(17))
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
