# Animated true-story pipeline

Short vertical (1080×1920, 30 fps) animated videos about true stories, made with Blender
scenes written as Python, a generated voice, and ffmpeg. The first story is
**[The Man Who Doubted the Machine](stories/petrov-1983/story.json)**: Stanislav Petrov and
the 1983 Soviet nuclear false alarm, about 41 s and 1,230 frames with the Piper voice.

```
1 research ─▶ story.json ─▶ 2 voice ─▶ timeline.json ─┬─▶ 3 scenes.py ─▶ scene.blend
                                                      │      │
                                                      │      ├─▶ 4 test frames ─▶ contact sheet ─┐
                                                      │      │        ▲  fix the worst thing ◀────┘
                                                      │      └─▶ 5 final EEVEE frames
                                                      └─▶ 6 captions + mix ─▶ final.mp4 ─▶ QC
```

The one rule: **every timing lives in `build/<slug>/timeline.json`**. Scenes, test-frame
picks, captions, sound effects and QC all read it. Re-voice a line and everything re-times on
the next build; nothing has hard-coded seconds.

## Requirements

- Blender 4.2 LTS or newer (`/Applications/Blender.app` is found automatically, or set `BLENDER=`)
- ffmpeg with libass (`brew install ffmpeg`)
- Python 3.9+, standard library only
- A voice: ElevenLabs (best: exact word timestamps), macOS `say`, or Piper
  (`../.claude/skills/tiktok-science-video/scripts/setup.sh` installs the pinned one)

## The six steps

| Step | Command | Output |
|---|---|---|
| 1. Research + narration | write `stories/<slug>/story.json`, then `make check` | validated beats, sources, cues |
| 2. Voice + timeline | `make voice` | `voice/narration.wav`, `timeline.json` |
| 3. Scenes | `make scenes` | `scene.blend` from `stories/<slug>/scenes.py` |
| 4. Test frames | `make test` | stamped frames + `contact/latest.png`, a line in `iterations.md` |
| 5. Final render | `make final` | `frames/frame_0000.png` … |
| 6. Post + QC | `make post qc` | `out/final.mp4`, `out/qc.json` |

Use `STORY=<slug>` to pick a story (`make STORY=petrov-1983 test`). `make smoke` runs the whole
chain without Blender or a paid voice.

### 1. Research and narration

`story.json` holds the claim, the sources, and the beats. Each beat has narration `text`, the
`shot` it plays over, the `sources` that back it (plus a `note` quoting them), and optional
`cues`: a name tied to a spoken word, like `{"name": "missile_1", "word": "One"}`. Scenes key
their animation to cues, so the first missile appears on the word "One" whatever the voice.

`check_story.py` fails on a beat with no source, a cue word that isn't spoken, or a shot reused
after another shot. It warns when the hook runs past about 4 s or the estimated length leaves
25–75 s.

### 2. Voice and timeline

`voice.py` synthesizes each beat on its own, trims it to its speech, and lays the beats out
with `pacing` (`lead_in`, `gap`, `tail`, `cut_lead`). Beat boundaries are therefore exact.
Word times come from ElevenLabs' character alignment, or are estimated from the pauses in the
audio for `say`/Piper. Clips are cached by text and voice, so re-running costs nothing unless a
line changed. The narration is padded to a whole number of frames.

```bash
ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... python3 pipeline/voice.py petrov-1983 --backend elevenlabs
```

`timeline.json`: `fps`, `width`, `height`, `total_frames`; `beats[]` with `start_frame`/`end_frame`
and per-word frames; `shots[]` tiling the whole timeline; `cues{name: frame}`; `loop`.

### 3. Scenes as Blender Python

`stories/<slug>/scenes.py` defines `build(ctx)`. `blender/lib.py` gives it primitives,
materials, cameras, lights, `key()`, `pulse()`, `beam()`/`grow()`, and the `Ctx`:
`ctx.start(shot)`, `ctx.end(shot)`, `ctx.cue(name)`, `ctx.beat(id)`, `ctx.sec(s)`,
`ctx.set_collection(name, *shots)` (a set that only renders during its shots, lights included)
and `ctx.bind_camera(shot, cam)` (timeline markers switch cameras). The helpers cover
Blender 4.2–5.x differences (EEVEE engine id, compositor glow).

