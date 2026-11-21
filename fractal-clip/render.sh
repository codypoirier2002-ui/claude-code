#!/usr/bin/env bash
# Build and render the clip end to end: compile, ray-march every frame, synthesize
# the score, encode. Re-running resumes: frames that already exist are skipped.
#
#   ./render.sh                     # 3840x2160, 60 fps, adaptive sampling (final)
#   W=960 H=540 SPP=4 ./render.sh   # quick preview
set -euo pipefail
cd "$(dirname "$0")"

W=${W:-3840}; H=${H:-2160}; FPS=${FPS:-60}; SECS=${SECS:-7}
SPP=${SPP:-0}                       # 0 = adaptive (4 spp, +16 on detail), or 1/2/4/8/16
FRAMES=${FRAMES:-frames}
OUT=${OUT:-mandelbulb_${H}p${FPS}.mp4}
mkdir -p "$FRAMES"

g++ -O3 -march=native -ffast-math -fopenmp -std=c++17 bulb.cpp -o bulb
source scene.env
N=$(python3 -c "print(round($FPS*$SECS))")
./bulb "$FRAMES" "$W" "$H" "$SPP" 0 $((N - 1)) "$FPS" "$SECS"

python3 score.py "$FRAMES/score.wav"

ENC=(-c:v libx264 -preset slow -tune grain -pix_fmt yuv420p -profile:v high
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv
  -c:a aac -b:a 256k -movflags +faststart -shortest)

# master at render resolution
ffmpeg -y -framerate "$FPS" -i "$FRAMES/f%04d.ppm" -i "$FRAMES/score.wav" \
  -vf "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int" \
  -crf 14 "${ENC[@]}" "$OUT"
echo "wrote $OUT"

# lighter 1080p copy for phones and quick sharing, downscaled from the full-res frames
if [ "$H" -gt 1080 ]; then
  SMALL=${OUT%.mp4}_1080p.mp4
  ffmpeg -y -framerate "$FPS" -i "$FRAMES/f%04d.ppm" -i "$FRAMES/score.wav" \
    -vf "scale=-2:1080:flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv" \
    -crf 16 "${ENC[@]}" "$SMALL"
  echo "wrote $SMALL"
fi
