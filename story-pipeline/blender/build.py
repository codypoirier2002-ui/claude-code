"""Step 3 (inside Blender): build the whole story into one .blend from the timeline.

blender -b -P blender/build.py -- --story-dir stories/<slug> \
    --timeline build/<slug>/timeline.json --out build/<slug>/scene.blend [--engine CYCLES]

Run it through pipeline/scenes.py, which finds Blender and fills in the paths.
"""
import argparse
import importlib.util
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

import lib  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser(prog="build.py")
ap.add_argument("--story-dir", required=True)
ap.add_argument("--timeline", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--engine")
args = ap.parse_args(argv)

t0 = time.time()
with open(args.timeline) as f:
    tl = json.load(f)
with open(os.path.join(args.story_dir, "story.json")) as f:
    story = json.load(f)

render = dict(story.get("render", {}))
if args.engine:
    render["engine"] = args.engine
lib.setup_scene(tl, render)

spec = importlib.util.spec_from_file_location("story_scenes", os.path.join(args.story_dir, "scenes.py"))
scenes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scenes)

ctx = lib.Ctx(tl, story)
scenes.build(ctx)
ctx.finalize()

bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))
sc = bpy.context.scene
print(f"[build] {len(bpy.data.objects)} objects, {len(sc.timeline_markers)} shots, "
      f"frames {sc.frame_start}-{sc.frame_end}, engine {sc.render.engine}, "
      f"{time.time() - t0:.1f}s -> {args.out}")
