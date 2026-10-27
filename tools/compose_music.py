"""Procedural horror score + stingers for 第３駐輪場 (original, synthesized from scratch).

Usage: python3 -I tools/compose_music.py public/assets/music
Writes MP3s (via ffmpeg/libmp3lame) and music_manifest.json.

Loops are rendered seamless and then padded with 1 s of wrapped audio on each side, so the
player can loop between loopStart=1.0 and loopEnd=1.0+L regardless of MP3 encoder delay.
"""
import json, os, subprocess, sys, tempfile, wave
import numpy as np
import scipy.signal as ss

SR = 44100
OUT = sys.argv[1] if len(sys.argv) > 1 else 'public/assets/music'
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(310517)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def tt(dur):
    return np.arange(int(dur * SR)) / SR


def osc_phase(freq):
    """freq: scalar or array (Hz) -> phase array (radians)."""
    return 2 * np.pi * np.cumsum(np.broadcast_to(freq, freq.shape if hasattr(freq, 'shape') else (1,))) / SR


def saw(freq, dur, kmax=40):
    n = int(dur * SR)
    f = np.full(n, freq) if np.isscalar(freq) else freq[:n]
    ph = 2 * np.pi * np.cumsum(f) / SR + rng.uniform(0, 2 * np.pi)
    out = np.zeros(n)
    fmax = float(np.max(f))
    K = int(max(1, min(kmax, (SR / 2 - 500) / max(fmax, 1))))
    for k in range(1, K + 1):
        out += ((-1) ** (k + 1)) * np.sin(k * ph) / k
    return out * (2 / np.pi)


def sine(freq, dur, phase=None):
    n = int(dur * SR)
    f = np.full(n, freq) if np.isscalar(freq) else freq[:n]
    ph = 2 * np.pi * np.cumsum(f) / SR + (rng.uniform(0, 2 * np.pi) if phase is None else phase)
    return np.sin(ph)


def noise(dur):
    return rng.standard_normal(int(dur * SR))


def sos(kind, fc, order=2):
    nyq = SR / 2
    if kind == 'band':
        lo, hi = fc
        return ss.butter(order, [max(10, lo) / nyq, min(hi, nyq * 0.98) / nyq], 'band', output='sos')
    return ss.butter(order, min(fc, nyq * 0.98) / nyq, kind, output='sos')


def filt(x, kind, fc, order=2):
    return ss.sosfilt(sos(kind, fc, order), x)


def sweep_lp(x, cut, block=1024, order=2):
    """time-varying low-pass; cut is an array (Hz) of len(x)"""
    out = np.zeros_like(x)
    zi = None
    for i in range(0, len(x), block):
        c = float(np.mean(cut[i:i + block]))
        s = sos('low', max(40.0, c), order)
        if zi is None:
            zi = np.zeros((s.shape[0], 2))
        out[i:i + block], zi = ss.sosfilt(s, x[i:i + block], zi=zi)
    return out


def sweep_bp(x, center, q=4.0, block=1024):
    out = np.zeros_like(x)
    zi = None
    for i in range(0, len(x), block):
        c = float(np.mean(center[i:i + block]))
        bw = c / q
        s = sos('band', (c - bw / 2, c + bw / 2), 2)
        if zi is None:
            zi = np.zeros((s.shape[0], 2))
        out[i:i + block], zi = ss.sosfilt(s, x[i:i + block], zi=zi)
    return out


def env(n, a, d=0.0, s=1.0, r=0.0, total=None):
    """ADSR with times in seconds; total length n samples (release at the end)."""
    e = np.ones(n) * s
    A, D, R = int(a * SR), int(d * SR), int(r * SR)
    A = min(A, n)
    if A > 0:
        e[:A] = np.linspace(0, 1, A) ** 1.5
    if D > 0 and A + D < n:
        e[A:A + D] = np.linspace(1, s, D)
    if R > 0:
        R = min(R, n)
        e[n - R:] *= np.linspace(1, 0, R) ** 1.5
    return e


def expdec(n, rate):
    return np.exp(-np.arange(n) / SR * rate)


def pan(x, p):
    """mono -> stereo, p in [-1, 1]"""
    a = (p + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)])


