# Emulator scripts: the hands-only pass and the demo video

These drive Orbit in Meta's Immersive Web Emulation Runtime (IWER), emulating a
Meta Quest 3 in hand mode with no controller. They are dev tools, not part of the
app: nothing here is bundled, type-checked or run by `npm test`.

- `handspass.mjs` pinches every VR action and reports PASS/FAIL per action, with a
  screenshot of each (the table in `docs/CONTEST.md` came from it).
- `record.mjs` records the contest video (shot list in `docs/VIDEO.md`).
- `xr.mjs` launches Chrome with IWER installed before the app loads, maps Orbit's
  panel and keyboard pixels to world points, and aims a hand's real target ray.
- `recorder.mjs` records inside the page.

## Setup

They need the installed Google Chrome, Node 20.19 or later, ffmpeg on the PATH (for
`record.mjs`), and two packages kept outside the project, for example in a temp folder:

```sh
npm install --prefix "$TMP/orbit-emu" --ignore-scripts iwer@2.8.0 playwright-core@1.58.2
```

Then point the scripts at them:

```sh
export PLAYWRIGHT_CORE="$TMP/orbit-emu/node_modules/playwright-core"
export IWER_JS="$TMP/orbit-emu/node_modules/iwer/build/iwer.js"
```

## Run

```sh
node scripts/emulator/handspass.mjs https://orbit-demo-lake.vercel.app/ out/hands
node scripts/emulator/record.mjs https://orbit-demo-lake.vercel.app/ out/video --dry
ORBIT_ASK_WAV=/path/to/ask.wav node scripts/emulator/record.mjs https://orbit-demo-lake.vercel.app/ out/video
```

`--dry` skips the voice and reply shots (no keys needed). The full take needs the
demo server's keys, and a WAV of the spoken request: 16-bit PCM, about a second of
silence, the request, then 20 seconds of silence. Chrome plays it once into the fake
microphone when Orbit opens the mic.

## Things that were not obvious

- IWER defers to a native `navigator.xr`, and desktop Chrome has one, so the runtime
  is installed with `forceInstall: true`.
- `look_at` aims a hand from its wrist, but the target ray starts elsewhere, so
  `aimAt` reads the real ray from the session and corrects until it lands within
  3 mm.
- Orbit recentres on three.js's XR camera, which in this three.js sits at the left
  eye; `measureRig` uses that, or the panel is 3 cm off.
- WebXR frames never reach `canvas.captureStream`, and MediaRecorder was too slow on
  this machine. Each frame is copied to a 2D canvas right after the app draws it,
  captions are drawn on top, and WebCodecs encodes it with the GPU's H.264 encoder at
  a constant 30 fps (after a stall the last picture repeats, so time stays exact).
  The page's own audio is tapped at every AudioContext destination and recorded
  alongside; both carry wall-clock start times for ffmpeg.
- Chrome's screencast is used only for the 2D page, which barely moves.
