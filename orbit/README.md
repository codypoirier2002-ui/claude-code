# Orbit

Orbit is an all-in-one Claude assistant for the Meta Quest Browser, with Callie: an
animated companion who chats, talks out loud, keeps your timers and notes, and joins
you in VR. It is a Vite + TypeScript web app that installs as a PWA, and it can be
packaged for the Quest store.

## Features

- **Chat** that reads like a messenger: Callie's face and name on her replies, the model
  that answered ("Haiku → Opus"), typing dots, follow-up suggestion chips, and the VR
  scene you picked blurred behind the chat.
- **Model routing.** Auto mode answers with Claude Haiku 5.5, hands careful thinking to
  Claude Opus 5.5 and the hardest problems to Claude Fable 5.1. "Think harder" asks again
  one tier up. Seven modes (Everyday, Quest Guide, Game Coach, Fitness, Tutor, Creator
  and Play), each with its own quick prompts, and three personalities.
- **Web search** when you turn on Web.
- **Voice.** "Talk" opens hands-free voice mode: she listens, answers out loud, lip-syncs,
  and stops when you talk over her. Speech goes through ElevenLabs (the Quest Browser has
  no built-in speech recognition); desktop browsers can fall back to their own.
- **Everyday tools.** Timers, daily reminders, Pomodoro focus sessions with a halfway
  check-in, a to-do list, notes, and memories she keeps between chats. A short greeting
  when you open the app, and a daily streak on the "You & Callie" card.
- **Look.** 👁 in the composer sends one headset-camera frame with your message. With
  "Look when I say “look at this”" on, voice phrases like "what is this?" do the same.
- **VR.** "Enter VR" places you in one of seven scenes: a sky that follows the clock, or
  one of six 360° panoramas with their own soundscape and drifting particles. A chat
  panel with an on-panel keyboard floats in front of you; Callie stands beside it as a
  hologram or as your own VRM body, waves back when you wave, and moves where you point.
  "Passthrough" does the same over your room.

## Your keys stay in your browser