def place(buf, x, t0, gain=1.0):
    """add stereo or mono x into stereo buf at t0 seconds (wraps around the loop end)."""
    if x.ndim == 1:
        x = np.stack([x, x])
    i = int(t0 * SR)
    n = x.shape[1]
    L = buf.shape[1]
    end = i + n
    if end <= L:
        buf[:, i:end] += x * gain
    else:
        k = L - i
        buf[:, i:] += x[:, :k] * gain
        rem = x[:, k:]
        while rem.shape[1] > 0:
            m = min(L, rem.shape[1])
            buf[:, :m] += rem[:, :m] * gain
            rem = rem[:, m:]


def make_ir(decay=3.0, predelay=0.025, damp=0.6, size=1.0):
    n = int((decay * 1.4 + predelay) * SR)
    ir = np.zeros((2, n))
    for ch in range(2):
        nz = rng.standard_normal(n)
        t = np.arange(n) / SR
        # high frequencies die faster (concrete-ish damping)
        lo = filt(nz, 'low', 900) * np.exp(-t * 6.9 / decay)
        hi = filt(nz, 'high', 900) * np.exp(-t * 6.9 / (decay * damp))
        tail = lo * 1.2 + hi * 0.7
        pd = int(predelay * SR)
        ir[ch, pd:] = tail[: n - pd]
        # a few early reflections
        for k in range(6):
            d = int((0.008 + rng.uniform(0.004, 0.05) * size) * SR) + pd // 2
            if d < n:
                ir[ch, d] += rng.uniform(0.2, 0.5) * (1 if rng.random() < 0.5 else -1)
    ir /= np.max(np.abs(ir)) + 1e-9
    return ir


IR_HALL = make_ir(4.2, 0.03, 0.55, 1.4)
IR_ROOM = make_ir(1.8, 0.012, 0.5, 0.6)
IR_HUGE = make_ir(6.5, 0.05, 0.6, 2.0)


def reverb(x, ir, wet=0.35, dry=1.0):
    """x stereo -> stereo, output length = len(x) (tail is returned separately)."""
    if x.ndim == 1:
        x = np.stack([x, x])
    y = np.stack([ss.fftconvolve(x[0], ir[0]), ss.fftconvolve(x[1], ir[1])])
    y /= (np.sqrt(np.sum(ir[0] ** 2)) + 1e-9)
    n = x.shape[1]
    out = np.zeros((2, y.shape[1]))
    out[:, :n] += x * dry
    out += y * wet
    return out


def wrap(buf_long, L):
    """fold anything past L back onto the start (makes the loop seamless)."""
    n = int(L * SR)
    out = buf_long[:, :n].copy()
    rest = buf_long[:, n:]
    while rest.shape[1] > 0:
        m = min(n, rest.shape[1])
        out[:, :m] += rest[:, :m]
        rest = rest[:, m:]
    return out


def softclip(x, drive=1.5):
    return np.tanh(x * drive) / np.tanh(drive)


def norm_rms(x, db):
    r = np.sqrt(np.mean(x ** 2)) + 1e-12
    y = x * (10 ** (db / 20) / r)
    pk = np.max(np.abs(y))
    if pk > 0.97:
        y = softclip(y / pk * 1.1, 1.2) * 0.97
    return y


def norm_peak(x, db=-1.0):
    return x * (10 ** (db / 20) / (np.max(np.abs(x)) + 1e-12))


# ---------------------------------------------------------------- instruments
def piano(n, dur=5.0, vel=0.8):
    f = midi(n)
    T = tt(dur)
    out = np.zeros_like(T)
    B = 0.00035
    for k in range(1, 10):
        fk = k * f * np.sqrt(1 + B * k * k)
        if fk > SR / 2 - 1000:
            break
        amp = (1 / k ** 1.25) * (1 if k != 7 else 0.3)
        dec = 0.55 + 0.45 * k + (f / 600)
        out += amp * np.sin(2 * np.pi * fk * T + rng.uniform(0, 6.28)) * np.exp(-T * dec)
    # two-stage decay + hammer
    out *= (0.75 * np.exp(-T * 0.9) + 0.25)
    hammer = filt(filt(noise(0.03), 'band', (700, 2600)), 'low', 3000) * expdec(int(0.03 * SR), 160)
    out[: len(hammer)] += hammer * 0.08
    out *= env(len(T), 0.003, 0, 1, 0.25)
    return out * vel