For a seamless loop, the last shot's camera ends at frame `total_frames` on the first shot's
frame-0 pose, and anything periodic uses `loop_spin` / `orbit_keys` (whole turns over the
timeline). The smoke test checks both.

### 4. Test frames and the contact-sheet loop

```bash
python3 pipeline/render.py petrov-1983 test                    # ~3 frames per shot + cues + loop seam
python3 pipeline/render.py petrov-1983 test --shot glint --per-shot 6
python3 pipeline/contact_sheet.py petrov-1983 --note "sun ray was coming from the camera side"
```

Test frames render at `test_scale`% and `test_samples`, each stamped with
`frame  shot | beat: last words spoken`, so every cell of the sheet says what the viewer is
hearing at that moment. Read `build/<slug>/contact/latest.png`, then fix the **single worst
thing**, in this order:

1. Broken: black or blown frame, camera inside geometry, wrong set visible, missing object.
2. Off-story: the frame doesn't show what the narration is saying at that frame.
3. Unreadable at phone size: subject too small, key text cut off, important detail in the
   bottom ~30% where captions and the app UI sit.
4. Exposure and colour: crushed blacks, glow swallowing detail, palette drifting off the story.
5. Timing: an event lands visibly before or after its word (adjust the cue or the animation).
6. Polish.

Re-render just the affected shot (`--shot`), and note the fix with `--note`. On a machine
without a GPU, EEVEE writes empty frames; add `--engine CYCLES --samples 16` to iterate on
the CPU (same scene, materials and lights; shadows and bounce light differ a little). Every sheet is
logged in `stories/<slug>/iterations.md`, which is checked in.

### 5. Final render

```bash
python3 pipeline/render.py petrov-1983 final
```

Renders every missing frame in chunks (`render.chunk`, default 150), restarting Blender per
chunk so memory can't creep. It prints per-frame time, the running average and an ETA, and
logs them to `frames/render_log.csv`. Stop it any time and run it again to resume: finished
frames are skipped, and 0-byte placeholders from a crash are redone.

Budget on an 18 GB M3 Pro: about 1,300 frames at 1.6–4.4 s each is **35–95 minutes**. Keep it
on power, close GPU-heavy apps, and expect the slow end in the bunker (many lights) and the
close-up (depth of field). If the average climbs past ~4.5 s, lower `render.samples` (32 → 24)
before cutting resolution. At ~3 MB per PNG, the frames need about 4 GB of disk.

### 6. Captions, mix and QC

- `captions.py` writes `captions.ass`: short uppercase chunks (≤3 words), the spoken word in the
  accent colour, placed 27% up from the bottom, above TikTok's UI. It burns them onto the frames
  as `picture.mp4`.
- `mix.py` mixes the narration, an optional ducked music bed and cue-timed sfx. It applies
  20 ms edge fades for a click-free loop, then a two-pass `loudnorm` to −14 LUFS / −1.5 dBTP
  (measured in stereo, the way players measure it), and muxes `final.mp4`.
- `qc.py` checks:
  - Frame count equals the timeline, and audio length matches the video.
  - Resolution and fps.
  - Integrated loudness within ±1 LU, and the true-peak ceiling.
  - The loop seam: SSIM from the last frame to the first must clear `loop.min_ssim` and look
    like an ordinary frame step, and the audio must be quiet at both edges.

  It exits 1 on failure and writes `qc.json`.

## Adding a story

1. `mkdir stories/<slug>`, write `story.json` (copy the Petrov one) and source every beat.
2. `make STORY=<slug> check voice`, and read the shot list it prints.
3. Write `scenes.py` with one `build_<set>(ctx)` per set, timed only through `ctx`.
4. Loop on `make STORY=<slug> test` until the sheet has nothing broken or off-story.
5. `make STORY=<slug> final post qc`.

## Status of the Petrov story

- Voice, timeline, captions, mix and QC run end to end (Piper voice: 1,227 frames, 40.9 s).
- The scenes build and render in Blender 4.2 LTS. Six contact-sheet rounds are logged in
  [`iterations.md`](stories/petrov-1983/iterations.md). They fixed two pipeline bugs only
  real Blender could show (interpolation on Python-inserted keys, and set visibility
  overriding cue visibility; both now guarded by `tests/blender_check.py`), then the
  exposure, the close-up, the hook and one cropped label.
- Those sheets were rendered with Cycles on a CPU. The first EEVEE test pass, on a machine
  with a GPU, is still to come before `make final`.
