// VR (§8.1–8.5): the renderer and session, the rig, controllers and the
// desktop preview. Loaded only through dynamic import() from main.ts, which
// talks to it through the XrHost / Immersive contract in ./bridge.ts.
//
// Seams left for later phases:
// - phase 6: `sky.setPanoramaMaterial()` / `sky.showClock()` (scenes), and the
//   lights below get the per-scene colours.
// - phase 7: `presence` (her spot, her hit target, celebrate/wave), the orb's
//   0.35-scale "spark" beside her head, and host.onSpot.

import * as THREE from "three";
import { readJSON, writeJSON } from "../core/store";
import type { AvatarSpot, Immersive, PreviewParams, XrHost, XrMode } from "./bridge";
import { createKeyboard } from "./keyboard";
import { createOrb, orbLevel, orbMood } from "./orb";
import { createPanel } from "./panel";
import { PANEL_TEXT } from "./panelModel";
import { createClockSky } from "./sky";

export type { Immersive };

// ---- Layout (§8.2), in rig space: eye at 1.6 m, −Z straight ahead ----
export const EYE_HEIGHT = 1.6;
export const PANEL_POS = new THREE.Vector3(0, 1.42, -1.15);
export const PANEL_TILT = -Math.atan2(EYE_HEIGHT - 1.42, 1.15);
export const KEYBOARD_POS = new THREE.Vector3(0, 0.7775, -0.73);
export const KEYBOARD_TILT = -0.85;
export const ORB_POS = new THREE.Vector3(-0.75, 1.58, -0.95);
export const DEFAULT_SPOT: Readonly<AvatarSpot> = Object.freeze({ x: -1.05, z: -1.15 });

const RAY_LENGTH = 3;
const RECENTER_DELAY_MS = 300;
const MAX_DT = 0.1;
const STICK_DEADZONE = 0.35;
const STICK_REPEAT_MS = 120;
const FLOOR_MIN = 0.6;
const FLOOR_MAX = 4;
const ACCENT = 0xffb547;

/** `orbit:avatarSpot`, validated; the default spot when missing or malformed. */
export function loadSpot(): AvatarSpot {
  const raw = readJSON<unknown>("avatarSpot", null);
  if (raw && typeof raw === "object") {
    const { x, z } = raw as { x?: unknown; z?: unknown };
    if (typeof x === "number" && typeof z === "number" && Number.isFinite(x) && Number.isFinite(z)) return { x, z };
  }
  return { ...DEFAULT_SPOT };
}

/** The `?hour=` override, when it is a number. */
export function parseHour(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const h = Number(raw);
  return Number.isFinite(h) ? h : null;
}

type HitKind = "panel" | "keyboard" | "orb" | "her" | "floor";

interface Hit {
  kind: HitKind;
  point: THREE.Vector3;
  uv: THREE.Vector2 | null;
  /** World-space normal for the reticle (floor: up). */
  normal: THREE.Vector3;
}

interface Pointer {
  /** Fills `ray` with the pointer's world ray; false when it has no pose. */
  aim(ray: THREE.Ray): boolean;
  reticle: THREE.Mesh;
  hit: Hit | null;
}

