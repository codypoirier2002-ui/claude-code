// Shared helpers: launch Chrome with IWER (Meta's Immersive Web Emulation
// Runtime) injected, map Orbit's panel and keyboard pixels to world points, and
// aim + pinch an emulated hand. See README.md in this folder.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} (see scripts/emulator/README.md).`);
  return v;
};
/** A playwright-core folder (no browsers needed: the scripts drive the installed Chrome). */
export const { chromium } = require(need("PLAYWRIGHT_CORE"));
/** IWER's UMD bundle: node_modules/iwer/build/iwer.js from `npm install iwer`. */
export const IWER_JS = need("IWER_JS");

// ---- Orbit's layout (src/xr/immersive.ts, panel.ts, keyboard.ts) ----
const PANEL = { pos: [0, 1.42, -1.15], tilt: -Math.atan2(1.6 - 1.42, 1.15), w: 0.9, h: 1.125, cw: 1280, ch: 1600 };
const KB = { pos: [0, 0.7775, -0.73], tilt: -0.85, w: 0.9, h: 0.39375, cw: 1280, ch: 560 };

/** Where Orbit's rig sits after Recenter (yaw 0 assumed): set by measureRig(). */
export const RIG = { x: 0, y: 0, z: 0 };

function planePoint(p, px, py) {
  const lx = (px / p.cw - 0.5) * p.w;
  const ly = (0.5 - py / p.ch) * p.h;
  // `n`: the plane's normal, used to correct the aim.
  return {
    x: RIG.x + p.pos[0] + lx,
    y: RIG.y + p.pos[1] + ly * Math.cos(p.tilt),
    z: RIG.z + p.pos[2] + ly * Math.sin(p.tilt),
    n: { x: 0, y: -Math.sin(p.tilt), z: Math.cos(p.tilt) },
  };
}

/**
 * three.js puts its VR camera behind the two eyes so one frustum covers both
 * (WebXRManager setProjectionFromUnion); Orbit recentres the rig on that camera.
 * This works the same position out from the emulator's views.
 */
export async function measureRig(page) {
  const cam = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const s = globalThis.__xr.activeSession;
        s.requestAnimationFrame((_t, f) => {
          const p = f.getViewerPose(globalThis.__ref);
          const [L, R] = p.views;
          const pl = L.projectionMatrix;
          const pr = R.projectionMatrix;
          const leftFov = (pl[8] - 1) / pl[0];
          const rightFov = (pr[8] + 1) / pr[0];
          const a = L.transform.position;
          const b = R.transform.position;
          const ipd = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
          const zOffset = ipd / (-leftFov + rightFov);
          const xOffset = zOffset * -leftFov;
          // Measured in screenshots: this three.js recentres on the left eye's camera.
          resolve(globalThis.__rigFromUnion ? { x: a.x + xOffset, y: a.y, z: a.z + zOffset } : { x: a.x, y: a.y, z: a.z });
        });
      }),
  );
  RIG.x = cam.x;
  RIG.y = Math.max(-1, cam.y - 1.6);
  RIG.z = cam.z;
  return { ...RIG };
}
export const panelAt = (px, py) => planePoint(PANEL, px, py);
export const kbAt = (px, py) => planePoint(KB, px, py);

// Panel button centres in canvas pixels.
export const BTN = {
  modePrev: [92, 80],
  modeNext: [1188, 80],
  prompt0: [238, 1185],
  prompt1: [640, 1185],
  prompt2: [1042, 1185],
  talk: [238, 1301],
  type: [640, 1301],
  think: [1042, 1301],
  aloud: [188.5, 1417],
  recenter: [489.5, 1417],
  scene: [790.5, 1417],
  exit: [1091.5, 1417],
  scrollUp: [1176, 306],
  scrollDown: [1176, 972],
  conv: [500, 600],
};
// Keyboard: letter keys and the bottom row.
const ROW_Y = [122, 202, 282, 362, 442];
const LETTERS = ["1234567890", "qwertyuiop", "asdfghjkl'", "zxcvbnm,.?"];
export function keyAt(ch) {
  for (let r = 0; r < 4; r++) {
    const i = LETTERS[r].indexOf(ch);
    if (i >= 0) return kbAt(24 + i * 124 + 58, ROW_Y[r] + 36);
  }
  const bottom = { shift: 176, layer: 176, space: 456, backspace: 176, send: 216 };
  let x = (1280 - (176 * 3 + 456 + 216 + 8 * 4)) / 2;
  for (const [id, w] of Object.entries(bottom)) {
    if (id === ch) return kbAt(x + w / 2, ROW_Y[4] + 36);
    x += w + 8;
  }
  throw new Error(`no key ${ch}`);
}