def music_box(n, dur=2.6, vel=0.8, cents=0.0):
    f = midi(n) * 2 ** (cents / 1200)
    T = tt(dur)
    out = np.zeros_like(T)
    for ratio, amp, dec in [(1, 1, 2.2), (2.756, 0.42, 3.4), (5.404, 0.18, 5.5), (8.933, 0.07, 8)]:
        out += amp * np.sin(2 * np.pi * f * ratio * T) * np.exp(-T * dec)
    click = filt(noise(0.006), 'high', 3000) * 0.15
    out[: len(click)] += click
    return out * env(len(T), 0.002, 0, 1, 0.08) * vel


def pad(notes, dur, cutoff, detune=9, voices=3, lfo=0.07, swell=(3.0, 3.0)):
    n = int(dur * SR)
    acc = np.zeros(n)
    for m in notes:
        for v in range(voices):
            c = (v - (voices - 1) / 2) * detune
            f0 = midi(m) * 2 ** (c / 1200)
            vib = 1 + 0.0025 * np.sin(2 * np.pi * (0.13 + 0.07 * v) * np.arange(n) / SR + rng.uniform(0, 6))
            acc += saw(f0 * vib, dur, 24)
    T = np.arange(n) / SR
    cut = cutoff * (1 + 0.45 * np.sin(2 * np.pi * lfo * T + rng.uniform(0, 6)))
    out = sweep_lp(acc, cut, order=2)
    out *= env(n, swell[0], 0, 1, swell[1])
    return out / (len(notes) * voices)


def strings_trem(notes, dur, cutoff=2600, rate=11.0, swell=(2.0, 2.0), depth=0.55):
    n = int(dur * SR)
    acc = np.zeros(n)
    T = np.arange(n) / SR
    for m in notes:
        for v in range(3):
            f0 = midi(m) * 2 ** (((v - 1) * 11) / 1200)
            vib = 1 + 0.004 * np.sin(2 * np.pi * (5.2 + v * 0.4) * T + rng.uniform(0, 6))
            acc += saw(f0 * vib, dur, 30)
    trem = 1 - depth * (0.5 + 0.5 * np.sin(2 * np.pi * rate * T + rng.uniform(0, 6)))
    out = filt(acc * trem, 'low', cutoff, 2)
    out = filt(out, 'high', 180, 1)
    return out * env(n, swell[0], 0, 1, swell[1]) / (len(notes) * 3)


def sub_pulse(f0=62, f1=36, dur=0.6, dec=7.0):
    n = int(dur * SR)
    T = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-T * 18)
    return sine(f, dur, 0) * np.exp(-T * dec) * env(n, 0.004, 0, 1, 0.05)


def taiko(dur=1.2, f0=95, f1=48, muffle=900):
    n = int(dur * SR)
    T = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-T * 22)
    body = sine(f, dur, 0) * np.exp(-T * 5.5)
    hit = filt(noise(dur), 'low', muffle) * np.exp(-T * 40) * 0.6
    return (body + hit) * env(n, 0.002, 0, 1, 0.05)


def metal_hit(dur=4.0, base=180.0, bright=1.0):
    n = int(dur * SR)
    T = np.arange(n) / SR
    out = np.zeros(n)
    for ratio, amp, dec in [(1, 1, 0.9), (2.32, 0.7, 1.3), (3.87, 0.5, 1.8), (5.41, 0.35, 2.6), (7.13, 0.22, 3.4), (9.6, 0.12, 4.5)]:
        out += amp * np.sin(2 * np.pi * base * ratio * (1 + rng.uniform(-0.004, 0.004)) * T + rng.uniform(0, 6)) * np.exp(-T * dec / bright)
    tr = filt(noise(0.05), 'band', (600, 6000)) * expdec(int(0.05 * SR), 60)
    out[: len(tr)] += tr * 0.8
    return out * env(n, 0.001, 0, 1, 0.3)


def glass(n1, n2, dur):
    n = int(dur * SR)
    out = sine(midi(n1), dur) + 0.8 * sine(midi(n2) * 1.002, dur)
    return out * env(n, dur * 0.4, 0, 1, dur * 0.45) * 0.5


