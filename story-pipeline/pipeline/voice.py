#!/usr/bin/env python3
"""Step 2: generate the narration, then write build/<slug>/timeline.json.

Every later step (Blender scenes, test frames, captions, mix, QC) reads timing ONLY from
timeline.json, so changing a line of narration means re-running this step and nothing
else has hard-coded seconds to fix.

Each beat is synthesized as its own clip, trimmed to its speech, and placed with the
story's pacing (lead_in, gap, tail). That makes beat boundaries exact. Inside a beat,
word timings come from the backend when it provides them (ElevenLabs alignment) or are
estimated from the pauses in the audio.

Backends (story.voice.backend, or --backend):
  elevenlabs  ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID (or voice.elevenlabs_voice_id).
              Exact per-character timestamps. Costs credits, so clips are cached.
  say         macOS built-in `say`. Free, offline.
  piper       Local Piper, sharing the tiktok-science-video skill's install
              (run .claude/skills/tiktok-science-video/scripts/setup.sh once).
  dummy       A synthetic buzz with exact word timings. For testing the pipeline only.

usage: python3 pipeline/voice.py <slug> [--backend say] [--force]
"""
from __future__ import annotations

import argparse
import array
import base64
import hashlib
import json
import math
import os
import random
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import wave
from pathlib import Path

from common import (build_dir, die, ffmpeg, load_story, norm, run, s_to_frame,
                    timeline_path, words)

SR = 48000
PUNCT_BREAK = (",", ".", ";", ":", "!", "?", "—")


# ---------------------------------------------------------------- audio io

