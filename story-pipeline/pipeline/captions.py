#!/usr/bin/env python3
"""Step 6a: word-by-word captions from the timeline, burned onto the final frames.

Writes build/<slug>/out/captions.ass (karaoke-style: short chunks, the spoken word in the
accent colour) and build/<slug>/out/picture.mp4 (frames + captions, no audio).

usage: python3 pipeline/captions.py <slug> [--ass-only] [--allow-missing]
"""
import argparse
import os

from common import build_dir, die, ffmpeg, load_story, load_timeline

PUNCT = (",", ".", ";", ":", "!", "?", "—")


def ass_time(frame: int, fps: int) -> str:
    cs = int(round(frame * 100 / fps))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def ass_color(hex_rgb: str) -> str:
    h = hex_rgb.lstrip("#")
    return f"&H00{h[4:6]}{h[2:4]}{h[0:2]}".upper()


def chunks(words, max_words, max_chars):
    out, cur = [], []
    for w in words:
        text_len = len(" ".join(x["text"] for x in cur + [w]))
        if cur and (len(cur) >= max_words or text_len > max_chars):
            out.append(cur)
            cur = []
        cur.append(w)
        if w["text"].endswith(PUNCT):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def build_ass(tl: dict, cfg: dict) -> str:
    fps, W, H = tl["fps"], tl["width"], tl["height"]
    upper = cfg.get("uppercase", True)
    size = cfg.get("size", 82)
    margin_v = int(H * cfg.get("margin_v_pct", 27) / 100)
    base, active = ass_color(cfg.get("color", "FFFFFF")), ass_color(cfg.get("active_color", "FF4A3D"))
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {W}", f"PlayResY: {H}",
        "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Cap,{cfg.get('font', 'Arial Black')},{size},{base},{base},&H00000000,&H78000000,"
        f"-1,0,0,0,100,100,1,0,1,{max(size // 12, 3)},2,2,90,90,{margin_v},1",
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    beats = tl["beats"]
    for bi, b in enumerate(beats):
        next_beat = beats[bi + 1]["start_frame"] if bi + 1 < len(beats) else tl["total_frames"]
        groups = chunks(b["words"], cfg.get("max_words", 3), cfg.get("max_chars", 16))
        for gi, g in enumerate(groups):
            g_end = groups[gi + 1][0]["start_frame"] if gi + 1 < len(groups) else \
                min(g[-1]["end_frame"] + int(0.25 * fps), next_beat)
            for wi, w in enumerate(g):
                start = w["start_frame"]
                end = g[wi + 1]["start_frame"] if wi + 1 < len(g) else g_end
                if end <= start:
                    continue
                parts = []
                for k, x in enumerate(g):
                    t = x["text"].upper() if upper else x["text"]
                    t = t.replace("{", "(").replace("}", ")")
                    parts.append(f"{{\\c{active}\\fscx106\\fscy106}}{t}{{\\r}}" if k == wi else t)
                lines.append(f"Dialogue: 0,{ass_time(start, fps)},{ass_time(end, fps)},Cap,,0,0,0,,"
                             + " ".join(parts))
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--ass-only", action="store_true")
    ap.add_argument("--allow-missing", action="store_true",
                    help="encode whatever frames exist (preview); QC will still fail on length")
    args = ap.parse_args()
    tl, story = load_timeline(args.slug), load_story(args.slug)
    out = build_dir(args.slug, "out")
    ass = out / "captions.ass"
    ass.write_text(build_ass(tl, story.get("captions", {})))
    print(f"captions: {ass}")
    if args.ass_only:
        return

    frames = build_dir(args.slug, "frames")
    have = len([p for p in frames.glob("frame_*.png") if p.stat().st_size > 0])
    if have < tl["total_frames"] and not args.allow_missing:
        die(f"{have}/{tl['total_frames']} frames rendered; finish step 5 "
            f"(python3 pipeline/render.py {args.slug} final) or pass --allow-missing")
    fps = tl["fps"]
    # ass= is resolved relative to cwd, which sidesteps filter-path escaping on any OS.
    cwd = os.getcwd()
    os.chdir(out)
    try:
        ffmpeg("-framerate", str(fps), "-start_number", "0", "-i", str(frames / "frame_%04d.png"),
               "-vf", "ass=captions.ass", "-c:v", "libx264", "-preset", "slow", "-crf", "16",
               "-pix_fmt", "yuv420p", "-r", str(fps), "-movflags", "+faststart", "picture.mp4")
    finally:
        os.chdir(cwd)
    print(f"picture:  {out / 'picture.mp4'}")


if __name__ == "__main__":
    main()
