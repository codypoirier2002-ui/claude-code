# Motion scenes

Code-rendered 2D and 3D motion graphics for the TikTok science videos. `scripts/motion.js` loads a scene in headless
Chromium, steps time frame by frame, and pipes the frames to ffmpeg, so a render is deterministic and the same on every
machine. `build.js` calls it for any beat or clip with a `motion` visual.

## Built-in scenes

| Scene | What it shows | Main params |
|---|---|---|
| `2d/counter` | A big number counting up, with a ring burst as it lands | `label`, `from`, `to`, `decimals`, `prefix`, `unit`, `sub`, `color` |
| `2d/bars` | Horizontal bars growing in turn, values counting | `title`, `items: [{label, value, color?, display?}]`, `unit`, `decimals`, `max` |
| `2d/scale` | Circles at true relative size (size comparisons) | `title`, `items: [{label, size, color?, image?, sub?}]` |
| `2d/journey` | A light pulse travelling between two points, with a counter | `fromLabel`, `toLabel`, `counter: {label, from, to, unit, decimals}`, `note`, `travel` |
| `3d/model` | Turntable of a `.glb` model (spacecraft, rovers) | `model`, `spin`, `tilt`, `elevation`, `startDistance`, `endDistance`, `label` |
| `3d/planet` | Planet with tilt, spin, terminator, atmosphere glow, optional rings | `model` or `texture` or `color`, `tilt`, `spin`, `atmosphere`, `rings`, `startDistance`, `endDistance` |
| `3d/story-example` | Stylized 3D reenactment shot (Mars Climate Orbiter, 1999) built with `story-kit.js`; copy it to make story shots | `year`, `sub` |
| `3d/orbit` | Satellite orbiting a planet with a trail; optional sunrise counter | `model`/`texture`, `satellite`, `satelliteSize`, `orbitRadius`, `inclination`, `period`, `counter: {label}` |

Every scene also takes `accent`, `bg`, `bg2`, `seed`, and the 3D scenes take `frameY` (where the subject's center sits,
0–1 of the height, default 0.3), `sunDir`, `exposure` and `ambient`. Paths in params are relative to the script file.

## Layout rules

The frame is 1080×1920. `build.js` burns a headline at y ≈ 230–370 and the spoken captions at y ≈ 930–1250, so scenes
keep the main graphic in y ≈ 400–900 and labels in y ≈ 1290–1650 (`ZONE` in `common.js`). TikTok's buttons cover the
right ~15% and its description covers the bottom ~270 px.

## Story kit

`story-kit.js` builds vibrant, toon-shaded 3D reenactments with keyframes, camera moves, particles, a year badge and a post-production pass (bloom, grade, vignette, grain). See its header comment and `3d/story-example.html`.

## Writing a new scene

A scene is an HTML page that:

1. imports helpers from `/scenes/common.js` (and `/scenes/three-common.js` for 3D, with the import map used in `3d/*.html`),
2. reads its options from `window.PARAMS` (`P` in `common.js`; `duration`, `fps`, `width`, `height` are always set),
3. defines `window.renderFrame = (t) => { ... }` that draws the frame for time `t` in seconds **from `t` alone**
   (no `requestAnimationFrame`, no `Date.now()`, seeded randomness via `rng()`), and
4. sets `window.sceneReady = true` once its assets have loaded (`ready()` in `common.js` does this for 2D scenes).

Put a custom scene next to the script and reference it by path: `"motion": {"scene": "my-scene.html", "params": {...}}`.
Preview one quickly with `node scripts/motion.js my-scene.html /tmp/preview.mp4 3 '{"...": 1}'` and sample a frame.

## Assets

- NASA 3D models: `node scripts/find-asset.js model "mars"` lists `.glb` models from science.nasa.gov (planets, moons,
  spacecraft); `node scripts/find-asset.js model-get planet-mars-3d-model assets/mars.glb` downloads one. Credit "NASA".
- three.js (pinned) is installed into `~/.cache/tiktok-science/motion` on first use. WebGL runs on SwiftShader, so no GPU
  is needed; a 3D scene renders at about 3–6 frames per second.
