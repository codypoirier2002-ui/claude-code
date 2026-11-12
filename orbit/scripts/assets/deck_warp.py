#!/usr/bin/env python3
"""Deck only: round off the V-shaped Earth horizon where the two wrap edges meet (docs/ASSETS.md, "Panoramas").

After quilt.py the deck panorama still has a kink in the Earth horizon at the wrap line. The image is rolled so that
line is in the middle, then inside a centre window (190 px left to 215 px right of the middle):
 - the horizon row of each column is the first row in 740..870 where the blurred blue channel crosses the midpoint
   between space and Earth; the rows are median-filtered over 41 columns, then smoothed (Gaussian sigma 10);
 - the target is a straight line between the mean horizon rows of the 12 columns at each end of the window;
 - each column is shifted vertically by (measured - target), tapered over 15 px at the window's side frames, at full
   strength for rows 760..798 (the corrected horizon and its glow) and ramping to zero at rows 600 and 882, so the row
   map stays monotonic and the bottom frame does not move.
The input is OUT/deck-prewarp.png: the first run copies OUT/deck.png there, so running the script twice does not warp
twice. The output replaces OUT/deck.png.
Needs Python 3 with numpy, Pillow and OpenCV: pip install numpy pillow opencv-python-headless

  python scripts/assets/deck_warp.py OUT [--work DIR]
      OUT is the folder quilt.py wrote deck.png to. --work saves a crop of the result as deck-horizon-warped.png.
"""
import argparse
import shutil
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", type=Path, help="folder holding deck.png (the quilt.py output folder)")
    ap.add_argument("--work", type=Path, default=None, help="folder for a crop of the result (deck-horizon-warped.png)")
    args = ap.parse_args(argv)
    p = args.out / "deck.png"
    pre = args.out / "deck-prewarp.png"
    if not pre.exists():
        shutil.copy(p, pre)
    a = np.asarray(Image.open(pre).convert("RGB")); H, W = a.shape[:2]; c = W // 2
    r = np.roll(a, c, axis=1)
    x0, x1 = c - 190, c + 215
    b = cv2.GaussianBlur(r[..., 2].astype(np.float32), (0, 0), 4.0)
    ys = np.arange(740, 870)
    lo, hi = float(np.median(b[700:740, x0:x1])), float(np.median(b[850:870, x0:x1])); thr = (lo + hi) / 2
    def first_above(col):
        idx = np.nonzero(col > thr)[0]
        return ys[idx[0]] if len(idx) else np.nan
    raw = np.array([first_above(b[ys, x]) for x in range(x0, x1)], np.float32)
    hor = np.array([np.nanmedian(raw[max(0, i - 20):i + 21]) for i in range(len(raw))], np.float32)
    hor = cv2.GaussianBlur(hor.reshape(1, -1), (0, 0), sigmaX=10, borderType=cv2.BORDER_REPLICATE).ravel()  # remove the 1-px staircase
    e0, e1 = float(np.mean(hor[:12])), float(np.mean(hor[-12:]))
    hs = np.linspace(e0, e1, len(hor)).astype(np.float32)   # target: straight line between the window edges
    dy = np.zeros(W, np.float32); dy[x0:x1] = hor - hs
    xx = np.arange(W)
    t = np.clip(np.minimum(xx - x0, x1 - xx) / 15.0, 0, 1); dy *= t * t * (3 - 2 * t)
    y = np.arange(H, dtype=np.float32)
    w = np.interp(y, [600, 760, 798, 882], [0, 1, 1, 0]).astype(np.float32)
    mapx = np.tile(np.arange(W, dtype=np.float32), (H, 1))
    mapy = y[:, None] + w[:, None] * dy[None, :]
    o = cv2.remap(r, mapx, mapy, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
    if args.work is not None:
        args.work.mkdir(parents=True, exist_ok=True)
        Image.fromarray(o[500:900, c - 400:c + 400]).save(args.work / "deck-horizon-warped.png")
    Image.fromarray(np.roll(o, -c, axis=1)).save(p)
    print("thr", round(lo), round(hi), "dy", round(float(dy.min()), 1), round(float(dy.max()), 1), "hor", hor[::40].astype(int).tolist())


if __name__ == "__main__":
    main()
