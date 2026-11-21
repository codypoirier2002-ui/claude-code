# Mandelbulb dive: a 7-second clip made only from code

Everything in the clip is computed from math: no models, textures, footage, samples or
other assets. The picture comes from one distance estimator for the power-8 Mandelbulb.
The sound comes from oscillators and noise.

| File | What it does |
| --- | --- |
| `bulb.cpp` | AVX-512 CPU ray marcher: 16 sub-pixel rays per SIMD packet, adaptive anti-aliasing, soft shadows, AO, orbit-trap materials, bloom, AgX tonemapping, film grain |
| `score.py` | numpy synth: additive chord pad, zoom-synced noise dive, bell glints, convolution reverb |
| `scene.env` | Camera path, light and dive target |
| `render.sh` | Builds, renders, synthesizes the score and encodes the MP4 (resumable) |

```bash
./render.sh                        # final: 3840x2160, 60 fps, adaptive 4-20 spp
W=960 H=540 SPP=4 OUT=preview.mp4 ./render.sh   # quick preview
```

It needs `g++` with OpenMP, a CPU with AVX-512, `python3` with numpy, and `ffmpeg`.

The final render takes about 2 h 40 min on 4 vCPUs (Xeon, 2.1 GHz). Close-up frames take
the longest, about 37 s each at 4K, because more pixels get the extra 16 samples. The render
writes 16-bit PPM frames, about 50 MB each and 21 GB in total. `render.sh` then encodes two
files: a 4K60 master (H.264 CRF 14, about 290 Mbit/s, roughly 250 MB) and a 1080p60 copy
(about 55 MB). The master suits desktop playback and uploading to YouTube or Vimeo; on a
phone, play the 1080p copy.
