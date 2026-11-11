// VR (§8.1–8.5): the renderer and session, the rig, controllers and the
// desktop preview. Loaded only through dynamic import() from main.ts, which
// talks to it through the XrHost / Immersive contract in ./bridge.ts.
//
// Scenes (§8.7–8.8): the scene follows settings.environmentId. A panorama
// loads through ./panorama (off the main thread, stale loads dropped) onto the
// sky sphere; the lights and the particle pool switch with it. The clock scene
// restores the clock sky, stars and floor. The soundscape lives in the app
// (core/ambience.ts), which follows the same setting.
//
// Callie (§8.5, §8.11, §7.4): each session (and the preview) brings her in at
// her spot: her VRM body when one is stored (./avatar, loaded only then, with
// three-vrm), else the hologram portrait (./portrait). The orb becomes a
// 0.35-scale spark beside her head. She turns to the viewer, glides to the
// floor point the user selects, waves back (or cheers, as the hologram) when a
// hand waves, greets 1.2 s after entering while the greeting is fresh, and
// cheers at a finished focus session. Under a panorama (no floor disc) her VRM
// body stands on a soft contact-shadow decal (§8.7). She is disposed when the
// session ends, so a body loaded in Settings meanwhile shows next time.

import * as THREE from "three";
import type { AssistantState } from "../core/assistant";
import { WaveDetector } from "../core/avatarMotion";
import { loadAvatar } from "../core/blobstore";
import { GREETING_MAX_AGE_MS } from "../core/session";
import { readJSON, writeJSON } from "../core/store";
import type { AvatarBody } from "./avatar";
import type { AvatarSpot, Immersive, OrbMood, PreviewParams, XrHost, XrMode, XrVoiceView } from "./bridge";
import { createHandJoints, type HandJoints } from "./hands";
import { createKeyboard } from "./keyboard";
import { SPARK_HIT_BOOST, createOrb, orbLevel, orbMood } from "./orb";
import { createPanel } from "./panel";
import { PANEL_TEXT } from "./panelModel";
import { environmentById, sceneLoadFailedText, type Environment } from "../core/environments";
import { createPanoramaMaterial, createPanoramaSwitcher, loadPanoramaTexture, PANORAMA_MAX_ANISOTROPY } from "./panorama";
import { createParticles } from "./particles";
import { SPARK_SCALE, createPortrait, type Portrait } from "./portrait";
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
/** Her greeting wave comes this long after entering (§8.5). */
export const GREET_DELAY_MS = 1200;
/** `?wave`: she waves this often in the preview (§8.1). */
export const PREVIEW_WAVE_MS = 3000;
/** What she says when the user waves and she is idle (§8.5). */
export const HELLO_LINES = ["Hi!", "Hey, you!", "Oh, hi there!", "Hiya!"] as const;
/** The VRM body's contact-shadow decal under a panorama (§8.7): radius in metres and peak darkness. */
export const CONTACT_SHADOW = Object.freeze({ radius: 0.36, alpha: 0.5 });

/** Her, whichever body she has: the VRM or the hologram, behind one face. */
export interface Her {
  readonly kind: "vrm" | "hologram";
  readonly group: THREE.Object3D;
  readonly hitTarget: THREE.Object3D;
  readonly sparkAnchor: THREE.Object3D;
  update(dt: number, mood: OrbMood, level: number, text: string, head: THREE.Vector3): void;
  setSpot(spot: AvatarSpot): void;
  /** Her answer to a wave: the VRM waves back, the hologram cheers (§8.5). */
  wave(): void;
  cheer(): void;
  /** A panorama is showing: the VRM body stands on its contact shadow. */
  setPanorama(on: boolean): void;
  setAnisotropy(n: number): void;
  dispose(): void;
}

