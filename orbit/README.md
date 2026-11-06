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

Orbit has no server of its own. You paste your Anthropic API key (and, for voice, an
ElevenLabs key) into the app's Settings. They are kept only in that browser's
localStorage and sent only to their own APIs. If you set an API proxy URL, the
Anthropic key is not sent at all: the proxy adds it server-side.

The only network calls the app makes are to the Claude API (or your proxy), to
ElevenLabs, and to its own static files. Settings → "Erase all data" removes everything
it stored.

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
   already ignores keystores and every bubblewrap output. Then, from `twa/`:

   ```sh
   bubblewrap update && bubblewrap build
   ```

4. **Link the app to the site.** Add `/.well-known/assetlinks.json` to the deployed site
   with your package id and the SHA-256 fingerprint of your signing key (bubblewrap
   prints it; `bubblewrap fingerprint` shows it again). Put the file in
   `public/.well-known/` and deploy again.
5. **Upload** the signed build to the ALPHA release channel with
   `ovr-platform-util upload-quest-build --app-id <id> --app-secret <secret> --apk app-release-signed.apk --channel ALPHA`.
