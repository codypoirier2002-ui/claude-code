#!/usr/bin/env python3
"""Turn the generated sound-effect takes into Orbit's 30 s Opus loops (docs/ASSETS.md, "Soundscapes").

For every id, from SRC/{id}.mp3:
 1. measure the integrated loudness with ffmpeg ebur128. A take below -45 LUFS is effectively silent and is refused:
    regenerate it with "continuous ... clearly audible" wording (docs/SPEC.md section 13.3);
 2. apply gain to reach -23 LUFS, limit with alimiter (limit 0.9, level=0, because the default auto-level adds the
    gain back), pad or cut to exactly 30 s, and encode libopus at 80 kb/s, 48 kHz, no metadata, to OUT/{id}.ogg;
 3. check the result: a decoded length of exactly 1,440,000 samples (30.000 s) that the Ogg granule position agrees
    with, an integrated loudness within 0.5 LU of -23; print the peaks and the level step across the loop join
    (|RMS of the first 100 ms - RMS of the last 100 ms|, in dB).
Opus rather than MP3: MP3 encoder padding leaves a gap every loop. ffprobe reports 30.0065 s for these files because it
counts the 312-sample Opus pre-skip, which decoders drop, leaving exactly 30.000 s.
Needs Python 3 and ffmpeg + ffprobe on PATH, ffmpeg built with libopus. No Python packages.

  python scripts/assets/encode_soundscapes.py --src DIR [--out public/ambience] [--ext mp3] [--only ID ...]
      ids: beach lake loft deck forest rooftop clock. Exit status 1 if a take was refused or a check failed.
"""
import argparse
import math
import re
import struct
import subprocess
import sys
from array import array
from pathlib import Path

IDS = ["beach", "lake", "loft", "deck", "forest", "rooftop", "clock"]
TARGET = -23.0         # LUFS
SILENT_BELOW = -45.0   # LUFS
TOLERANCE = 0.5        # LU
RATE = 48000
SAMPLES = 30 * RATE    # 1,440,000


def measure(path):
    """ebur128 summary of a file: integrated loudness (LUFS), sample peak and true peak (dBFS)."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
                        "-af", "ebur128=framelog=verbose:peak=sample+true", "-f", "null", "-"],
                       capture_output=True, text=True)
    k = r.stderr.rfind("Summary:")
    if k < 0:
        raise RuntimeError("no ebur128 summary for %s\n%s" % (path, r.stderr[-800:]))
    s = r.stderr[k:]
    num = r"(-?inf|-?\d+(?:\.\d+)?)"

    def grab(pattern):
        m = re.search(pattern, s)
        return float(m.group(1)) if m else None

    return dict(I=grab(r"\bI:\s+" + num + r"\s+LUFS"),
                sample_peak=grab(r"Sample peak:\s*\n\s*Peak:\s+" + num + r"\s+dBFS"),
                true_peak=grab(r"True peak:\s*\n\s*Peak:\s+" + num + r"\s+dBFS"))


def decode(path):
    """The decoded file as interleaved stereo float samples at 48 kHz."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "2", "-ar", str(RATE), "-"],
                       capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg could not decode %s" % path)
    a = array("f")
    a.frombytes(r.stdout)
    if sys.byteorder == "big":
        a.byteswap()
    return a


def rms_db(samples):
    return 20 * math.log10(max(math.sqrt(sum(x * x for x in samples) / len(samples)), 1e-12))


def ogg_length(path):
    """Samples a decoder yields from an Ogg Opus file: the last granule position minus the OpusHead pre-skip."""
    data = Path(path).read_bytes()
    pos, pre_skip, last = 0, None, None
    while pos < len(data):
        if data[pos:pos + 4] != b"OggS":
            raise ValueError("not an Ogg stream at byte %d of %s" % (pos, path))
        granule = struct.unpack_from("<q", data, pos + 6)[0]
        nseg = data[pos + 26]
        body_len = sum(data[pos + 27:pos + 27 + nseg])
        body = data[pos + 27 + nseg:pos + 27 + nseg + body_len]
        if pre_skip is None and body[:8] == b"OpusHead":
            pre_skip = struct.unpack_from("<H", body, 10)[0]
        if granule != -1:
            last = granule
        pos += 27 + nseg + body_len
    return last - pre_skip


def encode(src, out, gain):
    """The one ffmpeg call that makes a loop: gain, limiter, pad, cut to 30 s, libopus 80 kb/s."""
    af = "volume=%.4fdB,alimiter=limit=0.9:level=0,apad" % gain
    cmd = ["ffmpeg", "-y", "-hide_banner", "-nostats", "-v", "error", "-i", str(src), "-af", af, "-t", "30",
           "-ar", str(RATE), "-map_metadata", "-1", "-c:a", "libopus", "-b:a", "80k", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg failed on %s: %s" % (src, r.stderr[-600:]))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, required=True, help="folder with the takes, one {id}.<ext> per soundscape")
    ap.add_argument("--out", type=Path, default=Path("public/ambience"), help="folder for {id}.ogg (default: %(default)s)")
    ap.add_argument("--ext", default="mp3", help="extension of the takes (default: %(default)s)")
    ap.add_argument("--only", nargs="+", metavar="ID", default=None, help="soundscapes to encode (default: all seven)")
    args = ap.parse_args(argv)
    ids = args.only or IDS
    bad = [s for s in ids if s not in IDS]
    if bad:
        ap.error("unknown soundscape %s; choose from %s" % (bad, IDS))
    args.out.mkdir(parents=True, exist_ok=True)
    failed = []
    print("%-8s %8s %8s %8s %8s %8s %9s %8s %7s %8s" %
          ("id", "in LUFS", "gain dB", "out LUFS", "smpl pk", "true pk", "samples", "seconds", "join dB", "bytes"))
    for sid in ids:
        src, out = args.src / ("%s.%s" % (sid, args.ext)), args.out / ("%s.ogg" % sid)
        if not src.is_file():
            print("%-8s missing %s" % (sid, src))
            failed.append(sid)
            continue
        loud = measure(src)["I"]
        if loud is None or loud < SILENT_BELOW:
            print("%-8s %8s LUFS is effectively silent: not encoded. Regenerate it with 'continuous ... clearly audible' wording."
                  % (sid, loud))
            failed.append(sid)
            continue
        gain = TARGET - loud
        encode(src, out, gain)
        m = measure(out)
        pcm = decode(out)
        n = len(pcm) // 2
        edge = RATE // 10 * 2  # 100 ms of interleaved stereo
        join = abs(rms_db(pcm[:edge]) - rms_db(pcm[-edge:]))
        out_i = m["I"] if m["I"] is not None else float("nan")
        ok = n == SAMPLES and ogg_length(out) == SAMPLES and abs(out_i - TARGET) <= TOLERANCE
        print("%-8s %8.1f %+8.2f %8.1f %8.1f %8.1f %9d %8.3f %7.2f %8d  %s" %
              (sid, loud, gain, out_i, m["sample_peak"], m["true_peak"], n, n / RATE, join, out.stat().st_size,
               "ok" if ok else "CHECK FAILED"))
        if not ok:
            failed.append(sid)
    if failed:
        print("refused or failed: " + " ".join(failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