def whisper(dur, intensity=1.0):
    n = int(dur * SR)
    T = np.arange(n) / SR
    nz = noise(dur)
    acc = np.zeros(n)
    for fc in (700, 1250, 2600, 3900):
        center = fc * (1 + 0.25 * np.sin(2 * np.pi * rng.uniform(0.3, 1.1) * T + rng.uniform(0, 6)))
        acc += sweep_bp(nz, center, q=6)
    # syllable-like flutter
    flutter = np.clip(np.sin(2 * np.pi * 3.1 * T + rng.uniform(0, 6)) + 0.3 * np.sin(2 * np.pi * 7.7 * T), 0, None) ** 1.5
    return acc * flutter * env(n, 0.3, 0, 1, 0.5) * intensity


def braam(dur=3.2, notes=(33, 45, 40, 48, 46), cutoff_peak=2400):
    n = int(dur * SR)
    T = np.arange(n) / SR
    acc = np.zeros(n)
    for m in notes:
        for v in range(3):
            acc += saw(midi(m) * 2 ** (((v - 1) * 14) / 1200), dur, 40)
    acc /= len(notes) * 3
    cut = 180 + cutoff_peak * np.exp(-((T - 0.25) ** 2) / 0.35) + 300 * np.exp(-T * 0.5)
    out = sweep_lp(acc, cut, order=2)
    out = softclip(out * 3.2, 1.8)
    out += sub_pulse(55, 30, dur, 1.4) * 0.8
    return out * env(n, 0.012, 0, 1, dur * 0.55)


def shriek(dur=1.6):
    n = int(dur * SR)
    T = np.arange(n) / SR
    acc = np.zeros(n)
    for i in range(7):
        f0 = rng.uniform(820, 1900)
        glide = 2 ** ((4 + rng.uniform(-1, 2)) * np.clip(T / dur, 0, 1) / 12)
        vib = 2 ** ((70 * np.sin(2 * np.pi * rng.uniform(9, 15) * T + rng.uniform(0, 6))) / 1200)
        acc += saw(f0 * glide * vib, dur, 12)
    acc = filt(acc, 'high', 600, 2)
    air = filt(noise(dur), 'band', (1800, 7000)) * 0.5
    out = softclip((acc / 7 + air) * 2.6, 2.2)
    return out * env(n, 0.006, 0, 1, dur * 0.5)


def riser(dur=2.2):
    n = int(dur * SR)
    T = np.arange(n) / SR
    x = T / dur
    nz = sweep_bp(noise(dur), 200 * (30 ** x), q=3)
    tone = np.zeros(n)
    for m in (50, 56, 57, 62, 63):
        tone += saw(midi(m) * 2 ** (12 * x ** 1.6 / 12), dur, 20)
    tone = filt(tone / 5, 'high', 120, 1)
    out = (nz * 1.4 + tone * 0.6) * (x ** 2.2)
    out[-int(0.004 * SR):] *= np.linspace(1, 0, int(0.004 * SR))  # cut dead
    return out


def boom(dur=5.0):
    n = int(dur * SR)
    T = np.arange(n) / SR
    sub = sine(28 + 32 * np.exp(-T * 3.5), dur, 0) * np.exp(-T * 1.1)
    nz = filt(noise(dur), 'low', 700) * np.exp(-T * 9)
    mh = metal_hit(dur, 96, 0.8) * 0.35
    return (sub * 1.2 + nz * 0.9 + mh) * env(n, 0.002, 0, 1, 0.8)


def tick():
    n = int(0.05 * SR)
    return filt(noise(0.05), 'band', (2500, 7000)) * expdec(n, 140) * 0.5


# ---------------------------------------------------------------- composition helpers
def buffer(L, extra=8.0):
    return np.zeros((2, int((L + extra) * SR)))


def finish_loop(buf_long, L, rms_db, ir=None, wet=0.3):
    if ir is not None:
        y = reverb(buf_long, ir, wet=wet)
    else:
        y = buf_long
    loop = wrap(y, L)
    loop = norm_rms(loop, rms_db)
    return loop


def pad_file(loop, pad=1.0):
    p = int(pad * SR)
    return np.concatenate([loop[:, -p:], loop, loop[:, :p]], axis=1)