export function createImmersive(host: XrHost): Immersive {
  let renderer: THREE.WebGLRenderer | null = null;
  let session: XRSession | null = null;
  let previewing = false;
  let active = false;
  let passthrough = false;
  let lastFrame = 0;
  let time = 0;
  let recenterTimer: ReturnType<typeof setTimeout> | null = null;
  let previewCleanup: (() => void) | null = null;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
  camera.position.set(0, EYE_HEIGHT, 0);
  scene.add(camera);

  // ---- World: sky, stars, floor and lights stay fixed ----
  const sky = createClockSky({ hour: parseHour(new URLSearchParams(location.search).get("hour")) });
  scene.add(sky.group);
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x1a1410, 1);
  const key = new THREE.DirectionalLight(0xffe6c8, 1.3);
  key.position.set(0.5, 2.5, 1.2);
  scene.add(hemi, key);

  // ---- The rig: everything the user interacts with ----
  const rig = new THREE.Group();
  rig.name = "rig";
  scene.add(rig);

  const keyboard = createKeyboard({
    send: (text) => host.send(text),
    onToggle: () => panel.markDirty(),
  });
  const panel = createPanel(host, {
    toggleKeys: () => keyboard.toggle(),
    keysOpen: () => keyboard.isOpen(),
    recenter: () => recenter(),
    exit: () => exit(),
  });
  panel.mesh.position.copy(PANEL_POS);
  panel.mesh.rotation.x = PANEL_TILT;
  keyboard.mesh.position.copy(KEYBOARD_POS);
  keyboard.mesh.rotation.x = KEYBOARD_TILT;
  rig.add(panel.mesh, keyboard.mesh);

  const orb = createOrb();
  orb.group.position.copy(ORB_POS);
  rig.add(orb.group);

  // Phase 7 hooks: she stands on `spot`; her hit target joins the raycast list.
  const presence = {
    spot: loadSpot(),
    hitTarget: null as THREE.Object3D | null,
    celebrate: null as (() => void) | null,
  };

  // ---- Pointers: controllers in XR, the mouse in the preview ----
  const reticleGeo = new THREE.RingGeometry(0.008, 0.012, 32);
  function makeReticle(): THREE.Mesh {
    const m = new THREE.Mesh(
      reticleGeo,
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false }),
    );
    m.renderOrder = 20;
    m.visible = false;
    scene.add(m);
    return m;
  }

  const pointers: Pointer[] = [];
  const raycaster = new THREE.Raycaster();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const tmp = { v: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3(), head: new THREE.Vector3() };

  function targets(): THREE.Object3D[] {
    const list: THREE.Object3D[] = [panel.mesh, orb.hitTarget];
    if (presence.hitTarget) list.push(presence.hitTarget);
    if (keyboard.isOpen()) list.push(keyboard.mesh);
    return list;
  }

  function kindOf(o: THREE.Object3D): HitKind {
    if (o === panel.mesh) return "panel";
    if (o === keyboard.mesh) return "keyboard";
    if (o === orb.hitTarget) return "orb";
    return "her";
  }

  function headPosition(out: THREE.Vector3): THREE.Vector3 {
    const cam = renderer?.xr.isPresenting ? renderer.xr.getCamera() : camera;
    return out.setFromMatrixPosition(cam.matrixWorld);
  }

  /** Non-recursive raycast against the panel, the orb, her and the keyboard, then the empty floor. */
  function pick(ray: THREE.Ray): Hit | null {
    raycaster.ray.copy(ray);
    raycaster.far = 50;
    const hits = raycaster.intersectObjects(targets(), false);
    const first = hits[0];
    if (first) {
      const normal = first.face
        ? first.face.normal.clone().transformDirection(first.object.matrixWorld)
        : ray.direction.clone().negate();
      return { kind: kindOf(first.object), point: first.point.clone(), uv: first.uv?.clone() ?? null, normal };
    }
    if (!sky.floor.visible || ray.direction.y >= -1e-3) return null;
    const p = ray.intersectPlane(floorPlane, new THREE.Vector3());
    if (!p) return null;
    const head = headPosition(tmp.head);
    const d = Math.hypot(p.x - head.x, p.z - head.z);
    if (d < FLOOR_MIN || d > FLOOR_MAX) return null;
    return { kind: "floor", point: p, uv: null, normal: new THREE.Vector3(0, 1, 0) };
  }

  function placeReticle(p: Pointer): void {
    const r = p.reticle;
    const hit = p.hit;
    if (!hit || !active) {
      r.visible = false;
      return;
    }
    r.visible = true;
    r.position.copy(hit.point).addScaledVector(hit.normal, 0.002);
    r.lookAt(tmp.v.copy(hit.point).add(hit.normal));
    r.scale.setScalar(hit.kind === "floor" ? 8 : 1);
  }

  function select(p: Pointer): void {
    const ray = new THREE.Ray();
    if (!p.aim(ray)) return;
    const hit = pick(ray);
    p.hit = hit;
    if (!hit) return;
    switch (hit.kind) {
      case "panel":
        if (hit.uv) panel.press(hit.uv);
        break;
      case "keyboard":
        if (hit.uv) keyboard.press(hit.uv);
        break;
      case "orb":
        tapOrb();
        break;
      case "her":
        break; // phase 7
      case "floor":
        moveSpot(hit.point);
        break;
    }
  }

  function tapOrb(): void {
    if (!host.tapOrb()) panel.message(PANEL_TEXT.needVoiceKey);
  }

  /** Point at empty floor 0.6–4 m away and press: her spot moves there and is saved. */
  function moveSpot(world: THREE.Vector3): void {
    const local = rig.worldToLocal(world.clone());
    presence.spot = { x: local.x, z: local.z };
    writeJSON("avatarSpot", presence.spot);
    host.onSpot?.({ ...presence.spot });
  }

  // ---- XR controllers ----
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -RAY_LENGTH)]);
  const rayMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, toneMapped: false });
  const aPressed = new Map<XRInputSource, boolean>();
  const lastStick = new Map<XRInputSource, number>();
  let controllersReady = false;

  function setupControllers(r: THREE.WebGLRenderer): void {
    if (controllersReady) return;
    controllersReady = true;
    for (let i = 0; i < 2; i++) {
      const controller = r.xr.getController(i);
      const line = new THREE.Line(rayGeo, rayMat);
      line.name = "ray";
      controller.add(line);
      scene.add(controller);
      const pointer: Pointer = {
        reticle: makeReticle(),
        hit: null,
        aim(ray: THREE.Ray): boolean {
          if (!controller.visible) return false;
          controller.updateMatrixWorld();
          ray.origin.setFromMatrixPosition(controller.matrixWorld);
          ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
          return true;
        },
      };
      pointers.push(pointer);
      // Trigger and pinch both fire selectstart.
      controller.addEventListener("selectstart", () => select(pointer));
    }
  }

  /** A/X: a rising edge on buttons[4] per input source. Thumbstick axes[3] scrolls. */
  function pollGamepads(now: number): void {
    if (!session) return;
    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      const pressed = Boolean(gp.buttons[4]?.pressed);
      if (pressed && !aPressed.get(src)) tapOrb();
      aPressed.set(src, pressed);
      const y = gp.axes[3] ?? 0;
      if (Math.abs(y) > STICK_DEADZONE && now - (lastStick.get(src) ?? -Infinity) >= STICK_REPEAT_MS) {
        lastStick.set(src, now);
        panel.scroll(y > 0 ? 1 : -1);
      }
    }
  }

  // ---- Renderer (§8.1) ----
  function ensureRenderer(): THREE.WebGLRenderer {
    if (renderer) return renderer;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.setClearColor(0x000000, 1);
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType("local-floor");
    r.xr.setFoveation(1);
    const c = r.domElement;
    c.className = "xr-canvas";
    Object.assign(c.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", zIndex: "60", display: "none", touchAction: "none" });
    document.body.append(c);
    panel.setAnisotropy(Math.min(4, r.capabilities.getMaxAnisotropy()));
    renderer = r;
    setupControllers(r);
    return r;
  }

  function resize(): void {
    if (!renderer || renderer.xr.isPresenting) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // ---- The frame loop ----
  const aimRay = new THREE.Ray();
  function onFrame(): void {
    const r = renderer;
    if (!r) return;
    const now = performance.now();
    const dt = Math.min(MAX_DT, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    time += dt;

    sky.update(time);

    const v = host.voice();
    const st = host.assistant();
    orb.update(dt, orbMood({ voiceState: v.state, ttsPlaying: v.speaking, busy: st.busy }), orbLevel(v.micLevel, v.ttsLevel));
    orb.group.position.y = ORB_POS.y + 0.012 * Math.sin(time * 1.3);

    if (session) pollGamepads(now);

    // Hover: the first pointer on the panel or keyboard wins.
    let panelUv: THREE.Vector2 | null = null;
    let kbUv: THREE.Vector2 | null = null;
    for (const p of pointers) {
      p.hit = p.aim(aimRay) ? pick(aimRay) : null;
      placeReticle(p);
      if (p.hit?.kind === "panel" && !panelUv) panelUv = p.hit.uv;
      if (p.hit?.kind === "keyboard" && !kbUv) kbUv = p.hit.uv;
    }
    panel.hover(panelUv);
    keyboard.hover(kbUv);

    panel.update(now);
    keyboard.update();
    r.render(scene, camera);
  }

  function start(): void {
    const r = ensureRenderer();
    active = true;
    lastFrame = performance.now();
    r.domElement.style.display = "block";
    panel.markDirty();
    r.setAnimationLoop(onFrame);
  }

  function stopLoop(): void {
    renderer?.setAnimationLoop(null);
    if (renderer) renderer.domElement.style.display = "none";
    keyboard.close();
    for (const p of pointers) p.reticle.visible = false;
    active = false;
  }

  /** Move the rig to the head: position, y = max(−1, head.y − 1.6), and yaw only. */
  function recenter(): void {
    const cam = renderer?.xr.isPresenting ? renderer.xr.getCamera() : camera;
    cam.updateMatrixWorld();
    cam.matrixWorld.decompose(tmp.v, tmp.q, tmp.s);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(tmp.q);
    rig.position.set(tmp.v.x, Math.max(-1, tmp.v.y - EYE_HEIGHT), tmp.v.z);
    rig.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0);
    panel.markDirty();
  }

  function onSessionEnd(): void {
    if (recenterTimer) clearTimeout(recenterTimer);
    recenterTimer = null;
    session = null;
    aPressed.clear();
    lastStick.clear();
    stopLoop();
    host.onExit();
  }

  async function enter(mode: XrMode): Promise<void> {
    if (active) return;
    const xrSys = navigator.xr;
    if (!xrSys) throw new Error("WebXR isn't available here.");
    const r = ensureRenderer();
    // requestSession first, before anything awaits, so the tap's activation still counts.
    const s = await xrSys.requestSession(mode, { optionalFeatures: ["local-floor", "hand-tracking"] });
    session = s;
    passthrough = mode === "immersive-ar";
    sky.setVisible(!passthrough);
    r.setClearColor(0x000000, passthrough ? 0 : 1);
    s.addEventListener("end", onSessionEnd, { once: true });
    try {
      r.xr.setFoveation(1);
      await r.xr.setSession(s);
      r.xr.setFoveation(1);
    } catch (err) {
      s.removeEventListener("end", onSessionEnd);
      session = null;
      void s.end().catch(() => {});
      throw err;
    }
    // 90 Hz when the headset offers it.
    const rates = s.supportedFrameRates;
    if (rates && Array.from(rates).includes(90) && s.updateTargetFrameRate) {
      s.updateTargetFrameRate(90).catch(() => {});
    }
    sky.setStarScale(1.7);
    orb.setPixelScale(1800);
    camera.position.set(0, 0, 0);
    start();
    recenterTimer = setTimeout(() => {
      recenterTimer = null;
      recenter();
    }, RECENTER_DELAY_MS);
  }

  function exit(): void {
    if (session) {
      void session.end().catch(() => onSessionEnd());
      return;
    }
    if (previewing) {
      previewing = false;
      previewCleanup?.();
      previewCleanup = null;
      stopLoop();
      host.onExit();
    }
  }

  // ---- Desktop preview (§8.1) ----
  function preview(params: PreviewParams): void {
    if (active) return;
    const r = ensureRenderer();
    previewing = true;
    passthrough = false;
    sky.setVisible(true);
    if (params.hour !== null) sky.setHourOverride(params.hour);
    sky.setStarScale(1);

    // Look slightly down so the panel is centred; further down with the keyboard open.
    const yaw = THREE.MathUtils.degToRad(params.yaw);
    const pitch = THREE.MathUtils.degToRad(params.kb ? -24 : -9);
    camera.position.set(0, EYE_HEIGHT, 0);
    camera.rotation.set(pitch, -yaw, 0, "YXZ");
    if (params.avatarCam) {
      // A close-up of her default spot (she arrives in phase 7).
      const spot = presence.spot;
      const toUser = new THREE.Vector2(-spot.x, -spot.z).normalize();
      camera.position.set(spot.x + toUser.x * 1.2, 1.35, spot.z + toUser.y * 1.2);
      camera.lookAt(spot.x, 1.2, spot.z);
    }
    camera.updateMatrixWorld();
    if (params.kb) keyboard.open();

    // The mouse ray is a controller.
    const ndc = new THREE.Vector2(0, 0);
    let mouseIn = false;
    const mouse: Pointer = {
      reticle: makeReticle(),
      hit: null,
      aim(ray: THREE.Ray): boolean {
        if (!mouseIn) return false;
        raycaster.setFromCamera(ndc, camera);
        ray.copy(raycaster.ray);
        return true;
      },
    };
    pointers.push(mouse);
    const canvas = r.domElement;
    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      mouseIn = true;
    };
    const onLeave = () => {
      mouseIn = false;
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      onMove(e);
      select(mouse);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY) panel.scroll(e.deltaY > 0 ? 1 : -1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (keyboard.typeKey(e.key)) e.preventDefault();
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", resize);
    previewCleanup = () => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", resize);
      pointers.splice(pointers.indexOf(mouse), 1);
      scene.remove(mouse.reticle);
      (mouse.reticle.material as THREE.Material).dispose();
    };
    resize();
    orb.setPixelScale(window.innerHeight * r.getPixelRatio());
    start();
  }

  return {
    enter,
    exit,
    tick(): void {
      // The status strip counts down; nothing else changes on the clock.
      if (active && host.running().length) panel.markState();
    },
    notify(text: string): void {
      panel.message(text);
    },
    celebrate(): void {
      orb.pulse();
      presence.celebrate?.();
    },
    isActive: () => active,
    preview,
  };
}
