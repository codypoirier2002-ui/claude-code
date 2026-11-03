"""Step 4 (inside Blender): render chosen frames small and fast, each stamped with a label.

blender -b build/<slug>/scene.blend -P blender/render_test.py -- \
    --plan build/<slug>/test/plan.json --out build/<slug>/test [--scale 50] [--samples 8]

plan.json is written by pipeline/render.py: [{"frame": 120, "label": "0120 bunker | setup"}].
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

import lib  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser(prog="render_test.py")
ap.add_argument("--plan", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--scale", type=int, default=50)
ap.add_argument("--samples", type=int, default=8)
ap.add_argument("--engine")
args = ap.parse_args(argv)

with open(args.plan) as f:
    plan = json.load(f)

sc = bpy.context.scene
r = sc.render
if args.engine:
    r.engine = lib.engine_id(args.engine)
r.resolution_percentage = args.scale
if r.engine == "CYCLES":
    sc.cycles.samples = args.samples
elif r.engine.startswith("BLENDER_EEVEE"):
    sc.eevee.taa_render_samples = args.samples
r.use_overwrite = True
r.use_placeholder = False

r.use_stamp = True
for flag in ("date", "time", "render_time", "frame", "frame_range", "memory", "hostname",
             "camera", "lens", "scene", "marker", "filename", "sequencer_strip"):
    lib._try(r, f"use_stamp_{flag}", False)
r.use_stamp_note = True
r.stamp_font_size = max(14, int(28 * args.scale / 50))
r.stamp_background = (0, 0, 0, 0.75)

for i, item in enumerate(plan):
    f = item["frame"]
    sc.frame_set(f)
    sc.camera = lib.camera_at(sc, f)
    r.stamp_note_text = item["label"]
    r.filepath = os.path.join(os.path.abspath(args.out), f"test_{i:03d}.png")
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f"[test] {i + 1}/{len(plan)} frame {f}: {time.time() - t0:.2f}s", flush=True)