An ordinary build of Orbit has no server of its own (a [demo build](#demo-builds) adds
one, for visitors without keys). You paste your Anthropic API key (and, for voice, an
ElevenLabs key) into the app's Settings. They are kept only in that browser's
localStorage and sent only to their own APIs. If you set an API proxy URL, the
Anthropic key is not sent at all: the proxy adds it server-side.

The only network calls the app makes are to the Claude API (or your proxy), to
ElevenLabs, and to its own static files. Settings → "Erase all data" removes everything
it stored.

### Demo builds

A build made with `VITE_ORBIT_DEMO=1` is for a hosted link that works without keys
(the contest entry). It differs in one way: for a service where the visitor has entered
no key of their own (and, for Claude, no proxy URL), calls go to the demo host's own
server functions instead, on the same origin:

- Claude: `/api/claude/v1/messages` ([api/claude/v1/messages.ts](api/claude/v1/messages.ts)),
  which adds the host's `ANTHROPIC_API_KEY`.
- ElevenLabs: `/api/eleven?path=…` ([api/eleven.ts](api/eleven.ts)), which adds the host's
  `ELEVENLABS_API_KEY`.

The host's keys stay on the server and never reach the page. A key the visitor enters
always wins, is kept only in their browser as above, and goes straight to its own API;
the demo server never sees it. Ordinary builds have no such path.

What the demo server allows:

- **Claude:** Claude Haiku 5.5 and Claude Opus 5.5 only. Fable requests run on Opus, and
  the app says "Auto: Haiku · Opus" in VR. `max_tokens` is capped at 16,000, web search
  at 3 uses per request, and fast mode and fallback lists are dropped
  (`fallbacks: "default"` stays: Opus falls back only to older Opus models). A request
  may be at most 4 MB and carry at most 400,000 characters of text.
- **ElevenLabs:** exactly the four calls the app makes (speech to text, the two
  streaming speech calls, the voice list), at most 4 MB per request and 1,200
  characters of speech per call. The app splits long replies to stay under that.
  When ElevenLabs answers with an error, the function logs one line of its codes (such
  as `input_text_empty`) for the host, never the message or anything that was said.
- **Both:** same-origin requests only, and a per-IP limit (90 Claude calls and 240
  voice calls per 10 minutes).

These checks are speed bumps, not locks. The origin check and the per-IP count can be
faked by a script (the count also lives in each server instance's memory), so the real
caps are the host's own limits: a spend limit on the Claude Console workspace the key
belongs to, and a credit limit on the ElevenLabs key. The voice list call shows visitors
the voices in the host's ElevenLabs account, so use an account (or a restricted key)
made for the demo.

## Run it

Node 20.19 or later.

```sh
npm install
npm run dev        # https://localhost:5173 and https://<your-LAN-IP>:5173
npm test           # vitest
npm run typecheck
npm run build      # type-checks, then builds to dist/
npm run preview    # serves dist/ the same way
```

### HTTPS on your LAN (testing on the headset)

WebXR and the microphone only work over HTTPS, so `dev` and `preview` serve a
self-signed certificate (`@vitejs/plugin-basic-ssl`) on every network interface. Put the
Quest on the same Wi-Fi, open `https://<your-computer's-LAN-IP>:5173` in the Quest
Browser, and accept the certificate warning once. Set `ORBIT_HTTP=1` to serve plain HTTP
instead (fine on `localhost`, not on the headset).

The service worker registers only in production builds (`npm run build`, then `npm run
preview` or a deploy), so development never serves stale files.

### VR on a desktop: `?xr-preview`

Open `https://localhost:5173/?xr-preview` to run the VR scene in a normal window. The
mouse ray acts as a controller, a click is a select, the wheel scrolls, and physical keys
type while the panel keyboard is open. Extra parameters:

| Parameter | What it does |
| --- | --- |
| `?yaw=<deg>` | Look around; 180 looks behind you, at the panorama seam. |
| `?avatar-cam` | A close-up of Callie at her default spot. |
| `?kb` | Opens the panel keyboard. |
| `?wave` | She waves every 3 s. |
| `?hour=<h>` | Shows the clock sky at that hour. |

Combine them: `?xr-preview&avatar-cam`, `?xr-preview&hour=21&yaw=180`.

### Assets

Callie's character layers, the panoramas and the soundscapes are in `public/`. How they
were made, and how to make new ones, is in [docs/ASSETS.md](docs/ASSETS.md). The app
icons are generated with `npm run icons` (`scripts/make-icons.mjs`, with sharp).

## Deploy

Any static host works; the build is `dist/`. On Vercel, make the app folder (`orbit/`)
the project's root. `vercel.json` sets the build (`npm run build`, output `dist`) and the
headers the app needs:

- `/sw.js` is served with `Cache-Control: no-cache`, so a new build's worker is picked
  up straight away (each build also gets its own cache name).
- `/manifest.webmanifest` is served as `application/manifest+json`.
- Every page gets `Permissions-Policy: microphone=(self), xr-spatial-tracking=(self)`.

The two files under `api/` are Vercel Functions for [demo builds](#demo-builds). An
ordinary build never calls them; deployed without keys they answer 503. `vercel.json`
gives them up to 300 seconds, for long streamed replies.

To host a demo build on Vercel:

1. Make `orbit/` the project's root directory.
2. Add the environment variable `VITE_ORBIT_DEMO` = `1` (it is read at build time).
3. Add `ANTHROPIC_API_KEY` (from a Claude Console workspace with a monthly spend limit)
   and `ELEVENLABS_API_KEY` (restricted to Text to Speech, Speech to Text and Voices,
   with a credit limit) as sensitive environment variables.
4. Deploy, or redeploy after changing any of them: a running deployment keeps the
   values it was built and started with.

Orbit is also an installable PWA: open the deployed URL in the Quest Browser and install
it from the browser's menu to get it without the store.

## The Quest store

Orbit is packaged for the Meta Horizon Store as a Trusted Web Activity with
`@meta-quest/bubblewrap-cli`. Two templates live in `twa/`; pick one:

- **2D build** (`twa/twa-manifest.template.json`): `horizonOSAppMode` "2D", start URL
  `/`. Orbit opens as a panel in the Horizon home. It opens straight into VR only when
  the user turns on "Open straight into VR" in Settings and the app is set up.
- **Immersive build** (`twa/twa-manifest.immersive.template.json`): `horizonOSAppMode`
  "immersive", start URL `/?launch=vr`. Orbit opens straight into VR, even before setup.
  If the headset refuses VR it falls back to the 2D app with a toast, and once the app is
  set up, leaving VR closes it.

The app knows it is the store build because the Quest Browser exposes
`getDigitalGoodsService` there; on the open web `?launch=vr` does nothing.

Steps:

1. **Deploy** the app to your HTTPS domain (see above).
2. **Check the manifest.** Open `https://<your-domain>/manifest.webmanifest` and make
   sure it loads, with the three icons.
3. **Fill in the template.** Copy the template you picked to `twa/twa-manifest.json` and
   replace `REPLACE_ORG` (your package id, `com.<org>.orbit`), `REPLACE_DOMAIN` and the
   signing key's path and alias. Keep the keystore outside the repository; `.gitignore`
   already ignores keystores and every bubblewrap output. Install the CLI once with
   `npm i -g @meta-quest/bubblewrap-cli` (its first run downloads a JDK and the Android
   SDK). It has no password flags: it reads the keystore and key passwords from the
   `BUBBLEWRAP_KEYSTORE_PASSWORD` and `BUBBLEWRAP_KEY_PASSWORD` environment variables.
   Then, from `twa/`:

   ```sh
   bubblewrap update && bubblewrap build
   ```

   The build writes `app-release-signed.apk`. Raise the version code for every upload.

4. **Link the app to the site.** Add `/.well-known/assetlinks.json` to the deployed site
   with your package id and the SHA-256 fingerprint of your signing key.
   `bubblewrap fingerprint generateAssetLinks` writes that file for you
   (`bubblewrap fingerprint list` shows the fingerprints it knows). Put the file in
   `public/.well-known/` and deploy again.
5. **Upload** the signed build to the ALPHA release channel with
   `ovr-platform-util`. `--age-group` is required (`TEENS_AND_ADULTS`, `MIXED_AGES` or
   `CHILDREN`), and `--token` can stand in for `--app-secret`:

   ```sh
   ovr-platform-util upload-quest-build --app-id <id> --app-secret <secret> --apk app-release-signed.apk --channel ALPHA --age-group TEENS_AND_ADULTS
   ```
