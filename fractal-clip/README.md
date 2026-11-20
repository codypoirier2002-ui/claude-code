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
