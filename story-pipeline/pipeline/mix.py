#!/usr/bin/env python3
"""Step 6b: mix narration (+ optional ducked music bed and cue-timed sfx), normalize
loudness with a two-pass loudnorm, fade the edges for a click-free loop, and mux with
picture.mp4 into build/<slug>/out/final.mp4.

story.json "audio": target_lufs (-14 for TikTok/Reels/Shorts), true_peak, music (path
relative to the story dir, or null), music_db, edge_fade_ms.
story.json "sfx": [{"cue": "missile_1", "file": "sfx/beep.wav", "db": -6}]

usage: python3 pipeline/mix.py <slug> [--no-mux]
"""
import argparse
import json
import re
import subprocess

from common import build_dir, die, ffmpeg, load_story, load_timeline, need, story_dir


def loudnorm_measure(path, target, tp):
    need("ffmpeg")
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af",
                        f"loudnorm=I={target}:TP={tp}:LRA=11:print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True, check=True)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    if not m:
        die("could not read loudnorm measurements")
    return json.loads(m.group(0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--no-mux", action="store_true", help="only write mix.wav")
    args = ap.parse_args()
    tl, story = load_timeline(args.slug), load_story(args.slug)
    cfg = story.get("audio", {})
    target, tp = cfg.get("target_lufs", -14), cfg.get("true_peak", -1.5)
    fade = cfg.get("edge_fade_ms", 20) / 1000
    fps, total = tl["fps"], tl["total_frames"]
    dur = total / fps
    out = build_dir(args.slug, "out")
    narration = build_dir(args.slug) / tl["audio"]["narration"]

    inputs = ["-i", str(narration)]
    graph, mix_in = [], []
    graph.append("[0:a]aformat=sample_rates=48000:channel_layouts=mono,asplit=2[vo][key]")
    mix_in.append("[vo]")
    n = 1
    if cfg.get("music"):
        music = story_dir(args.slug) / cfg["music"]
        if not music.exists():
            die(f"music file {music} not found")
        inputs += ["-stream_loop", "-1", "-i", str(music)]
        graph.append(f"[{n}:a]aformat=sample_rates=48000:channel_layouts=mono,atrim=0:{dur},"
                     f"volume={cfg.get('music_db', -22)}dB[bed]")
        graph.append("[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[duck]")
        mix_in.append("[duck]")
        n += 1
    else:
        graph.append("[key]anullsink")
    for s in story.get("sfx", []):
        if s["cue"] not in tl["cues"]:
            die(f"sfx cue {s['cue']!r} not in timeline")
        ms = int(tl["cues"][s["cue"]] * 1000 / fps)
        inputs += ["-i", str(story_dir(args.slug) / s["file"])]
        graph.append(f"[{n}:a]aformat=sample_rates=48000:channel_layouts=mono,"
                     f"volume={s.get('db', -6)}dB,adelay={ms}|{ms}[s{n}]")
        mix_in.append(f"[s{n}]")
        n += 1
    graph.append(f"{''.join(mix_in)}amix=inputs={len(mix_in)}:normalize=0:duration=first,"
                 f"apad,atrim=0:{dur},afade=t=in:d={fade},afade=t=out:st={dur - fade}:d={fade},"
                 # Stereo BEFORE measuring: BS.1770 sums channels, so a mono mix copied to
                 # two channels afterwards would land 3 LU louder than the target.
                 "pan=stereo|c0=c0|c1=c0[pre]")
    pre = out / "premix.wav"
    ffmpeg(*inputs, "-filter_complex", ";".join(graph), "-map", "[pre]", "-ar", "48000",
           "-c:a", "pcm_s16le", str(pre))

    m = loudnorm_measure(pre, target, tp)
    print(f"premix: {float(m['input_i']):.1f} LUFS, true peak {float(m['input_tp']):.1f} dBTP")
    mix = out / "mix.wav"
    n_samples = round(dur * 48000)
    ffmpeg("-i", str(pre), "-af",
           f"loudnorm=I={target}:TP={tp}:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
           f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:"
           f"offset={m['target_offset']}:linear=true,aresample=48000,"
           f"apad,atrim=end_sample={n_samples}",
           "-c:a", "pcm_s16le", str(mix))
    pre.unlink()
    print(f"mix:   {mix}")
    if args.no_mux:
        return
    picture = out / "picture.mp4"
    if not picture.exists():
        die(f"{picture} is missing; run pipeline/captions.py first (or pass --no-mux)")
    final = out / "final.mp4"
    ffmpeg("-i", str(picture), "-i", str(mix), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(final))
    print(f"final: {final}")


if __name__ == "__main__":
    main()