const SHADOW_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SHADOW_FRAG = /* glsl */ `
uniform float uAlpha;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = uAlpha * (1.0 - smoothstep(0.1, 1.0, d));
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

function hologramHer(p: Portrait): Her {
  return {
    kind: "hologram",
    group: p.group,
    hitTarget: p.hitTarget,
    sparkAnchor: p.sparkAnchor,
    update: (dt, mood, level, text, head) => p.update(dt, mood, level, text, head),
    setSpot: (spot) => p.setSpot(spot),
    wave: () => p.cheer(),
    cheer: () => p.cheer(),
    setPanorama: () => {},
    setAnisotropy: (n) => p.setAnisotropy(n),
    dispose: () => p.dispose(),
  };
}

function vrmHer(body: AvatarBody): Her {
  const geo = new THREE.CircleGeometry(CONTACT_SHADOW.radius, 40);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: CONTACT_SHADOW.alpha } },
    vertexShader: SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const shadow = new THREE.Mesh(geo, mat);
  shadow.name = "avatar-shadow";
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  shadow.renderOrder = 1;
  shadow.visible = false;
  body.group.add(shadow);
  return {
    kind: "vrm",
    group: body.group,
    hitTarget: body.hitTarget,
    sparkAnchor: body.sparkAnchor,
    update: (dt, mood, level, text, head) => body.update(dt, mood, level, text, head),
    setSpot: (spot) => body.setSpot(spot),
    wave: () => body.wave(),
    cheer: () => body.cheer(),
    setPanorama: (on) => {
      shadow.visible = on;
    },
    setAnisotropy: () => {},
    dispose: () => {
      geo.dispose();
      mat.dispose();
      body.dispose();
    },
  };
}

/** What she is saying, for her expressions: the streaming reply, else the last one while her voice plays. */
export function herText(st: Pick<AssistantState, "text" | "turns">, v: Pick<XrVoiceView, "speaking">): string {
  if (st.text) return st.text;
  if (!v.speaking) return "";
  const last = st.turns[st.turns.length - 1];
  return last && last.role === "assistant" ? last.text : "";
}

/** "This visit's greeting is still fresh" (§8.5): one arrived less than 15 minutes ago. */
export function greetingFresh(st: Pick<AssistantState, "greeting">, now: number): boolean {
  const g = st.greeting;
  return Boolean(g && g.text.trim() && now - g.at < GREETING_MAX_AGE_MS);
}

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
  const clockEnv = environmentById("clock");
  const hemi = new THREE.HemisphereLight(clockEnv.hemisphere.sky, clockEnv.hemisphere.ground, 1);
  const key = new THREE.DirectionalLight(clockEnv.key.color, clockEnv.key.intensity);
  key.position.set(0.5, 2.5, 1.2);
  scene.add(hemi, key);
  const particles = createParticles();
  particles.setScene(clockEnv.particles);
  scene.add(particles.points);

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

  // She stands on `spot`; her hit target joins the raycast list.
  const presence = {
    spot: loadSpot(),
    hitTarget: null as THREE.Object3D | null,
    celebrate: null as (() => void) | null,
    /** A panorama is showing (no floor disc): her body wants its contact-shadow decal. */
    panorama: false,
    onSceneLook: null as ((panorama: boolean) => void) | null,
  };

  // ---- Her (§8.11, §7.4) ----
  let her: Her | null = null;
  /** Each summon bumps this, so a body that finishes loading after the session ended is dropped. */
  let herTicket = 0;
  /** The greeting wave came before she had loaded: she waves on arrival. */
  let wavePending = false;
  /** The motes' point-size scale for the full-size orb; the spark uses SPARK_SCALE of it. */
  let orbPx = 900;
  let greetTimer: ReturnType<typeof setTimeout> | null = null;

  function setOrbPx(px: number): void {
    orbPx = px;
    orb.setPixelScale(her ? px * SPARK_SCALE : px);
  }

  /** Her VRM body when one is stored and still loads, else the hologram. */
  async function loadHer(): Promise<Her> {
    const record = await loadAvatar();
    if (record) {
      try {
        const avatar = await import("./avatar");
        return vrmHer(avatar.createAvatarBody(await avatar.parseVrm(record.data), { spot: presence.spot }));
      } catch {
        // The file no longer parses (or the chunk failed): the hologram stands in.
      }
    }
    return hologramHer(createPortrait({ spot: presence.spot }));
  }

  function summonHer(): void {
    const ticket = ++herTicket;
    void loadHer().then((h) => {
      if (ticket !== herTicket || !active) {
        h.dispose();
        return;
      }
      her = h;
      rig.add(h.group);
      h.setAnisotropy(Math.min(4, renderer?.capabilities.getMaxAnisotropy() ?? 1));
      h.setPanorama(presence.panorama);
      presence.hitTarget = h.hitTarget;
      presence.celebrate = () => h.cheer();
      presence.onSceneLook = (panorama) => h.setPanorama(panorama);
      orb.group.scale.setScalar(SPARK_SCALE);
      // The spark is small; its hit sphere grows inside it so a pinch ray still lands.
      orb.hitTarget.scale.setScalar(SPARK_HIT_BOOST);
      setOrbPx(orbPx);
      if (wavePending) {
        wavePending = false;
        h.wave();
      }
    });
  }

  function dismissHer(): void {
    herTicket++;
    wavePending = false;
    if (greetTimer) clearTimeout(greetTimer);
    greetTimer = null;
    her?.dispose();
    her = null;
    presence.hitTarget = null;
    presence.celebrate = null;
    presence.onSceneLook = null;
    orb.group.scale.setScalar(1);
    orb.hitTarget.scale.setScalar(1);
    orb.group.position.copy(ORB_POS);
    setOrbPx(orbPx);
  }

  /** She waves (VRM) or cheers (hologram); before she has loaded, as soon as she arrives. */
  function herWave(): void {
    if (her) her.wave();
    else wavePending = true;
  }

  /** The user waved (§8.5): she answers, and says hi if she is idle and voice is set up. */
  function onUserWave(): void {
    if (!her) return;
    her.wave();
    const v = host.voice();
    const st = host.assistant();
    if (v.ready && host.say && orbMood({ voiceState: v.state, ttsPlaying: v.speaking, busy: st.busy }) === "idle") {
      host.say(HELLO_LINES[Math.floor(Math.random() * HELLO_LINES.length)]);
    }
  }

  // ---- Scenes (§8.7): panorama, lights and particles follow settings.environmentId ----
  /** Lights and particles for a scene; the panorama or clock look on the sky. */
  function applySceneLook(env: Environment, panoramaMaterial: THREE.Material | null): void {
    hemi.color.setHex(env.hemisphere.sky);
    hemi.groundColor.setHex(env.hemisphere.ground);
    key.color.setHex(env.key.color);
    key.intensity = env.key.intensity;
    particles.setScene(env.particles);
    sky.setPanoramaMaterial(panoramaMaterial);
    sky.showClock(!panoramaMaterial);
    presence.panorama = Boolean(panoramaMaterial);
    presence.onSceneLook?.(presence.panorama);
  }

  const scenes = createPanoramaSwitcher<THREE.ShaderMaterial>({
    load: (env) =>
      loadPanoramaTexture(new URL(env.image ?? "", document.baseURI).href, maxAnisotropy()).then((tex) =>
        createPanoramaMaterial(tex, env),
      ),
    showPanorama: (env, material) => applySceneLook(env, material),
    showClock: () => applySceneLook(clockEnv, null),
    discard: (material) => {
      (material.uniforms.uMap.value as THREE.Texture).dispose();
      material.dispose();
    },
    failed: (env) => {
      const text = sceneLoadFailedText(env.name);
      panel.message(text);
      host.sceneFailed(text);
    },
  });

  function maxAnisotropy(): number {
    return renderer ? Math.min(PANORAMA_MAX_ANISOTROPY, renderer.capabilities.getMaxAnisotropy()) : 1;
  }

  /** Show the scene in settings. Loads start only once the renderer exists (a session or the preview). */
  function syncScene(): void {
    if (!renderer) return;
    void scenes.set(environmentById(host.settings().environmentId));
  }
  host.subscribe(syncScene);

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
  const tmp = {
    v: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    s: new THREE.Vector3(),
    head: new THREE.Vector3(),
    fwd: new THREE.Vector3(),
    hand: new THREE.Vector3(),
    spark: new THREE.Vector3(),
  };

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
    // The floor stays pickable under a panorama, where its disc is hidden.
    if (ray.direction.y >= -1e-3) return null;
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
        break; // Selecting her does nothing: only empty floor moves her.
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
    her?.setSpot(presence.spot);
    host.onSpot?.({ ...presence.spot });
  }

  // ---- XR controllers ----
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -RAY_LENGTH)]);
  const rayMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, toneMapped: false });
  const aPressed = new Map<XRInputSource, boolean>();
  /** Per hand: where to read its position (the wrist joint, else the controller) and its detector. */
  const wavers: { hand: THREE.XRHandSpace; controller: THREE.XRTargetRaySpace; detector: WaveDetector }[] = [];
  /** Joint spheres for tracked hands (hands-first); hidden in passthrough, where real hands show. */
  const handJoints: HandJoints[] = [];
  const lastStick = new Map<XRInputSource, number>();
  let controllersReady = false;

  function setupControllers(r: THREE.WebGLRenderer): void {
    if (controllersReady) return;
    controllersReady = true;
    for (let i = 0; i < 2; i++) {
      const controller = r.xr.getController(i);
      const hand = r.xr.getHand(i);
      scene.add(hand);
      handJoints.push(createHandJoints(hand));
      wavers.push({ hand, controller, detector: new WaveDetector() });
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

  /**
   * Waving (§8.5): each hand's wrist (hand tracking) or controller, in a frame
   * made of the head position plus head yaw only: x across, y up.
   */
  function pollWaves(nowMs: number): void {
    const head = headPosition(tmp.head);
    const cam = renderer?.xr.isPresenting ? renderer.xr.getCamera() : camera;
    const fwd = tmp.fwd.set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(tmp.q));
    const len = Math.hypot(fwd.x, fwd.z) || 1;
    const rx = -fwd.z / len;
    const rz = fwd.x / len;
    for (const w of wavers) {
      const wrist = w.hand.joints.wrist;
      let p: THREE.Vector3 | null = null;
      if (wrist && w.hand.visible && wrist.visible) p = wrist.getWorldPosition(tmp.hand);
      else if (w.controller.visible) p = w.controller.getWorldPosition(tmp.hand);
      if (!p) {
        w.detector.reset();
        continue;
      }
      const dx = p.x - head.x;
      const dz = p.z - head.z;
      if (w.detector.push(dx * rx + dz * rz, p.y - head.y, nowMs)) onUserWave();
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
    particles.update(time);

    const v = host.voice();
    const st = host.assistant();
    const mood = orbMood({ voiceState: v.state, ttsPlaying: v.speaking, busy: st.busy });
    const level = orbLevel(v.micLevel, v.ttsLevel);
    orb.update(dt, mood, level);
    if (her) {
      // She faces the head; the orb rides beside her head as a 0.35-scale spark (§8.2).
      rig.updateMatrixWorld();
      const head = rig.worldToLocal(headPosition(tmp.head));
      her.update(dt, mood, level, herText(st, v), head);
      orb.group.position.copy(rig.worldToLocal(her.sparkAnchor.getWorldPosition(tmp.spark)));
    } else {
      orb.group.position.set(ORB_POS.x, ORB_POS.y + 0.012 * Math.sin(time * 1.3), ORB_POS.z);
    }

    if (session) {
      pollGamepads(now);
      pollWaves(now);
      for (const h of handJoints) h.update();
    }

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
    syncScene();
    summonHer();
    // 1.2 s in, she waves or cheers if this visit's greeting is still fresh (§8.5).
    greetTimer = setTimeout(() => {
      greetTimer = null;
      if (active && greetingFresh(host.assistant(), Date.now())) herWave();
    }, GREET_DELAY_MS);
    r.setAnimationLoop(onFrame);
  }

  function stopLoop(): void {
    renderer?.setAnimationLoop(null);
    if (renderer) renderer.domElement.style.display = "none";
    keyboard.close();
    for (const p of pointers) p.reticle.visible = false;
    for (const w of wavers) w.detector.reset();
    active = false;
    dismissHer();
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
    particles.setVisible(!passthrough);
    for (const h of handJoints) h.mesh.visible = !passthrough;
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
    setOrbPx(1800);
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
    particles.setVisible(true);
    if (params.hour !== null) sky.setHourOverride(params.hour);
    sky.setStarScale(1);

    // Look slightly down so the panel is centred; further down with the keyboard open.
    const yaw = THREE.MathUtils.degToRad(params.yaw);
    const pitch = THREE.MathUtils.degToRad(params.kb ? -24 : -9);
    camera.position.set(0, EYE_HEIGHT, 0);
    camera.rotation.set(pitch, -yaw, 0, "YXZ");
    if (params.avatarCam) {
      // A close-up of her spot.
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
    const waveTimer = params.wave ? setInterval(herWave, PREVIEW_WAVE_MS) : null;
    previewCleanup = () => {
      if (waveTimer) clearInterval(waveTimer);
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
    setOrbPx(window.innerHeight * r.getPixelRatio());
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