# ---------------------------------------------------------------- tracks
def track_title():
    L = 48.0
    b = buffer(L, 10)
    drone = pad([26, 33, 38], L + 4, 260, detune=7, voices=2, lfo=0.04, swell=(4, 0.01))
    b[:, : len(drone)] += np.stack([drone, drone]) * 0.9
    b[:, : int((L + 4) * SR)] += np.stack([sine(midi(26), L + 4)] * 2) * 0.12
    motif = [(1.5, 62, .7), (5.0, 65, .55), (8.5, 61, .6), (13.5, 57, .65), (17.5, 62, .55), (21.0, 63, .6),
             (25.5, 58, .55), (30.0, 62, .6), (33.5, 65, .5), (37.0, 68, .55), (42.0, 62, .45), (44.5, 57, .4)]
    for t0, m, v in motif:
        place(b, pan(piano(m, 6.0, v), rng.uniform(-0.35, 0.35)), t0, 0.55)
        if rng.random() < 0.4:
            place(b, pan(piano(m - 12, 6.0, v * 0.5), 0), t0 + 0.02, 0.35)
    place(b, pan(metal_hit(5.0, 120, 0.9), -0.6), 24.0, 0.06)
    for t0 in (11.0, 35.0):
        place(b, pan(sub_pulse(55, 34, 1.2, 3), 0), t0, 0.35)
    return 'bgm_title', finish_loop(b, L, -27, IR_HALL, 0.42), L


def track_explore1():
    L = 64.0
    b = buffer(L, 10)
    dr = pad([36, 43], L + 4, 230, detune=8, voices=3, lfo=0.05, swell=(5, 0.01))
    b[:, : len(dr)] += np.stack([dr, dr]) * 1.0
    b[:, : int((L + 4) * SR)] += np.stack([sine(midi(24), L + 4)] * 2) * 0.1
    for t0 in np.arange(2.0, L, 8.0):
        place(b, pan(sub_pulse(58, 36, 0.7, 7), 0), t0, 0.35)
        place(b, pan(sub_pulse(52, 34, 0.7, 7), 0), t0 + 0.32, 0.22)
    for t0, (a, c) in [(9.0, (83, 84)), (29.0, (88, 89)), (49.0, (81, 82))]:
        place(b, pan(glass(a, c, 9.0), rng.uniform(-0.6, 0.6)), t0, 0.05)
    for t0 in (20.0, 44.0):
        place(b, pan(filt(metal_hit(5.0, 150, 0.7), 'low', 1600), rng.uniform(-0.8, 0.8)), t0, 0.08)
    # a slow minor-second rub that comes and goes
    rub = pad([49, 50], 16, 700, detune=6, voices=2, lfo=0.1, swell=(6, 6))
    place(b, pan(rub, 0.2), 33.0, 0.5)
    return 'bgm_explore1', finish_loop(b, L, -28, IR_HALL, 0.4), L


def track_explore2():
    L = 64.0
    b = buffer(L, 10)
    dr = pad([24, 30, 36], L + 4, 190, detune=10, voices=3, lfo=0.06, swell=(5, 0.01))
    b[:, : len(dr)] += np.stack([dr, dr]) * 1.1
    b[:, : int((L + 4) * SR)] += np.stack([sine(midi(24), L + 4)] * 2) * 0.14
    for t0, notes in [(1.0, [60, 61, 67, 68]), (17.0, [53, 54, 60]), (33.0, [62, 63, 69, 70]), (49.0, [55, 56, 61, 62])]:
        place(b, pan(strings_trem(notes, 12.0, 2400, rate=10.5, swell=(5.5, 5.0)), rng.uniform(-0.3, 0.3)), t0, 0.55)
    for t0 in (24.0, 56.0):
        rev = metal_hit(3.5, 210, 1.0)[::-1] * np.linspace(0, 1, int(3.5 * SR)) ** 2
        place(b, pan(rev, -0.3), t0 - 3.5, 0.18)
        place(b, pan(taiko(1.4, 80, 42, 600), 0), t0, 0.45)
    for t0 in (12.0, 40.5):
        w = whisper(6.0, 1.0)
        place(b, np.stack([w * np.linspace(1, 0.2, len(w)), w * np.linspace(0.2, 1, len(w))]), t0, 0.08)
    for t0 in (30.0, 31.1, 47.0):
        place(b, pan(taiko(1.2, 70, 40, 500), 0), t0, 0.32)
    for t0, (a, c) in [(6.0, (90, 91)), (38.0, (86, 87))]:
        place(b, pan(glass(a, c, 8.0), rng.uniform(-0.7, 0.7)), t0, 0.04)
    return 'bgm_explore2', finish_loop(b, L, -25.5, IR_HALL, 0.42), L


