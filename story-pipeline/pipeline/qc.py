#!/usr/bin/env python3
"""Step 6c: check final.mp4 before it ships. Exit 1 if anything fails.

  length     video frames == timeline total_frames; audio length matches the video
  format     resolution and fps match the timeline
  loudness   integrated loudness within +/-1 LU of target, true peak at or under the
             ceiling (+0.5 dB allowance for AAC), measured with ebur128 on the final file
  loop seam  (if loop.enabled) SSIM between the last and first frame >= loop.min_ssim,
             compared with the typical change between two neighbouring frames;
             audio edges are quiet (loop.audio = "silent_edges") or continuous
             ("continuous": small sample jump and similar level across the seam)

Writes build/<slug>/out/qc.json.

usage: python3 pipeline/qc.py <slug> [--file path/to/video.mp4]
"""
import argparse
import array
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from common import build_dir, load_story, load_timeline, need

results = []


def check(name, ok, detail):
    results.append({"check": name, "ok": bool(ok), "detail": detail})
    print(f"{'PASS' if ok else 'FAIL'}  {name:<16} {detail}")


def probe(path, stream, entries, count=False):
    cmd = ["ffprobe", "-v", "error", "-select_streams", stream, "-show_entries",
           f"stream={entries}", "-of", "json", str(path)]
    if count:
        cmd.insert(1, "-count_packets")
    s = json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout)["streams"]
    return s[0] if s else None


def ffmpeg_stderr(*args):
    return subprocess.run(["ffmpeg", "-hide_banner", "-nostats", *args], capture_output=True,
                          text=True).stderr


def frame_png(video, n, dst):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-vf",
                    f"select=eq(n\\,{n})", "-frames:v", "1", "-update", "1", str(dst)], check=True)


def ssim(a, b):
    err = ffmpeg_stderr("-i", str(a), "-i", str(b), "-lavfi", "ssim", "-f", "null", "-")
    m = re.search(r"All:([0-9.]+)", err)
    return float(m.group(1)) if m else float("nan")


def pcm(video):
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video), "-vn",
                          "-ac", "1", "-ar", "48000", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    a = array.array("h")
    a.frombytes(raw[: len(raw) // 2 * 2])
    if sys.byteorder == "big":
        a.byteswap()
    return a


def dbfs(samples):
    if not samples:
        return -120.0
    rms = math.sqrt(sum(s * s for s in samples) / len(samples)) / 32768
    return 20 * math.log10(rms) if rms > 0 else -120.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--file")
    args = ap.parse_args()
    need("ffmpeg")
    need("ffprobe")
    tl, story = load_timeline(args.slug), load_story(args.slug)
    out = build_dir(args.slug, "out")
    video = Path(args.file) if args.file else out / "final.mp4"
    if not video.exists():
        print(f"error: {video} not found; run captions.py and mix.py first", file=sys.stderr)
        sys.exit(1)
    fps, total = tl["fps"], tl["total_frames"]

    v = probe(video, "v:0", "width,height,r_frame_rate,nb_read_packets", count=True)
    a = probe(video, "a:0", "duration,sample_rate")
    n_frames = int(v["nb_read_packets"])
    num, den = (int(x) for x in v["r_frame_rate"].split("/"))
    check("frames", n_frames == total, f"{n_frames} frames, timeline {total}")
    check("format", (v["width"], v["height"], round(num / den, 3)) == (tl["width"], tl["height"], fps),
          f"{v['width']}x{v['height']} @ {num / den:g} fps")
    if a is None:
        check("audio", False, "no audio stream")
    else:
        a_dur = float(a["duration"])
        check("audio length", abs(a_dur - total / fps) <= 1.5 / fps,
              f"audio {a_dur:.3f}s vs video {total / fps:.3f}s")

        acfg = story.get("audio", {})
        target, ceiling = acfg.get("target_lufs", -14), acfg.get("true_peak", -1.5)
        err = ffmpeg_stderr("-i", str(video), "-filter_complex", "ebur128=peak=true", "-f", "null", "-")
        summary = err[err.rfind("Summary:"):]
        i_m = re.search(r"I:\s+(-?[0-9.]+) LUFS", summary)
        tp_m = re.search(r"True peak:\s+Peak:\s+(-?[0-9.]+|-inf) dBFS", summary)
        lra_m = re.search(r"LRA:\s+([0-9.]+) LU", summary)
        lufs = float(i_m.group(1)) if i_m else float("nan")
        peak = float(tp_m.group(1)) if tp_m and tp_m.group(1) != "-inf" else -120.0
        check("loudness", abs(lufs - target) <= 1.0,
              f"{lufs:.1f} LUFS integrated (target {target}), LRA {lra_m.group(1) if lra_m else '?'} LU")
        check("true peak", peak <= ceiling + 0.5, f"{peak:.1f} dBTP (ceiling {ceiling})")

    loop = tl.get("loop", {})
    if loop.get("enabled"):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            frame_png(video, 0, td / "first.png")
            frame_png(video, n_frames - 1, td / "last.png")
            frame_png(video, n_frames - 2, td / "prev.png")
            seam = ssim(td / "last.png", td / "first.png")
            neighbour = ssim(td / "prev.png", td / "last.png")
        need_ssim = loop.get("min_ssim", 0.85)
        # The seam must clear the absolute bar AND look like an ordinary frame step: a jump
        # several times bigger than the neighbouring change reads as a cut even when SSIM
        # is high overall.
        max_jump = 4 * (1 - neighbour) + 0.02
        check("loop seam video", seam >= need_ssim and (1 - seam) <= max_jump,
              f"SSIM last->first {seam:.3f} (need >= {need_ssim} and >= {1 - max_jump:.3f}); "
              f"a normal frame step is {neighbour:.3f}")
        if a is not None:
            s = pcm(video)
            w = 2400  # 50 ms
            head, tail = dbfs(s[:w]), dbfs(s[-w:])
            jump = abs(s[-1] - s[0]) / 32768 if s else 0.0
            if loop.get("audio", "silent_edges") == "continuous":
                check("loop seam audio", jump < 0.05 and abs(head - tail) < 6,
                      f"edge levels {tail:.0f} -> {head:.0f} dBFS, sample jump {jump:.3f}")
            else:
                check("loop seam audio", head < -40 and tail < -40,
                      f"first 50 ms {head:.0f} dBFS, last 50 ms {tail:.0f} dBFS (need < -40)")

    report = {"file": str(video), "passed": all(r["ok"] for r in results), "checks": results}
    (out / "qc.json").write_text(json.dumps(report, indent=1))
    print(f"\n{'ALL CHECKS PASSED' if report['passed'] else 'QC FAILED'}  -> {out / 'qc.json'}")
    sys.exit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
