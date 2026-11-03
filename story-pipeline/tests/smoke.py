#!/usr/bin/env python3
"""End-to-end smoke test that runs without Blender or a paid voice.

  1. check_story on the real story
  2. voice.py --backend dummy -> timeline.json (in a temp build dir)
  3. scenes.py build(ctx) against a recording fake `bpy`: catches Python/timeline errors,
     asserts every keyframe is inside the timeline and that the loop seam is exact
     (outro camera ends on the opening pose; periodic spins and orbits match at 0 and N)
  4. synthetic frames -> render.py's test plan -> contact_sheet.py
  5. captions.py -> mix.py -> qc.py (must pass)

The real story and build/ are never touched (STORY_STORIES_DIR / STORY_BUILD_DIR).

usage: python3 tests/smoke.py [--slug petrov-1983] [--keep]
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PIPE = ROOT / "pipeline"


def sh(*cmd, env=None):
    print("$ " + " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True, env=env)


# ------------------------------------------------------------------ fake bpy

class FakeObject(MagicMock):
    """Transforms behave like Blender vectors: index-assignable lists."""
    VECTORS = ("location", "rotation_euler", "scale")

    def __setattr__(self, k, v):
        if k in self.VECTORS:
            v = list(v)
        super().__setattr__(k, v)

    def _get_child_mock(self, **kw):
        return MagicMock(**kw)


class Registry:
    def __init__(self):
        self.objects = {}

    def obj(self, name, data=None):
        o = FakeObject(name=name)
        o.name = name
        o.location, o.rotation_euler, o.scale = (0, 0, 0), (0, 0, 0), (1, 1, 1)
        o.keys = []
        o.data = data if data is not None else MagicMock(name=name + "_data")

        def kf(data_path, frame, index=-1, _o=o):
            val = getattr(_o, data_path)
            if index >= 0:
                val = val[index]
            _o.keys.append((data_path, frame, index, tuple(val) if isinstance(val, (tuple, list)) else val))
        o.keyframe_insert.side_effect = kf
        self.objects[name] = o
        return o


def fake_bpy(reg):
    bpy = MagicMock(name="bpy")
    bpy.data.objects.new.side_effect = lambda name, data=None: reg.obj(name, data)

    def prim(kind):
        def add(**kw):
            o = reg.obj(f"_{kind}_{len(reg.objects)}")
            o.location = kw.get("location", (0, 0, 0))
            bpy.context.active_object = o
        return add
    import importlib
    sys.modules["bpy"] = bpy
    lib = importlib.import_module("lib")
    for kind, op in lib._PRIMS.items():
        getattr(bpy.ops.mesh, op).side_effect = prim(kind)
    return bpy, lib


def check_scenes(slug, stories, build):
    sys.path.insert(0, str(ROOT / "blender"))
    reg = Registry()
    bpy, lib = fake_bpy(reg)
    tl = json.loads((build / slug / "timeline.json").read_text())
    story = json.loads((stories / slug / "story.json").read_text())
    lib.setup_scene(tl, story["render"])
    spec = __import__("importlib.util").util.spec_from_file_location("s", stories / slug / "scenes.py")
    mod = __import__("importlib.util").util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    ctx = lib.Ctx(tl, story)
    mod.build(ctx)
    ctx.finalize()

    total = tl["total_frames"]
    bad = [(o.name, k[0], k[1]) for o in reg.objects.values() for k in o.keys
           if not isinstance(k[1], int) or not 0 <= k[1] <= total]
    assert not bad, f"keyframes outside 0..{total} or non-int: {bad[:5]}"
    n_keys = sum(len(o.keys) for o in reg.objects.values())

    if tl.get("loop", {}).get("enabled"):
        first, last = tl["shots"][0]["id"], tl["shots"][-1]["id"]
        cams = {s: ctx._cams[s] for s in (first, last)}

        def loc_at(o, frame, path="location"):
            ks = [k for k in o.keys if k[0] == path and k[1] <= frame]
            return max(ks, key=lambda k: k[1])[3] if ks else tuple(getattr(o, path))

        def target(cam):
            return cam.constraints.new.return_value.target

        a = loc_at(cams[first], 0)
        b = loc_at(cams[last], total)
        assert all(abs(x - y) < 1e-6 for x, y in zip(a, b)), f"loop camera mismatch {a} vs {b}"
        ta, tb = loc_at(target(cams[first]), 0), loc_at(target(cams[last]), total)
        assert all(abs(x - y) < 1e-6 for x, y in zip(ta, tb)), f"loop target mismatch {ta} vs {tb}"
        # Periodic motion: whatever is keyed at both 0 and total must match (mod 2*pi for spins).
        for o in reg.objects.values():
            for path in ("rotation_euler", "location"):
                k0 = [k for k in o.keys if k[0] == path and k[1] == 0]
                kn = [k for k in o.keys if k[0] == path and k[1] == total]
                for x, y in zip(k0, kn):
                    if x[2] != y[2]:
                        continue
                    if path == "rotation_euler":
                        d = (y[3] - x[3]) / (2 * math.pi)
                        assert abs(d - round(d)) < 1e-6, f"{o.name} spin not whole turns"
                    elif o.name not in (cams[first].name, cams[last].name):
                        assert all(abs(p - q) < 1e-6 for p, q in zip(x[3], y[3])), \
                            f"{o.name} location differs at 0 and {total}"
        print(f"loop seam: camera and periodic motion match at frames 0 and {total}")
    print(f"scenes: {len(reg.objects)} objects, {n_keys} keyframes, all inside 0..{total}")
    sys.modules.pop("bpy", None)


# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", default="petrov-1983")
    ap.add_argument("--keep", action="store_true", help="keep the temp dir for inspection")
    args = ap.parse_args()
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} is required")

    tmp = Path(tempfile.mkdtemp(prefix="story-smoke-"))
    stories, build = tmp / "stories", tmp / "build"
    shutil.copytree(ROOT / "stories" / args.slug, stories / args.slug)
    log = stories / args.slug / "iterations.md"
    if log.exists():
        log.unlink()
    env = dict(os.environ, STORY_STORIES_DIR=str(stories), STORY_BUILD_DIR=str(build))
    py = sys.executable
    try:
        sh(py, PIPE / "check_story.py", args.slug, env=env)
        sh(py, PIPE / "voice.py", args.slug, "--backend", "dummy", env=env)
        tl = json.loads((build / args.slug / "timeline.json").read_text())
        total, fps, W, H = tl["total_frames"], tl["fps"], tl["width"], tl["height"]

        check_scenes(args.slug, stories, build)

        # Synthetic frames: a dot on a circle with period == the timeline, so the loop is clean.
        frames = build / args.slug / "frames"
        frames.mkdir(parents=True, exist_ok=True)
        dur = total / fps + 1
        sh("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
           "-f", "lavfi", "-i", f"color=c=0x101828:s={W}x{H}:r={fps}:d={dur}",
           "-f", "lavfi", "-i", f"color=c=0xff4a3d:s=160x160:r={fps}:d={dur}",
           "-filter_complex",
           f"[0][1]overlay=x='{W // 2 - 80}+{W // 4}*sin(2*PI*n/{total})':"
           f"y='{H // 2 - 80}+{W // 4}*cos(2*PI*n/{total})':eval=frame",
           "-frames:v", str(total), "-start_number", "0", frames / "frame_%04d.png")

        # Step 4 without Blender: use render.py's own plan, copy frames in as test renders.
        sys.path.insert(0, str(PIPE))
        os.environ.update(STORY_STORIES_DIR=str(stories), STORY_BUILD_DIR=str(build))
        import render  # noqa: E402
        plan = render.plan_frames(tl, [], [], 3)
        assert 0 in plan and total - 1 in plan, "loop seam frames missing from the test plan"
        test = build / args.slug / "test"
        test.mkdir(parents=True, exist_ok=True)
        (test / "plan.json").write_text(json.dumps(
            [{"frame": f, "label": render.label(tl, f)} for f in plan]))
        for i, f in enumerate(plan):
            shutil.copyfile(frames / f"frame_{f:04d}.png", test / f"test_{i:03d}.png")
        sh(py, PIPE / "contact_sheet.py", args.slug, "--note", "smoke test", env=env)
        assert (build / args.slug / "contact" / "latest.png").exists()
        assert "smoke test" in (stories / args.slug / "iterations.md").read_text()

        sh(py, PIPE / "captions.py", args.slug, env=env)
        sh(py, PIPE / "mix.py", args.slug, env=env)
        sh(py, PIPE / "qc.py", args.slug, env=env)

        # Failure path: a clip that does not loop, with a loud tone running over the seam
        # and the wrong length, must fail QC on exactly those checks.
        bad = tmp / "bad.mp4"
        sh("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
           "-f", "lavfi", "-i", f"color=c=0x101828:s={W}x{H}:r={fps}:d={total / fps - 1}",
           "-f", "lavfi", "-i", f"color=c=0xe8e8e8:s=500x500:r={fps}:d={total / fps - 1}",
           "-f", "lavfi", "-i", f"sine=f=440:d={total / fps - 1}",
           "-filter_complex", f"[0][1]overlay=x='({W}-500)*t/{total / fps - 1}':y={H // 3}:eval=frame",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", bad)
        r = subprocess.run([py, PIPE / "qc.py", args.slug, "--file", bad], env=env)
        assert r.returncode == 1, "QC passed a broken video"
        failed = {c["check"] for c in json.loads(
            (build / args.slug / "out" / "qc.json").read_text())["checks"] if not c["ok"]}
        for name in ("frames", "loop seam video", "loop seam audio", "loudness"):
            assert name in failed, f"QC did not flag {name!r} on the broken video: {failed}"
        print(f"failure path: QC rejected the broken video ({', '.join(sorted(failed))})")
        print(f"\nSMOKE TEST PASSED ({total} frames, {len(plan)} test frames)")
        if args.keep:
            print(f"kept: {tmp}")
    finally:
        if not args.keep:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
