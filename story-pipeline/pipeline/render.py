#!/usr/bin/env python3
"""Steps 4 and 5: test frames for the contact-sheet loop, and the resumable final render.

  test   Render a few frames per shot (plus cue moments and the loop seam) at reduced
         size and samples, stamp each with frame/shot/beat, then build a contact sheet.
         python3 pipeline/render.py <slug> test [--shot bunker --shot glint] [--frames 300,301]
                                                 [--per-shot 3] [--scale 50] [--samples 8]

  final  Render every missing frame of the timeline to build/<slug>/frames/frame_####.png.
         Safe to stop and re-run: finished frames are skipped, half-written ones (0 bytes)
         are redone, and Blender restarts every --chunk frames so memory cannot creep
         across a ~1,300-frame EEVEE run. Prints per-frame time, average and ETA, and logs
         them to build/<slug>/frames/render_log.csv.
         python3 pipeline/render.py <slug> final [--start 0 --end 1226] [--chunk 150]
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from common import ROOT, blender_bin, build_dir, die, load_story, load_timeline


def beat_at(tl: dict, frame: int) -> dict | None:
    best = None
    for b in tl["beats"]:
        if b["start_frame"] <= frame:
            best = b
    return best


def label(tl: dict, frame: int) -> str:
    shot = next(s for s in tl["shots"] if s["start_frame"] <= frame <= s["end_frame"])
    b = beat_at(tl, frame)
    spoken = ""
    if b:
        said = [w["text"] for w in b["words"] if w["start_frame"] <= frame]
        spoken = " ".join(said[-4:]) if said else "(before line)"
    return f"{frame:04d}  {shot['id']}  |  {b['id'] if b else '-'}: {spoken}"[:80]


def plan_frames(tl: dict, shots: list[str], extra: list[int], per_shot: int) -> list[int]:
    total, frames = tl["total_frames"], set(extra)
    pick = [s for s in tl["shots"] if not shots or s["id"] in shots]
    for s in pick:
        a, b = s["start_frame"], s["end_frame"]
        n = max(per_shot, 1)
        for k in range(n):
            frames.add(round(a + 3 + (b - a - 6) * k / max(n - 1, 1)) if n > 1 else (a + b) // 2)
        for f in tl["cues"].values():          # just after each cue, to see the event land
            if a <= f + 4 <= b:
                frames.add(f + 4)
    if tl.get("loop", {}).get("enabled") and not shots:
        frames |= {0, total - 1}               # the loop seam, side by side
    return sorted(f for f in frames if 0 <= f < total)


def cmd_test(args, tl, story):
    blend = build_dir(args.slug) / "scene.blend"
    if not blend.exists():
        die(f"{blend} is missing; run step 3 (pipeline/scenes.py) first")
    out = build_dir(args.slug, "test")
    for old in out.glob("test_*.png"):
        old.unlink()
    extra = [int(x) for x in ",".join(args.frames).split(",") if x.strip()] if args.frames else []
    frames = plan_frames(tl, args.shot or [], extra, args.per_shot)
    plan = [{"frame": f, "label": label(tl, f)} for f in frames]
    (out / "plan.json").write_text(json.dumps(plan, indent=1))
    r = story["render"]
    cmd = [blender_bin(), "-b", "--factory-startup", "-noaudio", "--python-exit-code", "1", blend,
           "-P", ROOT / "blender" / "render_test.py", "--", "--plan", out / "plan.json", "--out", out,
           "--scale", args.scale or r.get("test_scale", 50),
           "--samples", args.samples or r.get("test_samples", 8)]
    if args.engine:
        cmd += ["--engine", args.engine]
    t0 = time.time()
    subprocess.run([str(c) for c in cmd], check=True)
    empty = [p.name for p in sorted(out.glob("test_*.png")) if p.stat().st_size == 0]
    if empty or len(list(out.glob("test_*.png"))) < len(frames):
        die(f"{len(empty) or 'some'} test frames came out empty or missing. EEVEE needs a GPU; "
            "on a machine without one, add --engine CYCLES")
    print(f"{len(frames)} test frames in {time.time() - t0:.0f}s")
    subprocess.run([sys.executable, str(Path(__file__).with_name("contact_sheet.py")), args.slug],
                   check=True)


SAVED = re.compile(r"Saved: '?(.+?frame_(\d+)\.png)'?")
TIME = re.compile(r"Time: (?:(\d+):)?(\d+):(\d+(?:\.\d+)?)")


def missing_ranges(frames_dir: Path, start: int, end: int) -> list[tuple[int, int]]:
    todo = []
    for f in range(start, end + 1):
        p = frames_dir / f"frame_{f:04d}.png"
        if p.exists() and p.stat().st_size == 0:
            p.unlink()                         # placeholder from a crash: redo it
        if not p.exists():
            todo.append(f)
    ranges = []
    for f in todo:
        if ranges and ranges[-1][1] == f - 1:
            ranges[-1][1] = f
        else:
            ranges.append([f, f])
    return [tuple(r) for r in ranges]


def split(ranges, chunk):
    for a, b in ranges:
        while a <= b:
            yield a, min(a + chunk - 1, b)
            a += chunk


def cmd_final(args, tl, story):
    blend = build_dir(args.slug) / "scene.blend"
    if not blend.exists():
        die(f"{blend} is missing; run step 3 (pipeline/scenes.py) first")
    frames_dir = build_dir(args.slug, "frames")
    total = tl["total_frames"]
    start = args.start if args.start is not None else 0
    end = args.end if args.end is not None else total - 1
    todo = missing_ranges(frames_dir, start, end)
    n_todo = sum(b - a + 1 for a, b in todo)
    if not n_todo:
        print(f"all frames {start}-{end} already rendered in {frames_dir}")
        return
    chunk = args.chunk or story["render"].get("chunk", 150)
    print(f"rendering {n_todo} frames ({start}-{end}, {total} in timeline) in chunks of {chunk}")
    free_gb = shutil.disk_usage(frames_dir).free / 1e9
    if free_gb < 5:
        print(f"warning: only {free_gb:.1f} GB free; 1080x1920 PNGs are ~2-4 MB each")

    log = frames_dir / "render_log.csv"
    new_log = not log.exists()
    done, t_sum, t_start = 0, 0.0, time.time()
    with log.open("a") as lf:
        if new_log:
            lf.write("frame,seconds\n")
        for a, b in split(todo, chunk):
            cmd = [blender_bin(), "-b", "--factory-startup", "-noaudio", blend,
                   "-o", frames_dir / "frame_####", "-F", "PNG", "-x", "1",
                   "-s", a, "-e", b, "-a"]
            proc = subprocess.Popen([str(c) for c in cmd], stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, bufsize=1)
            last_saved, last_t = None, time.time()
            for line in proc.stdout:
                if args.verbose:
                    print(line, end="")
                m = SAVED.search(line)
                if m:
                    last_saved = int(m.group(2))
                    continue
                m = TIME.search(line)
                if m and last_saved is not None:
                    h, mi, s = m.groups()
                    secs = int(h or 0) * 3600 + int(mi) * 60 + float(s)
                    now = time.time()
                    secs = secs or (now - last_t)
                    last_t = now
                    done += 1
                    t_sum += secs
                    avg = t_sum / done
                    eta = (n_todo - done) * (time.time() - t_start) / done
                    lf.write(f"{last_saved},{secs:.2f}\n")
                    lf.flush()
                    print(f"frame {last_saved:04d}  {secs:5.2f}s  avg {avg:4.2f}s  "
                          f"{done}/{n_todo}  ETA {eta / 60:5.1f} min", flush=True)
                    last_saved = None
                elif "Error" in line or "Traceback" in line:
                    print(line, end="", file=sys.stderr)
            if proc.wait() != 0:
                die(f"Blender exited with {proc.returncode} in chunk {a}-{b}; re-run to resume")
    left = missing_ranges(frames_dir, start, end)
    if left:
        die(f"frames still missing: {left[:5]}...; re-run to resume")
    wall = time.time() - t_start
    print(f"done: {n_todo} frames in {wall / 60:.1f} min (avg {wall / n_todo:.2f}s/frame wall)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("mode", choices=["test", "final"])
    ap.add_argument("--shot", action="append", help="test: only these shots (repeatable)")
    ap.add_argument("--frames", action="append", help="test: extra frames, comma separated")
    ap.add_argument("--per-shot", type=int, default=3)
    ap.add_argument("--scale", type=int)
    ap.add_argument("--samples", type=int)
    ap.add_argument("--engine", help="test: override the engine (EEVEE, CYCLES, WORKBENCH). "
                    "For final, rebuild with pipeline/scenes.py --engine instead")
    ap.add_argument("--start", type=int)
    ap.add_argument("--end", type=int)
    ap.add_argument("--chunk", type=int)
    ap.add_argument("--verbose", action="store_true", help="final: show Blender's output")
    args = ap.parse_args()
    tl, story = load_timeline(args.slug), load_story(args.slug)
    (cmd_test if args.mode == "test" else cmd_final)(args, tl, story)


if __name__ == "__main__":
    main()
