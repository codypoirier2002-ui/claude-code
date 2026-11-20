#!/usr/bin/env python3
"""Step 4: tile the stamped test frames into one contact sheet and log the iteration.

The loop: render test frames -> read the sheet -> fix the single worst thing -> repeat.
Each run writes build/<slug>/contact/sheet_NNN.png (and latest.png) and appends an entry
to stories/<slug>/iterations.md, so the history of fixes is checked in with the story.

usage: python3 pipeline/contact_sheet.py <slug> [--cols 6] [--cell 320]
                                              [--note "what was fixed since the last sheet"]
"""
import argparse
import datetime
import json
import math
import os
import shutil

from common import ROOT, build_dir, die, ffmpeg, story_dir

ap = argparse.ArgumentParser()
ap.add_argument("slug")
ap.add_argument("--cols", type=int, default=6)
ap.add_argument("--cell", type=int, default=320, help="cell width in pixels")
ap.add_argument("--note", default="", help="what changed since the previous sheet")
args = ap.parse_args()

test = build_dir(args.slug, "test")
frames = sorted(test.glob("test_*.png"))
if not frames:
    die(f"no test frames in {test}; run: python3 pipeline/render.py {args.slug} test")
contact = build_dir(args.slug, "contact")
n = len(sorted(contact.glob("sheet_*.png"))) + 1
cols = min(args.cols, len(frames))
rows = math.ceil(len(frames) / cols)
sheet = contact / f"sheet_{n:03d}.png"

# Pad to a full grid with black cells so the tile filter always emits exactly one image.
pad = cols * rows - len(frames)
ffmpeg("-framerate", "1", "-start_number", "0", "-i", str(test / "test_%03d.png"),
       "-vf", f"scale={args.cell}:-2:flags=lanczos,tpad=stop={pad}:stop_mode=add:color=black,"
              f"tile={cols}x{rows}:padding=6:margin=6:color=0x111111",
       "-frames:v", "1", "-update", "1", str(sheet))
shutil.copyfile(sheet, contact / "latest.png")

plan_path = test / "plan.json"
plan = json.loads(plan_path.read_text()) if plan_path.exists() else []
log = story_dir(args.slug) / "iterations.md"
if not log.exists():
    log.write_text("# Iterations\n\nOne entry per contact sheet: what was wrong, what changed.\n")
with log.open("a") as f:
    f.write(f"\n## Sheet {n:03d} ({datetime.datetime.now():%Y-%m-%d %H:%M})\n\n")
    f.write(f"- sheet: `{os.path.relpath(sheet, ROOT)}` ({len(frames)} frames, {cols}x{rows})\n")
    if plan:
        f.write("- frames: " + ", ".join(str(p["frame"]) for p in plan) + "\n")
    if args.note:
        f.write(f"- changed since last sheet: {args.note}\n")
    f.write("- worst thing now: _(fill in after reading the sheet)_\n")

print(f"contact sheet: {sheet}")
print(f"latest:        {contact / 'latest.png'}")
print(f"log:           {log}")