export async function launch({ headless = true, width = 1280, height = 720, url, extraInit, args: extraArgs = [] } = {}) {
  const browser = await chromium.launch({
    channel: "chrome",
    headless,
    args: [
      "--ignore-gpu-blocklist",
      "--enable-gpu",
      "--use-angle=d3d11",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      ...extraArgs,
    ],
  });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await context.grantPermissions(["microphone"], { origin: new URL(url).origin });
  await context.addInitScript({ path: IWER_JS });
  await context.addInitScript(() => {
    const device = new globalThis.IWER.XRDevice(globalThis.IWER.metaQuest3);
    device.installRuntime({ forceInstall: true });
    device.stereoEnabled = false;
    device.primaryInputMode = "hand";
    globalThis.__xr = device;
  });
  if (extraInit) await context.addInitScript(extraInit);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  return { browser, context, page };
}

export const remote = (page, method, params = {}) =>
  page.evaluate(([m, p]) => globalThis.__xr.remote.dispatch(m, p), [method, params]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The hand's real target ray (origin and direction), read from the session the app runs. */
export async function rayOf(page, handedness) {
  return page.evaluate(async (h) => {
    const s = globalThis.__xr.activeSession;
    if (!s) return null;
    if (globalThis.__refSession !== s) {
      globalThis.__ref = await s.requestReferenceSpace("local-floor");
      globalThis.__refSession = s;
    }
    return new Promise((resolve) =>
      s.requestAnimationFrame((_t, f) => {
        const src = [...s.inputSources].find((i) => i.handedness === h);
        const p = src && f.getPose(src.targetRaySpace, globalThis.__ref);
        if (!p) return resolve(null);
        const { x, y, z } = p.transform.position;
        const q = p.transform.orientation;
        resolve({
          o: { x, y, z },
          d: { x: -2 * (q.x * q.z + q.w * q.y), y: -2 * (q.y * q.z - q.w * q.x), z: -(1 - 2 * (q.x * q.x + q.y * q.y)) },
        });
      }),
    );
  }, handedness);
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const xyz = (p) => ({ x: p.x, y: p.y, z: p.z });

/**
 * Aims the hand so its real target ray hits `target` on the plane through it
 * with normal `target.n` (look_at aims from the wrist; the ray starts elsewhere).
 */
export async function aimAt(page, target, { hand = "hand-right", from = { x: 0.18, y: 1.25, z: -0.3 } } = {}) {
  await remote(page, "set_transform", { device: hand, position: from });
  let aim = xyz(target);
  for (let i = 0; i < 5; i++) {
    await remote(page, "look_at", { device: hand, target: aim });
    if (!target.n) return;
    await sleep(40);
    const ray = await rayOf(page, hand === "hand-right" ? "right" : "left");
    if (!ray) return;
    const t = dot(sub(target, ray.o), target.n) / dot(ray.d, target.n);
    const hit = { x: ray.o.x + t * ray.d.x, y: ray.o.y + t * ray.d.y, z: ray.o.z + t * ray.d.z };
    const err = sub(hit, target);
    if (Math.hypot(err.x, err.y, err.z) < 0.003) return;
    aim = sub(aim, err);
  }
}

/** Aim the hand's ray at `target`, then pinch. */
export async function pinchAt(page, target, { hand = "hand-right", from = { x: 0.18, y: 1.25, z: -0.3 }, hold = 120, settle = 250 } = {}) {
  await aimAt(page, target, { hand, from });
  await sleep(settle);
  await remote(page, "select", { device: hand, duration: hold / 1000 });
  await sleep(settle);
}

export const settings = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("orbit:settings") || "{}"));
