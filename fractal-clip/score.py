"""score.py: the 7-second soundtrack, synthesized from math (numpy only).

Synced to the camera move in bulb.cpp:
  * an open D chord (sus2 -> major) whose brightness opens as the zoom deepens
  * a filtered-noise "dive" whose pitch and level follow the zoom speed
  * bell-like glints from a D-major pentatonic, denser as more detail appears
  * a sub swell, then everything through a synthesized stereo convolution reverb
Usage: python3 score.py out.wav
"""
import sys
import wave

import numpy as np

SR = 48000
T = 7.0
N = int(SR * T)
t = np.arange(N) / SR
rng = np.random.default_rng(8)


def smootherstep(x):
    x = np.clip(x, 0, 1)
    return x * x * x * (x * (x * 6 - 15) + 10)


u = t / T
zoom = 0.3 * u + 0.7 * smootherstep(u)              # 0..1 progress in log-zoom (same as the camera)
speed = 0.3 + 0.7 * 30 * u**2 * (1 - u) ** 2        # d(zoom)/du, peaks mid-dive
speed_n = speed / speed.max()


def env_fade(t0, t1, shape=2.0):
    x = np.clip((t - t0) / (t1 - t0), 0, 1)
    return x**shape


def lowpass_gain(f, fc, order=2):
    return 1.0 / np.sqrt(1.0 + (f / fc) ** (2 * order))


def voice(f0, amp, start, ramp, cutoff, detune_cents=5.0, nharm=24):
    """Detuned additive saw-ish voice with a time-varying low-pass via per-partial gains."""
    out = np.zeros((2, N))
    e = env_fade(start, start + ramp, 1.6) * amp
    for ch in range(2):
        for d in (-detune_cents, 0.0, detune_cents):
            dc = d + (2.0 if ch else -2.0) * (d == 0)
            f = f0 * 2 ** (dc / 1200)
            ph0 = rng.uniform(0, 2 * np.pi)
            # slow vibrato keeps the pad alive
            vib = 1 + 0.0012 * np.sin(2 * np.pi * rng.uniform(0.15, 0.3) * t + rng.uniform(0, 6.28))
            phase = 2 * np.pi * np.cumsum(f * vib) / SR + ph0
            for n in range(1, nharm + 1):
                fn = f * n
                if fn > 16000:
                    break
                g = lowpass_gain(fn, cutoff) / n**1.15
                out[ch] += g * np.sin(n * phase + rng.uniform(0, 6.28))
    return out * e / 3.0


# ---- pad: D2 A2 D3 E3 A3, then F#4 A4 E5 bloom in (sus2 -> D major add9)
cutoff = 260 + 2600 * zoom**1.3
pad = np.zeros((2, N))
for f0, a, st in [(73.42, 0.55, 0.0), (110.0, 0.42, 0.1), (146.83, 0.32, 0.25), (164.81, 0.20, 0.5), (220.0, 0.22, 0.4)]:
    pad += voice(f0, a, st, 1.6, cutoff)
for f0, a, st in [(369.99, 0.12, 2.6), (440.0, 0.10, 3.0), (659.26, 0.06, 3.6)]:
    pad += voice(f0, a, st, 1.4, cutoff, nharm=10)
pad *= 0.85 + 0.25 * speed_n

# ---- sub swell
sub = np.sin(2 * np.pi * 36.71 * t) * (0.25 * env_fade(0.0, 1.5) + 0.35 * speed_n**2)
sub = np.vstack([sub, sub])

# ---- dive: STFT-shaped noise, band-pass centre rides the zoom
hop, win = 512, 2048
w = np.hanning(win)
freqs = np.fft.rfftfreq(win, 1 / SR)
dive = np.zeros((2, N + win))
for ch in range(2):
    for i in range(0, N, hop):
        z = zoom[min(i, N - 1)]
        sp = speed_n[min(i, N - 1)]
        fc = 220 * (3200 / 220) ** z
        band = np.exp(-0.5 * (np.log2(np.maximum(freqs, 1) / fc) / 0.75) ** 2)
        air = 0.10 * np.exp(-0.5 * (np.log2(np.maximum(freqs, 1) / (fc * 3.2)) / 0.5) ** 2)
        mag = (band + air) * sp**1.6
        spec = mag * np.exp(1j * rng.uniform(0, 2 * np.pi, len(freqs)))
        dive[ch, i:i + win] += np.fft.irfft(spec, win) * w
