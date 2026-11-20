"""Shared paths and helpers for every pipeline step.

Layout:
  stories/<slug>/story.json   narration, sources, render + audio settings (checked in)
  stories/<slug>/scenes.py    Blender scene code for this story (checked in)
  build/<slug>/               everything generated (git-ignored)
    voice/                    per-beat clips + narration.wav
    timeline.json             THE timing file every later step reads
    scene.blend               output of step 3
    test/  contact/           step 4 test frames and contact sheets
    frames/                   step 5 final PNG frames
    out/                      captions.ass, picture.mp4, mix.wav, final.mp4, qc.json
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Overridable so tests (and parallel experiments) never touch the real story or build.
STORIES = Path(os.environ.get("STORY_STORIES_DIR", ROOT / "stories"))
BUILD = Path(os.environ.get("STORY_BUILD_DIR", ROOT / "build"))


def story_dir(slug: str) -> Path:
    d = STORIES / slug
    if not (d / "story.json").exists():
        die(f"no story at {d}/story.json")
    return d


def build_dir(slug: str, *parts: str) -> Path:
    d = BUILD / slug
    for p in parts:
        d = d / p
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_story(slug: str) -> dict:
    return json.loads((story_dir(slug) / "story.json").read_text())


def timeline_path(slug: str) -> Path:
    return build_dir(slug) / "timeline.json"


def load_timeline(slug: str) -> dict:
    p = timeline_path(slug)
    if not p.exists():
        die(f"{p} is missing; run step 2 first: python3 pipeline/voice.py {slug}")
    return json.loads(p.read_text())


def die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def run(cmd: list, quiet: bool = False, **kw) -> subprocess.CompletedProcess:
    cmd = [str(c) for c in cmd]
    if not quiet:
        print("$ " + " ".join(cmd if len(cmd) < 14 else cmd[:14] + ["..."]), flush=True)
    return subprocess.run(cmd, check=True, **kw)


def ffmpeg(*args: str, quiet: bool = True) -> subprocess.CompletedProcess:
    need("ffmpeg")
    base = ["ffmpeg", "-hide_banner", "-y"]
    if quiet:
        base += ["-loglevel", "error"]
    return run(base + list(args), quiet=quiet)


def ffprobe_duration(path: Path) -> float:
    need("ffprobe")
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True).stdout.strip()
    return float(out)


def need(binary: str) -> str:
    p = shutil.which(binary)
    if not p:
        die(f"'{binary}' is not on PATH (macOS: brew install {binary})")
    return p


def blender_bin() -> str:
    """$BLENDER, then the macOS app bundle, then `blender` on PATH."""
    env = os.environ.get("BLENDER")
    if env:
        return env
    mac = "/Applications/Blender.app/Contents/MacOS/Blender"
    if Path(mac).exists():
        return mac
    p = shutil.which("blender")
    if not p:
        die("Blender not found. Set BLENDER=/path/to/blender or install it to /Applications.")
    return p


def frame_to_s(frame: int, fps: int) -> float:
    return frame / fps


def s_to_frame(seconds: float, fps: int) -> int:
    return int(round(seconds * fps))


def words(text: str) -> list[str]:
    """Spoken words as displayed (punctuation kept), split on whitespace."""
    return text.split()


def norm(word: str) -> str:
    """Comparable form of a word: lowercase, letters/digits/apostrophes only."""
    return "".join(c for c in word.lower() if c.isalnum() or c == "'").strip("'")
