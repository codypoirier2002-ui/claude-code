# Generated assets: how they were made and how to rebuild them

Orbit's character art, sky panoramas, soundscapes and app icons are generated, then processed by scripts. This page
records how, so that a file can be rebuilt or replaced. The recipes (prompts, sizes, thresholds) are in
[SPEC.md section 13](SPEC.md#13-assets-make-them-like-this) and, for the icons, in
[section 12](SPEC.md#12-pwa-service-worker-deploy-quest-store); they are not repeated here. This page adds what the spec
leaves out: the models and settings that were used, the processing, where the build departs from the spec and why, and
the commands to run.

The repo keeps the scripts and the shipped files. It does not keep the source takes (the raw model output); see
"Source takes" below.

| Family | Shipped files | Scripts (in `scripts/assets/` unless noted) | Needs |
|---|---|---|---|
| Character | `public/character/` base, think, wow, smile, talk, blink, face (`.webp`) | `make_character.py` | numpy, Pillow, OpenCV |
| Panoramas | `public/skies/{id}.jpg` and `public/skies/thumbs/{id}.jpg` for beach, lake, loft, deck, forest, rooftop | `quilt.py`, `deck_warp.py`, `encode_skies.py`, `seam_choices.json` | numpy, Pillow, OpenCV |
| Soundscapes | `public/ambience/{id}.ogg` for the six scenes and clock | `encode_soundscapes.py` | ffmpeg and ffprobe with libopus |
| Icons | `public/icons/icon-192.png`, `icon-512.png`, `icon-512-maskable.png` | `scripts/make-icons.mjs` (`npm run icons`) | Node, sharp |

Every Python script takes its paths as arguments and explains itself with `--help`. Run them from the project root
(`orbit/`), so the default output folders land in `public/`.

## Setup

- Python 3 with `pip install numpy pillow opencv-python-headless`. There is no requirements file; each script names its
  own needs in its header (`encode_skies.py` needs only numpy and Pillow, `encode_soundscapes.py` no packages at all).
- ffmpeg and ffprobe on the PATH, with libopus (`ffmpeg -encoders` should list `libopus`).
- Node 20.19 or newer and `npm install`, for sharp (a dev dependency).
- Tested with Python 3.15.0, numpy 2.5.4, Pillow 13.0.0, OpenCV 5.0.0, ffmpeg 9.0.2 and sharp 0.35.5. With those, running
  the scripts on the original takes gave the shipped character, panorama and icon files byte for byte, and soundscapes
  that decode to identical samples (the Ogg bytes differ on every run, see "Soundscapes"). Other versions may differ in
  the last bits, because the WebP and JPEG encoders and OpenCV's alignment are not bit-stable across builds.

## Source takes

The takes were generated in a Claude Code session and kept in that session's scratchpad, a temporary folder outside the
repo that is cleared later. They are not in the repo. Regenerating from the prompts gives different takes (the models are
not deterministic), so the shipped files are the reference. The scripts are deterministic: the same takes and tool versions give
the same files.

If you still have the takes, keep them outside the repo (nothing in `.gitignore` covers them). The scripts expect this
layout. In the commands on this page, `TAKES` stands for the folder that holds it: replace it with your path. The
sizes are what the original set came to.

```
TAKES/
  callie/src/   base.png cutout.png blink-1.png blink-2.png talk-1.png talk-2.png smile-1.png smile-2.png
                wow-1.png wow-2.png think-1.png                    768x1024 PNG, about 16 MB
  pano/         {id}-1.png and {id}-2.png for each scene           2896x1440 PNG, about 92 MB
  sfx/          {id}.mp3 for beach lake loft deck forest rooftop clock     30 s, about 4.5 MB
```

What was chosen from them:
- Character: the base is portrait take 3 of 3, and the cutout was made from it. For the expressions the script picks the
  take closest to the base outside the face: blink 2, talk 1, smile 2, wow 2. Think has a single take.
- Panoramas: take 2 of 2 for all six scenes.
- Soundscapes: one take per id. The lake is its first regeneration, saved as `sfx/lake.mp3`; the original lake take
  (-68.6 LUFS) and the second regeneration are not used (see "Soundscapes").

## Character

**Model and settings.** ElevenLabs creative flows. The base portrait and the five expression edits use
`gpt-image-2.5-sunburst` at 3:4, 1K (768x1024), quality high; the edits take the chosen base as the reference image. The
cutout is `birefnet-v2-bg-removal` run on the base.

**Prompts.** SPEC section 13.1, steps 1 and 2, verbatim.

**Processing.** One script does SPEC steps 4 to 7:
1. Align every expression take to the base with OpenCV ECC (affine, 300 iterations, eps 1e-6, Gaussian 5), with the face
   box masked out so the hair and clothes drive the fit. SIFT with RANSAC is the fallback when ECC does not converge. It
   never ran: all nine expression takes converged, with a correlation of 0.990 to 0.998.
2. Keep, for each expression, the take that differs least from the base outside the face box (`--take blink=2` forces one).
3. Build the masks: a thresholded diff mask for blink, talk and smile; two eye ellipses and a mouth ellipse for think and
   wow. Each is feathered and multiplied by the cutout alpha.
4. Write the WebP files (768x1024 RGBA at quality 86; `face.webp` 160x160 at quality 88). Each layer is also composited
   over the base into the work folder for a visual check (`check_sheet.png`, `check_faces.png`, `report.json`): open the
   sheets and look for seams or ghosting.

The files come to base 83 KB, patches 9.5 to 18 KB and face 4.8 KB (the spec expects about 90 KB and 10 to 21 KB).

**Deviation: fitted think and wow ellipses.** The spec centres the eye ellipses at (300, 330) and (470, 330) and the mouth
ellipse at (400, 495). With those, the base portrait's smile line ghosted through the think and wow patches. The shipped
patches use eyes at (300, 330) and (470, 300) and the mouth at (399, 458), which puts the right eye 30 px and the mouth
37 px higher than the spec has them. The radii are the spec's (78x52 and 80x48). The script's defaults are still the
spec's values, and the fitted ones are passed with `--eyes` and `--mouth`.

**Run.**

```
python scripts/assets/make_character.py --src TAKES/callie/src --eyes 300,330,470,300 --mouth 399,458,80,48
```

This writes the seven files to `public/character/` (`--out` changes that) and the checks to `TAKES/callie/work/`
(`--work` changes that).

## Panoramas

**Model and settings.** `flux-3-image` at 2:1, 2K (2896x1440), PNG, two takes per scene. `enhance_prompt` is not a
parameter of that node and its default is already off, so the spec's `enhance_prompt: false` needed no setting.

**Prompts.** SPEC section 13.2, verbatim.

**Processing.**
1. Take 2 of 2 was used for every scene.
2. `quilt.py` repairs the wrap seam (below) and resizes to 2560x1280.
3. `deck_warp.py` straightens the deck's horizon where the two edges were joined.
4. `encode_skies.py` writes progressive JPEGs and 320x160 thumbnails (Lanczos, quality 80). The JPEG quality starts at 82
   and is walked within 70 to 92 until the file is between 0.5 MiB and 0.9 MB; the six landed at quality 81 to 83 and 530
   to 885 KB.

**Deviation: none of the six wrapped cleanly, so the seams were repaired in the image.** The spec expects deck, forest and
rooftop to wrap and hides the other three at run time with a mirrored blend (`seam` .04). Measured on the JPEGs first
shipped, the difference between the first and the last pixel column was 13.6 to 31.9 on all six, against 3.2 to 9.1
between neighbouring columns. So the images were fixed, and `seam` (the run-time blend; 0 turns it off) is 0 for every
scene in `src/core/environments.ts`. The repair works on the 2896x1440 take, per scene:
- Equalise. The per-row difference between the rightmost and leftmost 8 columns is smoothed (Gaussian, sigma 27 px) and
  spread across the width, so both edges meet at their midpoint.
- Overlap and cut. The k rightmost columns are laid over the k leftmost. A minimum-error vertical cut through the overlap
  is found by dynamic programming (pixel and gradient error, moving at most 1 px sideways per row), and the two sides are
  blended across the cut with a Laplacian pyramid. No blur and no mirroring; inpainting the join was tried and rejected.
- Roll and resize. The picture is k columns narrower now. It is rolled by k/2 so the image centre (yaw 0) stays where it
  was, then resized to 2560x1280, which stretches it horizontally by W/(W-k): about 3 percent for k = 96, 6 for k = 160.
- k and the pyramid depth are per scene, in `scripts/assets/seam_choices.json`: k = 96 with 4 levels for lake, forest and
  rooftop; k = 160 with 5 levels for beach, loft and deck.
- Deck only. The Earth horizon had a V-shaped kink where the edges met. `deck_warp.py` moves the join to the middle,
  finds the horizon row of each column in a window of about 400 px, and shifts the columns vertically toward a straight
  line between the window's ends, by up to 48 px. The shift fades out at the window's sides and away from the horizon
  rows, so the bottom frame does not move.

Edge mismatch is the mean absolute difference (0 to 255, all channels) between the first and the last pixel column of the
JPEG. The number in brackets is the same measure between neighbouring columns at the two edges; a panorama wraps when the
first number is close to it.

| scene | first shipped | now |
|---|---|---|
| beach | 31.9 (7.8) | 12.8 (11.6) |
| lake | 13.6 (5.2) | 5.9 (4.7) |
| loft | 30.6 (4.8) | 7.2 (6.3) |
| deck | 14.5 (3.2) | 5.3 (3.4) |
| forest | 25.3 (9.1) | 13.9 (12.4) |
| rooftop | 26.8 (9.1) | 6.2 (4.9) |

**Run.**

```
python scripts/assets/quilt.py final --src TAKES/pano --out TAKES/skies --work TAKES/skies-work
python scripts/assets/deck_warp.py TAKES/skies
python scripts/assets/encode_skies.py --src TAKES/skies
```

- `quilt.py` writes `{id}.png` (2560x1280) to `--out`, and `final_metrics.json` (before and after, k, bands) to `--work`.
- `encode_skies.py` writes `public/skies/{id}.jpg` and `public/skies/thumbs/{id}.jpg` (`--out` changes that) and prints
  the quality, the sizes and the edge mismatch. `--before DIR` also prints it for the JPEGs already in DIR.
- `--only lake` limits `quilt.py` and `encode_skies.py` to one scene.
- `deck_warp.py` is safe to run twice: it always starts from `deck-prewarp.png`, its copy of the quilt output, and
  `quilt.py` deletes that copy whenever it rewrites a scene.
- For a new take, `python scripts/assets/quilt.py candidates --src TAKES/pano --work TAKES/skies-work`
  writes 400 px crops around the join for k = 48, 96 and 160. Choose by eye, then edit `seam_choices.json`.

## Soundscapes

**Model and settings.** ElevenLabs `eleven_text_to_sound_v2`, `duration_seconds` 30, `loop` true, `prompt_influence` 0.4,
and 0.6 for rooftop, clock and the lake regeneration (below). One take per id, saved as MP3.

**Prompts.** SPEC section 13.3, verbatim, except for the lake (below).

**Processing.** `encode_soundscapes.py` does SPEC section 13.3's post-processing for each id:
1. Measure the integrated loudness with ffmpeg `ebur128`. A take below -45 LUFS is effectively silent and is refused.
2. Apply gain to reach -23 LUFS, limit with `alimiter=limit=0.9:level=0` (`level=0` stops the limiter's automatic level
   from adding the gain back), pad or cut to exactly 30 s, and encode with libopus at 80 kb/s, 48 kHz, without metadata.
3. Check the result: a decoded length of exactly 1,440,000 samples that the Ogg granule position agrees with, an
   integrated loudness within 0.5 LU of -23, and a printout of the peaks and of the level step across the loop join.

Opus rather than MP3, because MP3 encoder padding leaves a gap on every loop. ffprobe reports 30.0065 s for these files:
it counts the 312-sample Opus pre-skip, which decoders drop, leaving exactly 30.000 s.

| id | take (LUFS) | gain (dB) | id | take (LUFS) | gain (dB) |
|---|---|---|---|---|---|
| beach | -26.1 | +3.1 | forest | -28.1 | +5.1 |
| lake (regenerated) | -37.8 | +14.8 | rooftop | -26.4 | +3.4 |
| loft | -37.2 | +14.2 | clock | -11.8 | -11.2 |
| deck | -19.5 | -3.5 | | | |

The shipped files measure -22.8 to -23.0 LUFS, with true peaks between -12.0 and -3.3 dBFS. The level step across the
loop join (`join dB` in the printout: the RMS of the first 100 ms against the last 100 ms) is under 1 dB for lake,
loft, deck, rooftop and clock, 3.6 dB for beach and 10.7 dB for forest.

**Deviation: the lake was regenerated.** The spec gives the lake the quiet prompt at influence 0.4. That take measured
-68.6 LUFS, which is effectively silent (it would have needed +45.6 dB of gain to reach -23). The spec's own remedy is to
regenerate with "continuous ... clearly audible" wording. The lake was regenerated at `prompt_influence` 0.6 with this
prompt, which is not in the spec:

> Continuous quiet night by a still mountain lake, steady chorus of soft crickets, gentle water lapping on stones, faint distant frog, calm, close and clearly audible

Two regenerated takes came out at -37.8 and -40.9 LUFS. The first is shipped, because its first and last 100 ms agree
to 0.05 dB (the second: 1.0 dB), which matters in a loop.

**Run.**

```
python scripts/assets/encode_soundscapes.py --src TAKES/sfx
```

This writes `public/ambience/{id}.ogg` (`--out` changes that) and exits with status 1 if a take was refused or a check
failed. `--only lake` limits it to one id, `--ext` changes the source extension (default `mp3`). Re-encoding gives
different Ogg bytes even for identical audio, because the encoder picks a random stream serial number. To compare a
rebuild with a shipped file, compare the decoded samples; the hashes must match:

```
ffmpeg -v error -i public/ambience/beach.ogg -f f32le - | sha256sum
```

**Check in a browser (SPEC section 13.3, step 5).** With the app or any server serving `public/`, run this in the
console of one of its pages. Each line should read `30 1440000 48000 2`; all seven files do in Chromium.

```js
const ctx = new AudioContext({ sampleRate: 48000 });
for (const id of ["beach", "lake", "loft", "deck", "forest", "rooftop", "clock"]) {
  const b = await ctx.decodeAudioData(await (await fetch(`/ambience/${id}.ogg`)).arrayBuffer());
  console.log(id, b.duration, b.length, b.sampleRate, b.numberOfChannels);
}
```

## Icons

**Model and settings.** None: there are no prompts and no takes. `scripts/make-icons.mjs` draws an inline SVG and renders it
with sharp (PNG, compression level 9).

**Design.** SPEC section 12, in the app's own colours (`src/ui/style.css`: `--bg` #0f1218 and `--mint` #7fd8c4): a rounded
square (rx 112), a mint ring (rx 180, ry 62, stroke 14) tilted -18 degrees, and an amber orb (r 110, radial #fff1d6,
#ffb547, #b8670c). The maskable 512 is full-bleed, with a smaller ring (150/52/12) and orb (r 92), so the mark stays
inside the safe zone.

**Addition to the spec: depth.** The spec does not say how the ring and the orb overlap. The ring is split front and back:
the whole ring is drawn first, then the orb, then the ring's near half again over the orb, so the ring seems to pass
behind the orb and in front of it.

**Run.**

```
npm run icons
```

This writes `public/icons/icon-192.png`, `icon-512.png` and `icon-512-maskable.png` (about 9, 31 and 22 KB).
`node scripts/make-icons.mjs DIR` writes them to another folder instead (a relative DIR is resolved from the project
root). Rebuilding gives the shipped PNGs byte for byte. To change the artwork, edit the script, run it and commit the PNGs.
