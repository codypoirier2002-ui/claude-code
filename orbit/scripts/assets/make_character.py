#!/usr/bin/env python3
"""Build Orbit's Callie character layers (docs/SPEC.md section 13.1 steps 4-7, docs/ASSETS.md).

Aligns every expression take to the base portrait with OpenCV ECC (SIFT + ECC as the fallback), keeps the take that
differs least from the base outside the face, builds a feathered mask per expression (a diff mask for blink / talk /
smile, fixed ellipses for think / wow), writes the seven WebP files and composites over the base to check them.
Needs Python 3 with numpy, Pillow and OpenCV: pip install numpy pillow opencv-python-headless

Inputs  (--src):  base.png, cutout.png (RGBA), {name}-{n}.png takes for
                  blink / talk / smile / wow / think, all 768x1024
Outputs (--out):  base.webp think.webp wow.webp smile.webp talk.webp blink.webp face.webp   (default public/character)
Debug   (--work): aligned/*.png, mask_{name}.png, check_{name}.png,
                  check_sheet.png, check_faces.png, report.json            (default: a 'work' folder next to --src)

Run from the project root. The shipped think / wow patches use ellipses fitted to the generated portrait (the spec's
fixed ones let the base smile line ghost through), so they were made with:
  python scripts/assets/make_character.py --src DIR/callie/src --eyes 300,330,470,300 --mouth 399,458,80,48
Other options: --take blink=2 forces a take. Only ASCII is printed so a cp1252 console cannot choke on it.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

# ---------------------------------------------------------------- constants
W, H = 768, 1024
FACE_BOX = (200, 280, 570, 540)  # x0, y0, x1, y1 (end-exclusive): face features
ECC_ITERS, ECC_EPS, ECC_GAUSS = 300, 1e-6, 5
ECC_MIN_CC = 0.90  # an ECC exception, or a correlation below this = "did not converge"
SIFT_FEATURES, SIFT_RATIO, RANSAC_PX = 4000, 0.75, 4.0

DIFF_NAMES = ("blink", "talk", "smile")  # diff-mask expressions (same drawing)
ELLIPSE_NAMES = ("think", "wow")  # fixed-ellipse expressions (hair redrawn)
TAKE_NAMES = ("blink", "talk", "smile", "wow", "think")
PATCH_ORDER = ("think", "wow", "smile", "talk", "blink")  # SPEC 7.1 order
SHEET_ORDER = ("base", "blink", "talk", "smile", "think", "wow")

EYES = ((300, 330), (470, 330))
EYE_R = (78, 52)
MOUTH = (400, 495)
MOUTH_R = (80, 48)

WEBP_Q, FACE_Q = 86, 88
FACE_CROP = (190, 140, 390)  # x, y, size
FACE_OUT = 160
CHECK_BG = (36, 38, 46)  # RGB the checks are flattened onto (dark UI-like slate)

DEFAULT_OUT = Path("public/character")  # relative to the working directory: run from the project root


def log(msg=""):
    print(msg, flush=True)


# ---------------------------------------------------------------- io helpers
def imread(path, flags):
    img = cv2.imread(str(path), flags)
    if img is None:
        raise FileNotFoundError(f"cannot read {path}")
    return img


def save_webp(path, rgba_u8, quality):
    """rgba_u8: HxWx4 uint8 in RGBA order. Pillow, method 6 (slowest/smallest)."""
    Image.fromarray(np.ascontiguousarray(rgba_u8)).save(
        path, format="WEBP", quality=quality, method=6
    )


def to_u8(x01):
    return np.clip(np.rint(x01 * 255.0), 0, 255).astype(np.uint8)


def gray32(bgr):
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)


def outside_box_bool():
    x0, y0, x1, y1 = FACE_BOX
    m = np.ones((H, W), bool)
    m[y0:y1, x0:x1] = False
    return m


def ecc_input_mask():
    """uint8 mask for findTransformECC: 255 = valid, 0 inside the face-feature box."""
    return (outside_box_bool().astype(np.uint8)) * 255


def mad(a, b, sel):
    """Mean absolute difference over all channels, restricted to bool mask `sel`."""
    d = np.abs(a.astype(np.int16) - b.astype(np.int16))
    return float(d[sel].mean())


# ---------------------------------------------------------------- step 4: alignment
def ecc_refine(tmpl_gray, img_gray, mask):
    warp = np.eye(2, 3, dtype=np.float32)
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, ECC_ITERS, ECC_EPS)
    cc, warp = cv2.findTransformECC(
        tmpl_gray, img_gray, warp, cv2.MOTION_AFFINE, crit, mask, ECC_GAUSS
    )
    return float(cc), warp.astype(np.float64)


def to3(m23):
    return np.vstack([np.asarray(m23, np.float64), [0.0, 0.0, 1.0]])


def warp_inverse(frame_bgr, inv23):
    """aligned(x) = frame(inv23 @ x): cubic, inverse-map, edge replicate."""
    return cv2.warpAffine(
        frame_bgr,
        np.asarray(inv23, np.float64),
        (W, H),
        flags=cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP,
        borderMode=cv2.BORDER_REPLICATE,
    )


def sift_prealign(base_bgr, frame_bgr):
    """SIFT + Lowe ratio + RANSAC similarity. Returns forward 2x3 (frame -> base)."""
    sift = cv2.SIFT_create(nfeatures=SIFT_FEATURES)
    kb, db = sift.detectAndCompute(cv2.cvtColor(base_bgr, cv2.COLOR_BGR2GRAY), None)
    kf, df = sift.detectAndCompute(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY), None)
    if db is None or df is None or len(kb) < 8 or len(kf) < 8:
        raise RuntimeError("SIFT found too few keypoints")
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(df, db, k=2)
    good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < SIFT_RATIO * p[1].distance]
    if len(good) < 8:
        raise RuntimeError(f"only {len(good)} SIFT matches survive the ratio test")
    src = np.float32([kf[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([kb[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    m23, inl = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC, ransacReprojThreshold=RANSAC_PX
    )
    if m23 is None:
        raise RuntimeError("estimateAffinePartial2D failed")
    return m23, int(inl.sum()), len(good)


def align_frame(base_bgr, base_gray, frame_bgr, ecc_mask):
    """Align `frame_bgr` to the base. Direct ECC first; SIFT pre-align + ECC when the
    size differs, ECC raises, or the correlation stays under ECC_MIN_CC."""
    notes, cands = [], []  # cands: (cc, inv23, method)
    if frame_bgr.shape[:2] == base_bgr.shape[:2]:
        try:
            cc, we = ecc_refine(base_gray, gray32(frame_bgr), ecc_mask)
            cands.append((cc, we, "ecc"))
        except cv2.error as e:
            notes.append("ECC raised: " + str(e).strip().splitlines()[-1][:120])
    else:
        notes.append(
            "frame is %dx%d, base is %dx%d" % (frame_bgr.shape[1], frame_bgr.shape[0], W, H)
        )
    if not cands or cands[0][0] < ECC_MIN_CC:
        try:
            m23, n_inl, n_good = sift_prealign(base_bgr, frame_bgr)
            pinv = cv2.invertAffineTransform(m23)  # base coords -> frame coords
            pre = warp_inverse(frame_bgr, pinv)
            cc, we = ecc_refine(base_gray, gray32(pre), ecc_mask)
            # aligned(x) = pre(we x) = frame(pinv (we x)) -> one cubic warp of the original
            cands.append((cc, (to3(pinv) @ to3(we))[:2], "sift+ecc"))
            notes.append(f"SIFT {n_inl}/{n_good} inliers")
        except (cv2.error, RuntimeError) as e:
            notes.append("SIFT path failed: " + str(e).strip().splitlines()[-1][:120])
    if not cands:
        raise RuntimeError("alignment failed: " + "; ".join(notes))
    cc, inv, method = max(cands, key=lambda c: c[0])
    return dict(
        aligned=warp_inverse(frame_bgr, inv), cc=cc, inv=inv, method=method, notes=notes
    )


def warp_summary(inv):
    a, b, tx = inv[0]
    c, d, ty = inv[1]
    return dict(
        tx=float(tx),
        ty=float(ty),
        sx=float(math.hypot(a, c)),
        sy=float(math.hypot(b, d)),
        rot_deg=float(math.degrees(math.atan2(c, a))),
    )


# ---------------------------------------------------------------- step 5: masks
def diff_mask(aligned, base, alpha01):
    """blink / talk / smile: max-channel diff -> blur 9x9 -> >14 -> CC>250 px ->
    25x25 ellipse dilate -> gauss sigma 6 x1.6 clip -> x cutout alpha."""
    d = np.abs(aligned.astype(np.int16) - base.astype(np.int16)).max(axis=2).astype(np.uint8)
    blurred = cv2.blur(d, (9, 9))
    _, thr = cv2.threshold(blurred, 14, 255, cv2.THRESH_BINARY)  # strictly > 14
    n, labels, stats, _ = cv2.connectedComponentsWithStats(thr, connectivity=8)
    keep = stats[:, cv2.CC_STAT_AREA] > 250
    keep[0] = False  # background label
    kept = keep[labels].astype(np.uint8) * 255
    dil = cv2.dilate(kept, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25)))
    soft = np.clip(cv2.GaussianBlur(dil.astype(np.float32), (0, 0), 6) * 1.6, 0, 255) / 255.0
    comps = []
    for i in np.flatnonzero(keep):
        x, y, w, h, area = (int(v) for v in stats[i])
        comps.append(dict(x=x, y=y, w=w, h=h, area=area))
    comps.sort(key=lambda c: -c["area"])
    info = dict(components_total=int(n - 1), components_kept=int(keep.sum()), kept=comps[:8])
    return soft * alpha01, info


def ellipse_mask(alpha01, eyes, eye_r, mouth, mouth_r):
    """think / wow: fixed filled ellipses -> gauss sigma 9 x1.3 clip -> x cutout alpha."""
    m = np.zeros((H, W), np.uint8)
    for c in eyes:
        cv2.ellipse(m, tuple(c), tuple(eye_r), 0, 0, 360, 255, -1, cv2.LINE_AA)
    cv2.ellipse(m, tuple(mouth), tuple(mouth_r), 0, 0, 360, 255, -1, cv2.LINE_AA)
    soft = np.clip(cv2.GaussianBlur(m.astype(np.float32), (0, 0), 9) * 1.3, 0, 255) / 255.0
    return soft * alpha01


def mask_stats(m01, aligned, base):
    sel = m01 > 0.5
    ys, xs = np.where(sel)
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else None
    inside_box = np.zeros((H, W), bool)
    x0, y0, x1, y1 = FACE_BOX
    inside_box[y0:y1, x0:x1] = True
    band = (m01 > 0.02) & (m01 < 0.98)
    dmax = np.abs(aligned.astype(np.int16) - base.astype(np.int16)).max(axis=2).astype(np.float32)
    vis = dmax * m01  # contribution of the patch's colour change at each pixel
    return dict(
        coverage_pct=float(sel.mean() * 100.0),
        bbox_xyxy=bbox,
        pct_of_mask_outside_face_box=float((sel & ~inside_box).sum() / max(1, sel.sum()) * 100.0),
        feather_band_px=int(band.sum()),
        # how much the patch changes colour inside its own feather band (seam / ghost proxy)
        feather_vis_mean=float(vis[band].sum() / max(1e-6, m01[band].sum())) if band.any() else 0.0,
        feather_vis_p95=float(np.percentile(vis[band], 95)) if band.any() else 0.0,
        feather_vis_gt10_px=int((vis[band] > 10).sum()) if band.any() else 0,
    )


# ---------------------------------------------------------------- step 7: checks
def load_rgba_f32(path):
    return np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32) / 255.0


def over(top, bottom):
    ta, ba = top[..., 3:4], bottom[..., 3:4]
    oa = ta + ba * (1.0 - ta)
    rgb = (top[..., :3] * ta + bottom[..., :3] * ba * (1.0 - ta)) / np.maximum(oa, 1e-6)
    return np.concatenate([rgb, oa], axis=-1)


def flatten(rgba, bg_rgb=CHECK_BG):
    bg = np.asarray(bg_rgb, np.float32) / 255.0
    a = rgba[..., 3:4]
    return rgba[..., :3] * a + bg * (1.0 - a)


def rgb_f32_to_bgr_u8(rgb):
    return cv2.cvtColor(to_u8(rgb), cv2.COLOR_RGB2BGR)


def labelled_grid(panels_bgr, labels, cols=3, label_h=20):
    ph, pw = panels_bgr[0].shape[:2]
    rows = int(math.ceil(len(panels_bgr) / cols))
    bg_bgr = CHECK_BG[::-1]
    sheet = np.empty((rows * (ph + label_h), cols * pw, 3), np.uint8)
    sheet[:] = bg_bgr
    for i, (p, lab) in enumerate(zip(panels_bgr, labels)):
        r, c = divmod(i, cols)
        y0, x0 = r * (ph + label_h), c * pw
        sheet[y0 + label_h : y0 + label_h + ph, x0 : x0 + pw] = p
        cv2.putText(sheet, lab, (x0 + 6, y0 + 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                    (230, 230, 230), 1, cv2.LINE_AA)
    return sheet


# ---------------------------------------------------------------- main
def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--src", type=Path, required=True, help="folder with base.png, cutout.png and the takes")
    ap.add_argument("--work", type=Path, default=None,
                    help="folder for aligned/mask/check debug output (default: a 'work' folder next to --src)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help="folder for the final .webp files (default: %(default)s)")
    ap.add_argument("--take", action="append", default=[], metavar="NAME=N",
                    help="force take N for an expression instead of auto-picking (repeatable)")
    ap.add_argument("--eyes", metavar="LX,LY,RX,RY", default=None,
                    help="override the think/wow eye-ellipse centres (spec: 300,330,470,330; radii stay 78x52)")
    ap.add_argument("--mouth", metavar="CX,CY,RX,RY", default=None,
                    help="override the think/wow mouth ellipse (spec: 400,495,80,48)")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    src, out = args.src, args.out
    work = args.work if args.work is not None else src.resolve().parent / "work"
    forced = {}
    for t in args.take:
        k, v = t.split("=")
        forced[k.strip()] = int(v)
    eyes, mouth, mouth_r = EYES, MOUTH, MOUTH_R
    if args.eyes:
        lx, ly, rx, ry = (int(v) for v in args.eyes.split(","))
        eyes = ((lx, ly), (rx, ry))
    if args.mouth:
        cx, cy, rx, ry = (int(v) for v in args.mouth.split(","))
        mouth, mouth_r = (cx, cy), (rx, ry)
    (work / "aligned").mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    report = dict(cv2=cv2.__version__, eye_ellipses=dict(centers=eyes, radii=EYE_R),
                  mouth_ellipse=dict(center=mouth, radii=mouth_r), alignment={}, masks={}, files={})

    base = imread(src / "base.png", cv2.IMREAD_COLOR)
    cut = imread(src / "cutout.png", cv2.IMREAD_UNCHANGED)
    if base.shape != (H, W, 3):
        raise SystemExit(f"base.png must be {W}x{H}, got {base.shape}")
    if cut.shape != (H, W, 4):
        raise SystemExit(f"cutout.png must be {W}x{H} RGBA, got {cut.shape}")
    alpha01 = cut[..., 3].astype(np.float32) / 255.0
    base_gray, ecc_mask, outside = gray32(base), ecc_input_mask(), outside_box_bool()
    fg = alpha01 > 0.5

    # ---- step 4 + take selection (step 2 of the task)
    log("== alignment (ECC MOTION_AFFINE, %d it, eps %g, gauss %d, face box masked) ==" % (ECC_ITERS, ECC_EPS, ECC_GAUSS))
    chosen = {}
    for name in TAKE_NAMES:
        takes = sorted(src.glob(f"{name}-*.png"), key=lambda p: int(p.stem.rsplit("-", 1)[1]))
        if not takes:
            raise SystemExit(f"no takes for {name} in {src}")
        res = []
        for p in takes:
            n = int(p.stem.rsplit("-", 1)[1])
            frame = imread(p, cv2.IMREAD_COLOR)
            r = align_frame(base, base_gray, frame, ecc_mask)
            r["take"] = n
            r["score"] = mad(r["aligned"], base, outside)
            r["score_fg"] = mad(r["aligned"], base, outside & fg)
            r["score_raw"] = mad(frame, base, outside) if frame.shape == base.shape else None
            cv2.imwrite(str(work / "aligned" / f"{name}-{n}.png"), r["aligned"])
            res.append(r)
            w = warp_summary(r["inv"])
            log("  %-5s take %d: cc=%.6f  MAD(outside box)=%.3f  [raw %s, fg-only %.3f]  method=%s  "
                "tx=%+.3f ty=%+.3f sx=%.5f sy=%.5f rot=%+.4fdeg %s"
                % (name, n, r["cc"], r["score"],
                   "%.3f" % r["score_raw"] if r["score_raw"] is not None else "n/a", r["score_fg"],
                   r["method"], w["tx"], w["ty"], w["sx"], w["sy"], w["rot_deg"], " ".join(r["notes"])))
        pick = min(res, key=lambda r: r["score"])
        if name in forced:
            pick = next(r for r in res if r["take"] == forced[name])
        chosen[name] = pick
        if len(res) > 1:
            log("  -> %s: scores %s => chose take %d%s" % (
                name, " vs ".join("take%d=%.3f" % (r["take"], r["score"]) for r in res), pick["take"],
                " (forced)" if name in forced else ""))
        else:
            log("  -> %s: single take %d" % (name, pick["take"]))
        report["alignment"][name] = dict(
            chosen_take=pick["take"],
            takes=[dict(take=r["take"], cc=r["cc"], score_mad_outside_box=r["score"],
                        score_fg_only=r["score_fg"], score_raw_unaligned=r["score_raw"],
                        method=r["method"], warp=warp_summary(r["inv"]), notes=r["notes"]) for r in res])

    # ---- step 5: masks
    log("\n== masks ==")
    masks = {}
    for name in PATCH_ORDER:
        aligned = chosen[name]["aligned"]
        if name in DIFF_NAMES:
            m, info = diff_mask(aligned, base, alpha01)
        else:
            m, info = ellipse_mask(alpha01, eyes, EYE_R, mouth, mouth_r), {}
        st = mask_stats(m, aligned, base)
        st.update(info)
        masks[name] = m
        cv2.imwrite(str(work / f"mask_{name}.png"), to_u8(m))
        report["masks"][name] = st
        log("  %-5s coverage(>0.5)=%.3f%%  bbox=%s  outside-face-box=%.1f%% of mask  feather-vis mean=%.2f p95=%.1f (>10: %d px)%s"
            % (name, st["coverage_pct"], st["bbox_xyxy"], st["pct_of_mask_outside_face_box"],
               st["feather_vis_mean"], st["feather_vis_p95"], st["feather_vis_gt10_px"],
               "  components kept %d/%d" % (st["components_kept"], st["components_total"]) if info else ""))
        for c in info.get("kept", [])[:4]:
            log("          component x%d y%d %dx%d area %d" % (c["x"], c["y"], c["w"], c["h"], c["area"]))

    # ---- step 6: files
    log("\n== writing WebP to %s ==" % out)
    cut_rgba = cv2.cvtColor(cut, cv2.COLOR_BGRA2RGBA)
    save_webp(out / "base.webp", cut_rgba, WEBP_Q)
    for name in PATCH_ORDER:
        rgb = cv2.cvtColor(chosen[name]["aligned"], cv2.COLOR_BGR2RGB)
        save_webp(out / f"{name}.webp", np.dstack([rgb, to_u8(masks[name])]), WEBP_Q)
    fx, fy, fs = FACE_CROP
    face = cv2.resize(cut[fy : fy + fs, fx : fx + fs], (FACE_OUT, FACE_OUT), interpolation=cv2.INTER_AREA)
    save_webp(out / "face.webp", cv2.cvtColor(face, cv2.COLOR_BGRA2RGBA), FACE_Q)
    for f in ("base", *PATCH_ORDER, "face"):
        p = out / f"{f}.webp"
        im = Image.open(p)
        im.load()
        ok = im.mode == "RGBA" and im.size == ((FACE_OUT, FACE_OUT) if f == "face" else (W, H))
        kb = p.stat().st_size / 1024.0
        report["files"][f] = dict(bytes=p.stat().st_size, size=list(im.size), mode=im.mode)
        log("  %-10s %7.1f KB  %s %s%s" % (p.name, kb, im.size, im.mode, "" if ok else "   <-- UNEXPECTED SIZE/MODE"))

    # ---- step 7: composite checks (from the decoded WebPs that actually ship)
    log("\n== checks ==")
    base_w = load_rgba_f32(out / "base.webp")
    comps = {"base": flatten(base_w)}
    for name in PATCH_ORDER:
        comps[name] = flatten(over(load_rgba_f32(out / f"{name}.webp"), base_w))
    for name, img in comps.items():
        cv2.imwrite(str(work / f"check_{name}.png"), rgb_f32_to_bgr_u8(img))
    sw = 256
    sh = int(round(H * sw / W))
    panels = [cv2.resize(rgb_f32_to_bgr_u8(comps[n]), (sw, sh), interpolation=cv2.INTER_AREA) for n in SHEET_ORDER]
    cv2.imwrite(str(work / "check_sheet.png"), labelled_grid(panels, list(SHEET_ORDER)))
    x0, y0, x1, y1 = 170, 230, 600, 580  # face zoom (1:1)
    zoom = [rgb_f32_to_bgr_u8(comps[n])[y0:y1, x0:x1] for n in SHEET_ORDER]
    cv2.imwrite(str(work / "check_faces.png"), labelled_grid(zoom, list(SHEET_ORDER)))
    log("  wrote check_{base,%s}.png, check_sheet.png, check_faces.png in %s" % (",".join(PATCH_ORDER), work))

    (work / "report.json").write_text(json.dumps(report, indent=2))
    log("  wrote report.json")


if __name__ == "__main__":
    main()
