#!/usr/bin/env python3
"""Step 3: build stories/<slug>/scenes.py into build/<slug>/scene.blend with `blender -b`.

usage: python3 pipeline/scenes.py <slug> [--engine EEVEE|CYCLES|WORKBENCH]
"""
import argparse

from common import ROOT, blender_bin, build_dir, run, story_dir, timeline_path

ap = argparse.ArgumentParser()
ap.add_argument("slug")
ap.add_argument("--engine", help="override story.render.engine (CYCLES works without a GPU)")
args = ap.parse_args()

tl = timeline_path(args.slug)
if not tl.exists():
    raise SystemExit(f"{tl} is missing; run step 2 (pipeline/voice.py) first")
out = build_dir(args.slug) / "scene.blend"
cmd = [blender_bin(), "-b", "--factory-startup", "-noaudio", "--python-exit-code", "1",
       "-P", ROOT / "blender" / "build.py", "--",
       "--story-dir", story_dir(args.slug), "--timeline", tl, "--out", out]
if args.engine:
    cmd += ["--engine", args.engine]
run(cmd)
print(f"scene: {out}")
