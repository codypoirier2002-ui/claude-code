"""Real-Blender checks for a story build. Run by tests/smoke.py when Blender is installed.

blender -b --factory-startup -P tests/blender_check.py -- --story-dir stories/<slug> \
    --timeline build/<slug>/timeline.json

Builds the story in-process (same steps as blender/build.py), then asserts:
  1. lib.key really writes CONSTANT / LINEAR interpolation (Blender ignores the user
     preference for Python-inserted keys; this once made cue-gated elements fade in
     from frame 0).
  2. Every show_during() object is hidden the frame before each range and visible at
     its first frame (set visibility once overrode per-object visibility).
  3. Loop seam: the active camera's world matrix and lens at frame total_frames equal
     those at frame 0.
Exits 1 on the first failure.
"""
import argparse
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "blender"))

import bpy  # noqa: E402

import lib  # noqa: E402


def fail(msg):
    print(f"[blender_check] FAIL: {msg}")
    sys.exit(1)


argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--story-dir", required=True)
ap.add_argument("--timeline", required=True)
args = ap.parse_args(argv)
with open(args.timeline) as f:
    tl = json.load(f)
with open(os.path.join(args.story_dir, "story.json")) as f:
    story = json.load(f)

lib.setup_scene(tl, story.get("render", {}))

# 1. interpolation is written onto the key
probe = lib.empty("interp_probe")
lib.key(probe, "location", 0, 0.0, "CONSTANT", index=2)
lib.key(probe, "location", 10, 1.0, "LINEAR", index=2)
probe.location[2] = 5.0
bpy.context.scene.frame_set(5)
if abs(probe.location[2]) > 1e-6:
    fail(f"CONSTANT key interpolated: z at frame 5 is {probe.location[2]:.3f}, expected 0")
interps = [kp.interpolation for fc in lib._fcurves(probe) for kp in fc.keyframe_points]
if interps != ["CONSTANT", "LINEAR"]:
    fail(f"keys have interpolation {interps}, expected ['CONSTANT', 'LINEAR']")
bpy.data.objects.remove(probe)

spec = importlib.util.spec_from_file_location("story_scenes", os.path.join(args.story_dir, "scenes.py"))
scenes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scenes)
shown = {}
_orig = lib.show_during


def _record(objs, ranges):
    for o in objs:
        shown[o.name] = sorted(ranges)
    _orig(objs, ranges)


lib.show_during = _record
ctx = lib.Ctx(tl, story)
scenes.build(ctx)
ctx.finalize()
sc = bpy.context.scene

# 2. per-object visibility survives the set visibility pass
set_ranges = {o.name: r for coll, r in ctx._sets for o in coll.all_objects}
for name, ranges in shown.items():
    o = bpy.data.objects[name]
    eff = lib._intersect(ranges, set_ranges[name]) if name in set_ranges else ranges
    for a, b in eff:
        sc.frame_set(a)
        if o.hide_render:
            fail(f"{name} hidden at frame {a}, the start of its range {a}-{b}")
        if a > 0 and not any(s <= a - 1 <= e for s, e in eff):
            sc.frame_set(a - 1)
            if not o.hide_render:
                fail(f"{name} visible at frame {a - 1}, before its range {a}-{b}")

# 3. loop seam
if tl.get("loop", {}).get("enabled"):
    total = tl["total_frames"]
    sc.frame_set(0)
    cam0 = lib.camera_at(sc, 0)
    m0, lens0 = cam0.matrix_world.copy(), cam0.data.lens
    sc.frame_set(total)
    cam1 = lib.camera_at(sc, total)
    m1, lens1 = cam1.matrix_world.copy(), cam1.data.lens
    diff = max(abs(m0[i][j] - m1[i][j]) for i in range(4) for j in range(4))
    if diff > 1e-4 or abs(lens0 - lens1) > 1e-6:
        fail(f"loop seam: camera at frame {total} ({cam1.name}) differs from frame 0 "
             f"({cam0.name}) by {diff:.5f}")

print(f"[blender_check] OK: interpolation, {len(shown)} cue-gated objects, loop seam "
      f"({len(bpy.data.objects)} objects, Blender {bpy.app.version_string})")