def track_warning():
    bpm = 90.0
    beat = 60 / bpm
    L = beat * 48  # 32 s
    b = buffer(L, 8)
    dr = pad([26, 27], L + 4, 260, detune=9, voices=3, lfo=0.12, swell=(2, 0.01))
    b[:, : len(dr)] += np.stack([dr, dr]) * 0.8
    for i in range(48):
        t0 = i * beat
        if i % 2 == 0:
            place(b, pan(taiko(1.0, 92, 46, 700), 0), t0, 0.55)
            place(b, pan(taiko(0.9, 84, 44, 600), 0), t0 + 0.24, 0.32)
        place(b, pan(filt(tick(), 'low', 5000), 0.5 if i % 2 else -0.5), t0, 0.18)
        # staccato low strings in eighths, rubbing D/Eb every two bars
        for h in range(2):
            m = 38 if (i // 8) % 2 == 0 else 39
            st = strings_trem([m, m + 12], 0.24, 950, rate=0.1, swell=(0.02, 0.14), depth=0)
            acc = 1.0 if (i * 2 + h) % 4 == 0 else 0.6
            place(b, pan(st, -0.15 + 0.3 * h), t0 + h * beat / 2, 0.55 * acc)
    hi = strings_trem([74, 75], L + 4, 2400, rate=13, swell=(3, 0.01), depth=0.6)
    b[:, : len(hi)] += np.stack([hi, hi]) * 0.08
    return 'bgm_warning', finish_loop(b, L, -23, IR_ROOM, 0.3), L


def track_bedroom():
    bpm = 63.0
    beat = 60 / bpm
    L = beat * 42  # 3/4, 14 bars ≈ 40 s
    b = buffer(L, 8)
    mel = [(0, 81), (1, 84), (2, 88), (3, 86), (4, 84), (5, 83), (6, 81), (7, 83), (8, 84), (9, 76),
           (12, 77), (13, 81), (14, 84), (15, 83), (16, 81), (17, 80), (18, 81),
           (21, 81), (22, 84), (23, 88), (24, 89), (25, 88), (26, 86), (27, 84), (28, 83), (29, 80),
           (30, 81), (33, 76), (34, 77), (35, 80), (36, 81), (39, 76)]
    box = np.zeros((2, b.shape[1]))
    for step, m in mel:
        cents = rng.uniform(-28, 28) if rng.random() < 0.45 else rng.uniform(-6, 6)
        place(box, pan(music_box(m, 2.8, rng.uniform(0.55, 0.85), cents), rng.uniform(-0.25, 0.25)), step * beat, 0.5)
    # tape wobble: variable-rate read of the music box
    n = box.shape[1]
    T = np.arange(n) / SR
    rate = 1 + 0.006 * np.sin(2 * np.pi * 0.37 * T) + 0.004 * np.sin(2 * np.pi * 1.9 * T)
    pos = np.cumsum(rate)
    pos = np.clip(pos - pos[0], 0, n - 1)
    box = np.stack([np.interp(pos, np.arange(n), box[c]) for c in range(2)])
    b += box
    dr = pad([33, 40], L + 4, 220, detune=6, voices=2, lfo=0.05, swell=(4, 0.01))
    b[:, : len(dr)] += np.stack([dr, dr]) * 0.45
    return 'bgm_bedroom', finish_loop(b, L, -26, IR_ROOM, 0.45), L


def track_secret():
    L = 48.0
    b = buffer(L, 10)
    chords = [[53, 57, 60, 64], [45, 52, 55, 60], [50, 53, 57, 64], [46, 50, 53, 57]]
    for i, ch in enumerate(chords):
        p = pad(ch, 14.0, 950, detune=8, voices=3, lfo=0.06, swell=(4.0, 4.0))
        place(b, pan(p, 0), i * 12.0, 0.9)
        for k, m in enumerate(sorted(ch)[1:]):
            place(b, pan(piano(m + 12, 5.0, 0.35), -0.3 + 0.3 * k), i * 12.0 + 1.5 + k * 1.6, 0.35)
    return 'bgm_secret', finish_loop(b, L, -27, IR_HALL, 0.45), L


# ---------------------------------------------------------------- stingers
def stingers():
    out = {}
    imp = boom(5.0)
    out['st_impact'] = norm_peak(reverb(np.stack([imp, imp]), IR_HUGE, 0.55)[:, : int(6.5 * SR)], -1.5)
    br = braam(3.4)
    out['st_braam'] = norm_peak(reverb(np.stack([br, br]), IR_HALL, 0.4)[:, : int(5.5 * SR)], -1.2)
    hit = metal_hit(3.0, 140, 1.0)
    tk = taiko(1.4, 90, 44, 900)
    hit[: len(tk)] += tk * 0.8
    out['st_hit'] = norm_peak(reverb(np.stack([hit, hit]), IR_HUGE, 0.5)[:, : int(5.0 * SR)], -2.5)
    stab = strings_trem([62, 63, 68, 69, 74], 1.4, 5000, rate=0.1, swell=(0.01, 0.9), depth=0)
    stab = softclip(stab * 6, 1.6)
    out['st_stab'] = norm_peak(reverb(np.stack([stab, stab]), IR_HALL, 0.45)[:, : int(3.5 * SR)], -1.0)
    rs = riser(2.2)
    out['st_riser'] = norm_peak(np.stack([rs, rs * 0.96]), -3.0)
    # the jump scare: shriek + braam + impact, hard and close
    n = int(3.0 * SR)
    sc = np.zeros(n)
    sh = shriek(1.7)
    sc[: len(sh)] += sh * 0.9
    bb = braam(3.0, (33, 34, 45, 46, 52), 3800)
    sc[: len(bb)] += bb * 0.9
    bm = boom(3.0)
    sc[: len(bm)] += bm * 0.8
    sc = softclip(sc * 1.4, 1.6)
    st = reverb(np.stack([sc, sc * 0.97]), IR_ROOM, 0.3)[:, : int(3.6 * SR)]
    out['st_scare'] = norm_peak(st, -0.5)
    w = whisper(2.6, 1.0)
    out['st_whisper'] = norm_peak(reverb(np.stack([w * np.linspace(0.3, 1, len(w)), w * np.linspace(1, 0.3, len(w))]), IR_ROOM, 0.4)[:, : int(3.6 * SR)], -6)
    return out


# ---------------------------------------------------------------- output
def write_mp3(name, x, kbps=128):
    x = np.clip(x, -1, 1)
    pcm = (x.T * 32767).astype('<i2')
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        path = tmp.name
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
    dst = os.path.join(OUT, name + '.mp3')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', path, '-codec:a', 'libmp3lame', '-b:a', f'{kbps}k', dst], check=True)
    os.unlink(path)
    return os.path.getsize(dst)


def main():
    only = sys.argv[2] if len(sys.argv) > 2 else 'all'
    mpath = os.path.join(OUT, 'music_manifest.json')
    if only == 'stingers' and os.path.exists(mpath):
        manifest = json.load(open(mpath)); manifest['stingers'] = []
        for name, x in stingers().items():
            size = write_mp3(name, x, 160)
            manifest['stingers'].append({'id': name, 'file': name + '.mp3', 'seconds': round(x.shape[1] / SR, 3)})
            print(f'{name}: {x.shape[1] / SR:.1f}s, {size / 1024:.0f} KB')
        json.dump(manifest, open(mpath, 'w'), indent=1)
        return
    manifest = {'version': 1, 'note': 'original procedural synthesis (tools/compose_music.py)', 'tracks': [], 'stingers': []}
    for fn in (track_title, track_explore1, track_explore2, track_warning, track_bedroom, track_secret):
        name, loop, L = fn()
        size = write_mp3(name, pad_file(loop, 1.0), 112)
        manifest['tracks'].append({'id': name, 'file': name + '.mp3', 'loopStart': 1.0, 'loopEnd': round(1.0 + L, 6), 'seconds': L})
        print(f'{name}: {L:.1f}s loop, {size / 1024:.0f} KB')
    for name, x in stingers().items():
        size = write_mp3(name, x, 160)
        manifest['stingers'].append({'id': name, 'file': name + '.mp3', 'seconds': round(x.shape[1] / SR, 3)})
        print(f'{name}: {x.shape[1] / SR:.1f}s, {size / 1024:.0f} KB')
    with open(os.path.join(OUT, 'music_manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)


if __name__ == '__main__':
    main()