def read_pcm(path: Path) -> array.array:
    with wave.open(str(path), "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != SR:
            die(f"{path} is not mono 16-bit {SR} Hz")
        data = array.array("h")
        data.frombytes(w.readframes(w.getnframes()))
    if sys.byteorder == "big":
        data.byteswap()
    return data


def write_pcm(path: Path, samples: array.array) -> None:
    out = samples
    if sys.byteorder == "big":
        out = array.array("h", samples)
        out.byteswap()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(out.tobytes())


def to_wav(src: Path, dst: Path) -> None:
    ffmpeg("-i", str(src), "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", str(dst))


# ---------------------------------------------------------------- backends
# Each returns a mono 48 kHz wav and, when the backend knows them, word timings
# [{"text", "start", "end"}] in seconds relative to the clip.

def tts_elevenlabs(text: str, out: Path, cfg: dict, prev_text: str, next_text: str):
    key = os.environ.get("ELEVENLABS_API_KEY")
    voice = os.environ.get("ELEVENLABS_VOICE_ID") or cfg.get("elevenlabs_voice_id")
    if not key:
        die("ELEVENLABS_API_KEY is not set (or use --backend say/piper)")
    if not voice:
        die("set ELEVENLABS_VOICE_ID or voice.elevenlabs_voice_id in story.json "
            "(list your voices at https://elevenlabs.io/app/voice-library)")
    body = {"text": text, "model_id": cfg.get("elevenlabs_model", "eleven_multilingual_v2")}
    # Neighbouring text keeps intonation continuous across separately generated beats.
    if prev_text:
        body["previous_text"] = prev_text
    if next_text:
        body["next_text"] = next_text
    if cfg.get("elevenlabs_settings"):
        body["voice_settings"] = cfg["elevenlabs_settings"]
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps"
        "?output_format=mp3_44100_128",
        data=json.dumps(body).encode(), method="POST",
        headers={"xi-api-key": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            resp = json.loads(r.read())
    except urllib.error.HTTPError as e:
        die(f"ElevenLabs HTTP {e.code}: {e.read()[:300]!r}")
    mp3 = out.with_suffix(".mp3")
    mp3.write_bytes(base64.b64decode(resp["audio_base64"]))
    to_wav(mp3, out)
    mp3.unlink()
    al = resp.get("alignment") or {}
    return out, words_from_alignment(al)


def words_from_alignment(al: dict):
    chars = al.get("characters") or []
    starts = al.get("character_start_times_seconds") or []
    ends = al.get("character_end_times_seconds") or []
    found, cur = [], None
    for ch, s, e in zip(chars, starts, ends):
        if ch.isspace():
            if cur:
                found.append(cur)
            cur = None
        elif cur is None:
            cur = {"text": ch, "start": s, "end": e}
        else:
            cur["text"] += ch
            cur["end"] = e
    if cur:
        found.append(cur)
    return found or None


def tts_say(text: str, out: Path, cfg: dict, *_):
    if not shutil.which("say"):
        die("`say` only exists on macOS; use --backend piper or elevenlabs")
    aiff = out.with_suffix(".aiff")
    run(["say", "-v", cfg.get("say_voice", "Daniel"), "-r", str(cfg.get("say_rate", 175)),
         "-o", aiff, text], quiet=True)
    to_wav(aiff, out)
    aiff.unlink()
    return out, None


def tts_piper(text: str, out: Path, cfg: dict, *_):
    cache = Path(os.environ.get("TIKTOK_CACHE_DIR", Path.home() / ".cache" / "tiktok-science"))
    py = os.environ.get("TTS_PYTHON", str(cache / "venv" / "bin" / "python"))
    model = os.environ.get("TTS_MODEL", str(cache / "voices" / "en_US-lessac-medium.onnx"))
    if not (Path(py).exists() and Path(model).exists()):
        die("Piper is not set up. Run .claude/skills/tiktok-science-video/scripts/setup.sh "
            "once, or set TTS_PYTHON and TTS_MODEL.")
    raw = out.with_name(out.stem + ".raw.wav")
    subprocess.run([py, "-m", "piper", "-m", model, "-f", str(raw)], input=text.encode(),
                   check=True, stdout=subprocess.DEVNULL)
    to_wav(raw, out)
    raw.unlink()
    return out, None


def tts_dummy(text: str, out: Path, *_):
    """Deterministic speech-like buzz: one voiced burst per word, pauses at punctuation."""
    rng = random.Random(text)
    samples, found, t = array.array("h"), [], 0.15
    samples.extend([0] * int(t * SR))
    for tok in words(text):
        dur = 0.07 + 0.045 * max(len(norm(tok)), 1)
        n = int(dur * SR)
        f0 = 105 + rng.random() * 40
        for i in range(n):
            x = i / SR
            env = math.sin(math.pi * i / n) ** 0.6 * (0.55 + 0.45 * math.sin(2 * math.pi * 4.5 * x) ** 2)
            v = (math.sin(2 * math.pi * f0 * x) + 0.5 * math.sin(4 * math.pi * f0 * x)
                 + 0.25 * math.sin(6 * math.pi * f0 * x))
            samples.append(int(7000 * env * v))
        found.append({"text": tok, "start": t, "end": t + dur})
        t += dur
        gap = 0.35 if tok.endswith((".", "!", "?")) else 0.2 if tok.endswith(PUNCT_BREAK) else 0.06
        samples.extend([0] * int(gap * SR))
        t += gap
    samples.extend([0] * int(0.2 * SR))
    write_pcm(out, samples)
    return out, found


BACKENDS = {"elevenlabs": tts_elevenlabs, "say": tts_say, "piper": tts_piper, "dummy": tts_dummy}


# ---------------------------------------------------------------- analysis

def envelope(samples: array.array, win: float = 0.01) -> list[float]:
    n = int(win * SR)
    env = []
    for i in range(0, len(samples), n):
        chunk = samples[i:i + n]
        env.append(math.sqrt(sum(s * s for s in chunk) / max(len(chunk), 1)) / 32768)
    return env


def speech_segments(samples: array.array, win: float = 0.01) -> list[tuple[float, float]]:
    """Runs of speech, merged across gaps shorter than 150 ms."""
    env = envelope(samples, win)
    if not env:
        return []
    peak = max(env) or 1e-9
    thr = max(10 ** (-48 / 20), peak * 10 ** (-32 / 20))
    segs, start = [], None
    for i, v in enumerate(env + [0.0]):
        if v > thr and start is None:
            start = i
        elif v <= thr and start is not None:
            segs.append([start * win, i * win])
            start = None
    merged = []
    for s in segs:
        if merged and s[0] - merged[-1][1] < 0.15:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    return [(a, b) for a, b in merged if b - a >= 0.06]


def estimate_words(tokens: list[str], segs: list[tuple[float, float]]):
    """Spread words over the speech, one phrase per detected segment when they line up."""
    phrases, cur = [], []
    for t in tokens:
        cur.append(t)
        if t.endswith(PUNCT_BREAK):
            phrases.append(cur)
            cur = []
    if cur:
        phrases.append(cur)

    def spread(toks, a, b):
        weights = [max(len(norm(t)), 1) + 2 for t in toks]
        total, t, res = sum(weights), a, []
        for tok, w in zip(toks, weights):
            d = (b - a) * w / total
            res.append({"text": tok, "start": t, "end": t + d})
            t += d
        return res

    if len(segs) == len(phrases):
        out = []
        for p, (a, b) in zip(phrases, segs):
            out += spread(p, a, b)
        return out
    return spread(tokens, segs[0][0], segs[-1][1])


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--backend")
    ap.add_argument("--force", action="store_true", help="ignore cached clips")
    args = ap.parse_args()

    story = load_story(args.slug)
    vcfg = story.get("voice", {})
    backend = args.backend or vcfg.get("backend", "piper")
    if backend not in BACKENDS:
        die(f"unknown backend {backend!r}; choose from {', '.join(BACKENDS)}")
    fps = story["render"]["fps"]
    if SR % fps:
        die(f"fps {fps} must divide {SR}")
    pace = story.get("pacing", {})
    lead, gap, tail = pace.get("lead_in", 0.5), pace.get("gap", 0.3), pace.get("tail", 0.9)
    cut_lead = pace.get("cut_lead", 0.1)
    vdir = build_dir(args.slug, "voice")
    cache = build_dir(args.slug, "voice", "cache")
    beats = story["beats"]

    narration = array.array("h", [0] * int(lead * SR))
    tl_beats = []
    for i, b in enumerate(beats):
        text = b["text"]
        voice_key = vcfg.get("elevenlabs_voice_id") or os.environ.get("ELEVENLABS_VOICE_ID", "")
        if backend == "say":
            voice_key = f"{vcfg.get('say_voice')}@{vcfg.get('say_rate')}"
        h = hashlib.sha1(f"{backend}|{voice_key}|{vcfg.get('elevenlabs_model')}|{text}".encode()).hexdigest()[:16]
        clip, meta = cache / f"{h}.wav", cache / f"{h}.json"
        if args.force or not (clip.exists() and meta.exists()):
            prev_text = beats[i - 1]["text"] if i else ""
            next_text = beats[i + 1]["text"] if i + 1 < len(beats) else ""
            print(f"[{backend}] {b['id']}: {text}", flush=True)
            _, wtimes = BACKENDS[backend](text, clip, vcfg, prev_text, next_text)
            meta.write_text(json.dumps({"words": wtimes}))
        else:
            print(f"[cached] {b['id']}", flush=True)
        samples = read_pcm(clip)
        wtimes = json.loads(meta.read_text())["words"]

        segs = speech_segments(samples)
        if not segs:
            die(f"beat {b['id']}: the clip is silent")
        a = max(segs[0][0] - 0.03, 0.0)
        z = min(segs[-1][1] + 0.06, len(samples) / SR)
        trimmed = samples[int(a * SR):int(z * SR)]
        write_pcm(vdir / f"{i:02d}_{b['id']}.wav", trimmed)

        tokens = words(text)
        if wtimes and len(wtimes) == len(tokens):
            wl = [{"text": tok, "start": w["start"] - a, "end": w["end"] - a}
                  for tok, w in zip(tokens, wtimes)]
            source = "backend"
        else:
            wl = estimate_words(tokens, [(s - a, e - a) for s, e in segs])
            source = "estimated"

        offset = len(narration) / SR
        narration.extend(trimmed)
        dur = len(trimmed) / SR
        for w in wl:
            w["start"] = round(offset + max(w["start"], 0.0), 3)
            w["end"] = round(offset + min(w["end"], dur), 3)
            w["start_frame"] = s_to_frame(w["start"], fps)
            w["end_frame"] = max(s_to_frame(w["end"], fps), w["start_frame"] + 1)
        tl_beats.append({
            "id": b["id"], "shot": b["shot"], "text": text,
            "start": round(offset, 3), "end": round(offset + dur, 3),
            "start_frame": s_to_frame(offset, fps), "end_frame": s_to_frame(offset + dur, fps),
            "word_timing": source, "words": wl,
        })
        narration.extend([0] * int((gap if i + 1 < len(beats) else tail) * SR))

    # Pad to a whole number of frames so audio and video lengths agree exactly.
    spf = SR // fps
    total_frames = math.ceil(len(narration) / spf)
    narration.extend([0] * (total_frames * spf - len(narration)))
    write_pcm(vdir / "narration.wav", narration)

    cues = {}
    for b, tb in zip(beats, tl_beats):
        for c in b.get("cues", []):
            match = next((w for w in tb["words"] if norm(w["text"]) == norm(c["word"])), None)
            if match is None:
                die(f"cue {c['name']}: word {c['word']!r} not found in beat {b['id']}")
            cues[c["name"]] = match["start_frame"] + int(c.get("offset", 0))

    shots = []
    for tb in tl_beats:
        if shots and shots[-1]["id"] == tb["shot"]:
            shots[-1]["beats"].append(tb["id"])
            continue
        start = 0 if not shots else max(tb["start_frame"] - s_to_frame(cut_lead, fps),
                                        shots[-1]["start_frame"] + 1)
        shots.append({"id": tb["shot"], "start_frame": start, "beats": [tb["id"]]})
    for i, s in enumerate(shots):
        s["end_frame"] = (shots[i + 1]["start_frame"] - 1) if i + 1 < len(shots) else total_frames - 1
        s["frames"] = s["end_frame"] - s["start_frame"] + 1

    r = story["render"]
    timeline = {
        "story": args.slug, "title": story.get("title"),
        "fps": fps, "width": r["width"], "height": r["height"],
        "total_frames": total_frames, "duration": total_frames / fps,
        "audio": {"narration": str((vdir / "narration.wav").relative_to(build_dir(args.slug))),
                  "sample_rate": SR, "backend": backend},
        "loop": story.get("loop", {"enabled": False}),
        "beats": tl_beats, "shots": shots, "cues": cues,
    }
    timeline_path(args.slug).write_text(json.dumps(timeline, indent=1))

    print(f"\ntimeline: {total_frames} frames = {total_frames / fps:.2f}s @ {fps} fps "
          f"-> {timeline_path(args.slug)}")
    for s in shots:
        print(f"  {s['id']:<10} frames {s['start_frame']:>5}-{s['end_frame']:<5} "
              f"({s['frames'] / fps:5.2f}s)  {', '.join(s['beats'])}")
    print("  cues: " + ", ".join(f"{k}@{v}" for k, v in cues.items()))
    n_words = sum(len(b["words"]) for b in tl_beats)
    print(f"  {n_words} words in {total_frames / fps:.1f}s = {n_words / (total_frames / fps):.2f} words/s")


if __name__ == "__main__":
    main()
