# Emulator scripts: the hands-only pass and the demo video

These drive Orbit in Meta's Immersive Web Emulation Runtime (IWER), emulating a
Meta Quest 3 in hand mode with no controller. They are dev tools, not part of the
app: nothing here is bundled, type-checked or run by `npm test`.

- `handspass.mjs` pinches every VR action and reports PASS/FAIL per action, with a
  screenshot of each (the table in `docs/CONTEST.md` came from it).
- `thinkstop.mjs` pinches Stop during a live reply and Think harder after one (it needs
  the demo server's keys and spends one short reply and one Opus re-answer).
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
node scripts/emulator/thinkstop.mjs https://orbit-demo-lake.vercel.app/ out/thinkstop
node scripts/emulator/record.mjs https://orbit-demo-lake.vercel.app/ out/video --dry
ORBIT_ASK_WAV=/path/to/ask.wav node scripts/emulator/record.mjs https://orbit-demo-lake.vercel.app/ out/video
```

`--dry` skips the voice and reply shots (no keys needed). The full take needs the
demo server's keys, and a WAV of the spoken request: 16-bit PCM, about a second of
silence, the request, then some silence. The recorder hands Orbit a microphone stream
it controls: silent until the script says the request (after her greeting), when it
plays the WAV into it. The same WAV is mixed into the soundtrack at that moment, since
the mic's sound never reaches the page's output.

A take stops early (exit code 1, nothing assembled) if the request never reaches the
chat or she never answers, so a failed take spends little.

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
- Under the recording's load, the emulator's audio clock stalls for seconds at a
  time when a scene loads for the first time (13 s once). The picture carries on, and
  the recorded sound gets holes. The page's audio timestamps are wall-clock, so the
  assembly fills each hole with silence where it is (`aresample=async=1`). Packing
  the samples together instead makes the sound run ahead of the picture by the total
  of the holes; the first two takes did that. To keep holes from happening, every
  scene is visited once before recording starts.
- The encoded video goes to Node in batches (every half second, or 512 KB). Sent one
  frame per call, it kept the DevTools connection so busy that the script's own calls
  queued behind it: a Talk pinch once landed 30 s late, and saving took minutes after
  the last shot.
- Chrome's file-backed fake microphone took about 10 s to open while recording, and
  it starts playing its file the moment it opens, over her greeting. Hence the
  controlled microphone stream.
- The first Talk of a visit starts with her greeting, whose expressive voice can take
  seconds to arrive; a request said before it plays barges into it, and barge-in keeps
  only the end of the request. So the script uses the greeting up (a Talk and End voice)
  before recording starts. It also pinches End voice within a few seconds of her answer:
  the listen step gives up after 9 s of silence, and a later pinch starts a new session.
- The script follows her voice by counting one-shot audio buffer sources that are
  playing: Orbit plays her speech through those and the soundscapes through looping
  ones. Loudness can't tell them apart, since the soundscape ducks under her voice.
- The end checks that the soundtrack decodes to the picture's length and that the
  video is under 3 minutes.
