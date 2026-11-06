#!/usr/bin/env python3
"""Encode the repaired panoramas for the app (docs/ASSETS.md, "Panoramas").

Reads SRC/{id}.png (2560x1280 RGB, from quilt.py and deck_warp.py) and writes OUT/{id}.jpg, a progressive JPEG, and
OUT/thumbs/{id}.jpg, a 320x160 thumbnail (Lanczos, quality 80). The JPEG quality starts at 82 and is walked (70..92)
until the file is between 0.5 MiB (524288 bytes) and 0.9 MB (900000 bytes). Prints the quality, the sizes and the wrap
metric (edge, baseline) of the result, see quilt.py; with --before DIR the same metric of the JPEGs already in DIR is
printed too, for comparison.
Needs Python 3 with numpy and Pillow: pip install numpy pillow

  python scripts/assets/encode_skies.py --src DIR [--out public/skies] [--before DIR] [--report FILE] [--only ID ...]
      --report writes the printed numbers to FILE as JSON.
"""
import argparse
import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

IDS = ["beach", "lake", "loft", "deck", "forest", "rooftop"]
LO, HI = 524288, 900000


def enc(img, q):
    b = io.BytesIO(); img.save(b, "JPEG", quality=q, optimize=True, progressive=True); return b.getvalue()


def metric(a):
    f = a.astype(np.float64)
    return (round(float(np.abs(f[:, 0] - f[:, -1]).mean()), 1),
            round(float((np.abs(f[:, 0] - f[:, 1]).mean() + np.abs(f[:, -1] - f[:, -2]).mean()) / 2), 1))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, required=True, help="folder with {id}.png, 2560x1280 RGB")
    ap.add_argument("--out", type=Path, default=Path("public/skies"), help="folder for {id}.jpg and thumbs/{id}.jpg (default: %(default)s)")
    ap.add_argument("--before", type=Path, default=None, help="folder with earlier {id}.jpg files to compare the wrap metric with")
    ap.add_argument("--report", type=Path, default=None, help="write the results to this JSON file")
    ap.add_argument("--only", nargs="+", metavar="ID", default=None, help="scenes to encode (default: all six)")
    args = ap.parse_args(argv)
    ids = args.only or IDS
    bad = [s for s in ids if s not in IDS]
    if bad:
        ap.error(f"unknown scene {bad}; choose from {IDS}")
    (args.out / "thumbs").mkdir(parents=True, exist_ok=True)
    rep = {}
    for sid in ids:
        im = Image.open(args.src / f"{sid}.png").convert("RGB")
        if im.size != (2560, 1280):
            sys.exit(f"{sid}.png is {im.size[0]}x{im.size[1]}, expected 2560x1280 (run quilt.py first)")
        q = 82; data = enc(im, q)
        while len(data) > HI and q > 70: q -= 1; data = enc(im, q)
        while len(data) < LO and q < 92: q += 1; data = enc(im, q)
        if not LO <= len(data) <= HI:
            sys.exit(f"{sid}: {len(data)} bytes at quality {q} is outside {LO}..{HI}")
        (args.out / f"{sid}.jpg").write_bytes(data)
        thumb = args.out / "thumbs" / f"{sid}.jpg"
        im.resize((320, 160), Image.LANCZOS).save(thumb, "JPEG", quality=80, optimize=True)
        rep[sid] = dict(q=q, size=len(data), thumb=thumb.stat().st_size,
                        after_jpg=metric(np.asarray(Image.open(args.out / f"{sid}.jpg").convert("RGB"))))
        if args.before is not None:
            rep[sid]["before_jpg"] = metric(np.asarray(Image.open(args.before / f"{sid}.jpg").convert("RGB")))
        print(sid, rep[sid], flush=True)
    if args.report is not None:
        args.report.write_text(json.dumps(rep, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
