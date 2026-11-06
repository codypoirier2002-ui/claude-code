#!/usr/bin/env python3
"""Wrap-seam repair for Orbit's panoramas (docs/ASSETS.md, "Panoramas").

The generated 2:1 panoramas do not close: their left and right edges differ, which shows as a vertical line where the
sphere wraps. This joins the edges by overlap and a minimum-error cut: no blur, no mirroring, no inpainting. Per scene,
at the source resolution (2896x1440):
 1. Low-frequency equalisation: d(y) = mean(rightmost 8 cols) - mean(leftmost 8 cols), Gaussian sigma 27 px (24 px
    at 2560x1280, scaled), then add d(y) * (0.5 - x/(W-1)) so both edges move to their midpoint; clip.
 2. Overlap the k rightmost columns (A) with the k leftmost (B). Per row choose a cut c(y) by dynamic programming on
    |A-B|^2 (+ a gradient term), |c(y)-c(y-1)| <= 1; x < c takes A, x >= c takes B. The hard cut is blended with a
    Laplacian pyramid of `bands` levels (without bands: feathered over +-3 px). The result is W-k wide and wraps
    continuously; it is rolled by k/2 so the image centre (yaw 0) does not move.
 3. Lanczos resize to 2560x1280.

Needs Python 3 with numpy, Pillow and OpenCV: pip install numpy pillow opencv-python-headless

  python scripts/assets/quilt.py final --src DIR [--out DIR] [--work DIR] [--take 2] [--choices FILE] [--only ID ...]
      reads DIR/{id}-{take}.png, writes OUT/{id}.png (2560x1280 RGB) and WORK/final_metrics.json. k and bands per
      scene come from the choices file (default: seam_choices.json next to this script). --out and --work default to
      'out' and 'work' folders next to --src. Run scripts/assets/deck_warp.py on OUT afterwards, then encode_skies.py.
      Writing a scene deletes OUT/{id}-prewarp.png, deck_warp.py's copy of an older deck.png, so it starts afresh.
  python scripts/assets/quilt.py candidates --src DIR [--work DIR] [--take 2] [--only ID ...]
      tries k = 48 / 96 / 160 on every scene and writes a 400 px crop around each join to WORK, to pick the k and
      bands for seam_choices.json by eye.

Metrics are (edge, baseline): the mean |difference| (0-255, all channels) between the first and the last pixel column,
and between neighbouring columns at the two edges. A panorama wraps when edge is close to baseline. In the final
metrics, seam_x is the half-width of the repaired zone around the wrap line, in output pixels.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

IDS = ["beach", "lake", "loft", "deck", "forest", "rooftop"]
TW, TH = 2560, 1280
DEFAULT_CHOICES = Path(__file__).resolve().with_name("seam_choices.json")


def metric(img):
    f = img.astype(np.float64)
    return (round(float(np.abs(f[:, 0] - f[:, -1]).mean()), 1),
            round(float((np.abs(f[:, 0] - f[:, 1]).mean() + np.abs(f[:, -1] - f[:, -2]).mean()) / 2), 1))


def equalise(img, sigma, n=8):
    H, W = img.shape[:2]
    f = img.astype(np.float32)
    d = f[:, -n:].mean(1) - f[:, :n].mean(1)
    d = cv2.GaussianBlur(d.reshape(H, 1, 3), (1, 0), sigmaX=0.1, sigmaY=sigma, borderType=cv2.BORDER_REFLECT).reshape(H, 3)
    f += d[:, None, :] * (0.5 - np.arange(W, dtype=np.float32) / (W - 1))[None, :, None]
    return np.clip(f, 0, 255)


def quilt(f, k, feather=3, margin=4, bands=0):
    H, W = f.shape[:2]
    A = f[:, W - k:]; B = f[:, :k]
    lum = lambda z: z.mean(2)
    gA = np.gradient(lum(A)); gB = np.gradient(lum(B))
    cost = ((A - B) ** 2).sum(2) + 0.5 * ((gA[0] - gB[0]) ** 2 + (gA[1] - gB[1]) ** 2)
    cost = cv2.GaussianBlur(cost, (0, 0), 1.0)
    cost[:, :margin] = cost[:, -margin:] = 1e12           # keep the cut (and its feather) inside the overlap
    acc = cost.copy(); back = np.zeros((H, k), np.int8)
    for y in range(1, H):
        p = acc[y - 1]
        l = np.r_[np.inf, p[:-1]]; r = np.r_[p[1:], np.inf]
        st = np.stack([l, p, r]); i = st.argmin(0)
        acc[y] += st[i, np.arange(k)]; back[y] = i - 1
    c = np.zeros(H, int); c[-1] = int(acc[-1].argmin())
    for y in range(H - 1, 0, -1):
        c[y - 1] = c[y] + back[y, c[y]]
    x = np.arange(k)[None, :] - c[:, None] + 0.5          # >0 right of cut (B), <0 left (A)
    t = np.clip(x / (2 * feather) + 0.5, 0, 1); t = t * t * (3 - 2 * t)
    if bands:
        comp = multiband(A, B, (x > 0).astype(np.float32), bands)
    else:
        comp = A * (1 - t[..., None]) + B * t[..., None]
    out = np.concatenate([comp, f[:, k:W - k]], axis=1)
    out = np.roll(out, -(k // 2), axis=1)                  # output col j ~ source col j + k/2: centre preserved
    return out, c, float(cost[np.arange(H), c].mean())


def multiband(A, B, m, levels):
    # Burt-Adelson blend: each Laplacian band of A/B mixed with a matching Gaussian level of the hard cut mask
    def gp(z):
        g = [z]
        for _ in range(levels): g.append(cv2.pyrDown(g[-1], borderType=cv2.BORDER_REFLECT))
        return g
    def lp(g):
        return [g[i] - cv2.pyrUp(g[i + 1], dstsize=(g[i].shape[1], g[i].shape[0])) for i in range(levels)] + [g[-1]]
    la, lb = lp(gp(A.astype(np.float32))), lp(gp(B.astype(np.float32)))
    gm = gp(m)
    bl = [a * (1 - w[..., None]) + b * w[..., None] for a, b, w in zip(la, lb, gm)]
    out = bl[-1]
    for i in range(levels - 1, -1, -1):
        out = cv2.pyrUp(out, dstsize=(bl[i].shape[1], bl[i].shape[0])) + bl[i]
    return out


def crop(img, path):
    W = img.shape[1]; r = np.roll(img, W // 2, axis=1)[:, W // 2 - 200:W // 2 + 200]
    Image.fromarray(r).save(path)


def run(src_dir, sid, take, k, bands=0):
    src = np.asarray(Image.open(src_dir / f"{sid}-{take}.png").convert("RGB"))
    H = src.shape[0]
    eq = equalise(src, 24 * H / TH)
    q, c, cm = quilt(eq, k, margin=max(4, k // 4) if bands else 4, bands=bands)
    img = np.asarray(Image.fromarray(np.clip(np.rint(q), 0, 255).astype(np.uint8)).resize((TW, TH), Image.LANCZOS))
    # the repaired zone (the k-wide overlap, rolled) now straddles the wrap line; seam_x is its half-width in output
    # pixels, and the crops of the candidates mode are rolled by it
    shift = int(round((k / 2) * TW / q.shape[1]))
    return img, shift, cm


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=("final", "candidates"))
    ap.add_argument("--src", type=Path, required=True, help="folder with {id}-{take}.png, 2896x1440 RGB")
    ap.add_argument("--take", type=int, default=2, help="take of every scene to use (default: %(default)s)")
    ap.add_argument("--out", type=Path, default=None, help="final: folder for {id}.png (default: 'out' next to --src)")
    ap.add_argument("--work", type=Path, default=None, help="folder for metrics and crops (default: 'work' next to --src)")
    ap.add_argument("--choices", type=Path, default=DEFAULT_CHOICES, help="final: k and bands per scene (default: seam_choices.json next to this script)")
    ap.add_argument("--only", nargs="+", metavar="ID", default=None, help="scenes to process (default: all six)")
    args = ap.parse_args(argv)

    ids = args.only or IDS
    bad = [s for s in ids if s not in IDS]
    if bad:
        ap.error(f"unknown scene {bad}; choose from {IDS}")
    parent = args.src.resolve().parent
    work = args.work if args.work is not None else parent / "work"
    work.mkdir(parents=True, exist_ok=True)

    if args.mode == "candidates":
        rep = {}
        for sid in ids:
            rep[sid] = {}
            for k, bands in ((48, 0), (96, 4), (160, 5)):
                img, shift, cm = run(args.src, sid, args.take, k, bands)
                nm = f"quilt{'mb' if bands else ''}-{k}"
                rep[sid][nm] = dict(edge=metric(img), cutcost=round(cm, 1))
                crop(np.roll(img, -shift, axis=1), work / f"{sid}-{nm}.png")
            print(sid, rep[sid], flush=True)
        (work / "quilt_candidates.json").write_text(json.dumps(rep, indent=1), encoding="utf-8")
    else:
        out = args.out if args.out is not None else parent / "out"
        out.mkdir(parents=True, exist_ok=True)
        choices = json.loads(args.choices.read_text(encoding="utf-8"))
        rep = {}
        for sid in ids:
            k, bands = choices[sid]["k"], choices[sid].get("bands", 0)
            raw = np.asarray(Image.open(args.src / f"{sid}-{args.take}.png").convert("RGB").resize((TW, TH), Image.LANCZOS))
            img, shift, cm = run(args.src, sid, args.take, k, bands)
            Image.fromarray(img).save(out / f"{sid}.png")
            (out / f"{sid}-prewarp.png").unlink(missing_ok=True)  # deck_warp.py's copy of an older run is stale now
            rep[sid] = dict(before=metric(raw), after=metric(img), k=k, bands=bands, seam_x=shift)
            print(sid, rep[sid], flush=True)
        (work / "final_metrics.json").write_text(json.dumps(rep, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