dive = dive[:, :N]
dive /= np.abs(dive).max() + 1e-9
dive *= 0.30

# ---- glints: bell partials on a D-major pentatonic, density follows the dive
scale = [587.33, 659.26, 739.99, 880.0, 987.77, 1174.66, 1318.51, 1479.98, 1760.0]
glint = np.zeros((2, N))
tt = 1.2
while tt < T - 0.3:
    z = np.interp(tt, t, zoom)
    f = scale[rng.integers(0, len(scale))]
    amp = 0.035 * (0.4 + z) * rng.uniform(0.5, 1.0)
    dur = rng.uniform(0.7, 1.4)
    i0 = int(tt * SR)
    n = min(N - i0, int(dur * 1.6 * SR))
    tl = np.arange(n) / SR
    tone = np.zeros(n)
    for ratio, ga, dk in [(1.0, 1.0, 1.0), (2.76, 0.35, 1.8), (5.40, 0.15, 3.0)]:
        tone += ga * np.sin(2 * np.pi * f * ratio * tl) * np.exp(-tl * dk * 3.2 / dur)
    tone *= np.minimum(1, tl / 0.004)
    pan = rng.uniform(0.15, 0.85)
    glint[0, i0:i0 + n] += tone * amp * np.sqrt(1 - pan)
    glint[1, i0:i0 + n] += tone * amp * np.sqrt(pan)
    tt += rng.exponential(0.42 / (0.35 + 1.6 * z))

# ---- synthesized stereo convolution reverb (decaying, darkening noise)
rt = 3.2
ir_len = int(rt * SR)
tl = np.arange(ir_len) / SR
ir = np.zeros((2, ir_len))
for ch in range(2):
    nz = rng.standard_normal(ir_len) * np.exp(-6.9 * tl / rt)
    spec = np.fft.rfft(nz)
    fr = np.fft.rfftfreq(ir_len, 1 / SR)
    spec *= 1 / np.sqrt(1 + (fr / 4500) ** 2)
    ir[ch] = np.fft.irfft(spec, ir_len)
    ir[ch, : int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))  # pre-delay softening
    ir[ch] /= np.sqrt(np.sum(ir[ch] ** 2))


def reverb(x):
    L = N + ir_len
    nfft = 1 << (L - 1).bit_length()
    y = np.zeros((2, N))
    for ch in range(2):
        y[ch] = np.fft.irfft(np.fft.rfft(x[ch], nfft) * np.fft.rfft(ir[ch], nfft), nfft)[:N]
    return y


dry = pad * 0.55 + sub * 0.32 + dive * 0.45 + glint * 1.5
wet = reverb(pad * 0.35 + glint * 2.2 + dive * 0.25)
mix = dry + wet * 0.55

# match the picture: fade in with the image, out over the last half second
mix *= env_fade(0.0, 0.9, 1.5) * (1 - env_fade(T - 0.55, T, 1.2))
mix = np.tanh(mix / (np.abs(mix).max() + 1e-9) * 1.1) / np.tanh(1.1)
mix *= 10 ** (-6.5 / 20)  # ~ -16 LUFS integrated, lots of headroom

pcm = mix.T + (rng.random((N, 2)) - rng.random((N, 2))) / 32768.0  # TPDF dither
pcm = np.clip(np.round(pcm * 32767), -32768, 32767).astype("<i2")
with wave.open(sys.argv[1] if len(sys.argv) > 1 else "score.wav", "wb") as f:
    f.setnchannels(2)
    f.setsampwidth(2)
    f.setframerate(SR)
    f.writeframes(pcm.tobytes())
print("wrote", N / SR, "s")
