#!/usr/bin/env python3
"""Step 1 gate: validate stories/<slug>/story.json before spending money on voice.

Checks every beat has text, a shot and at least one known source; cue words exist in
their beat; a shot id is used by one contiguous run of beats; and the pacing lands
near the target length. Exit code 1 on errors, warnings are printed but pass.

usage: python3 pipeline/check_story.py <slug> [--wps 2.6]
"""
import argparse
import sys

from common import load_story, norm, story_dir, words

ap = argparse.ArgumentParser()
ap.add_argument("slug")
ap.add_argument("--wps", type=float, default=2.6, help="assumed speaking rate for the estimate")
args = ap.parse_args()

story = load_story(args.slug)
errors, warnings = [], []
source_ids = {s.get("id") for s in story.get("sources", [])}
for s in story.get("sources", []):
    if not s.get("url"):
        errors.append(f"source {s.get('id')!r} has no url")

beats = story.get("beats", [])
if not beats:
    errors.append("no beats")

seen_ids, shot_order, cue_names = set(), [], set()
for i, b in enumerate(beats):
    bid = b.get("id") or f"#{i}"
    if bid in seen_ids:
        errors.append(f"duplicate beat id {bid!r}")
    seen_ids.add(bid)
    if not b.get("text", "").strip():
        errors.append(f"beat {bid}: empty text")
    if not b.get("shot"):
        errors.append(f"beat {bid}: no shot")
    elif not shot_order or shot_order[-1] != b["shot"]:
        if b["shot"] in shot_order:
            errors.append(f"beat {bid}: shot {b['shot']!r} reappears after another shot; give it a new id")
        shot_order.append(b["shot"])
    srcs = b.get("sources") or []
    if not srcs:
        errors.append(f"beat {bid}: no sources (every fact needs one)")
    for s in srcs:
        if s not in source_ids:
            errors.append(f"beat {bid}: unknown source {s!r}")
    spoken = [norm(w) for w in words(b.get("text", ""))]
    for c in b.get("cues", []):
        if c.get("name") in cue_names:
            errors.append(f"beat {bid}: duplicate cue name {c.get('name')!r}")
        cue_names.add(c.get("name"))
        if norm(c.get("word", "")) not in spoken:
            errors.append(f"beat {bid}: cue {c.get('name')!r} word {c.get('word')!r} not in the beat text")

for sfx in story.get("sfx", []):
    if sfx.get("cue") not in cue_names:
        errors.append(f"sfx {sfx.get('file')!r}: unknown cue {sfx.get('cue')!r}")

n_words = sum(len(words(b.get("text", ""))) for b in beats)
p = story.get("pacing", {})
est = (n_words / args.wps + p.get("lead_in", 0.5) + p.get("tail", 0.9)
       + p.get("gap", 0.3) * max(len(beats) - 1, 0))
fps = story.get("render", {}).get("fps", 30)
hook_words = len(words(beats[0]["text"])) if beats else 0
if hook_words / args.wps > 4.2:
    warnings.append(f"hook is ~{hook_words / args.wps:.1f}s; aim for the hook to land within about 4 s")
if not 25 <= est <= 75:
    warnings.append(f"estimated length {est:.0f}s is outside 25-75 s")
if not (story_dir(args.slug) / "scenes.py").exists():
    errors.append("scenes.py is missing next to story.json")

print(f"{story.get('title')}: {len(beats)} beats, {len(shot_order)} shots, {n_words} words")
print(f"estimate at {args.wps} words/s: {est:.1f}s = ~{round(est * fps)} frames @ {fps} fps")
print("shots: " + " -> ".join(shot_order))
for w in warnings:
    print(f"warning: {w}")
for e in errors:
    print(f"error: {e}", file=sys.stderr)
sys.exit(1 if errors else 0)
