// Callie's optional VRM body (§7.4): loaded from the blob store with three-vrm,
// standing at her spot and turning to the viewer, arms down from the T-pose,
// the mood pose on her spine, neck and head, eased expressions, visemes and
// blinks, eyes on the viewer, and a 2.2 s wave. mountAvatarView() renders her
// head and shoulders on its own canvas for the sidebar portrait and the voice
// overlay. This module is lazy-loaded: three.js and three-vrm stay out of the
// main bundle.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import { approach, clamp01, moodExpression, textMood, visemesFor, type Mood, type RandomSource } from "../core/avatarMotion";
import { loadAvatar, type IDBFactoryLike } from "../core/blobstore";
import { FaceRig, TEXT_TAIL_CHARS, type FaceState } from "../core/faceRig";
import { fpsFor, pauseReason } from "../ui/character";
import type { AvatarSpot } from "./bridge";
import { HIT_RADIUS, SPARK_OFFSET, cleanSpot, easeAngle, faceYaw, glideStep, wrapAngle, type FloorPoint } from "./portrait";

// ---- Tuned values (§7.4) ---------------------------------------------------------------

export const NOT_VRM_MESSAGE = "That file isn't a VRM avatar. Export one from VRoid Studio as .vrm.";
/** Heights outside this range (metres) are a unit mistake: she is scaled to 1.6 m. */
export const HEIGHT_RANGE: readonly [number, number] = [0.8, 2.3];
export const FALLBACK_HEIGHT = 1.6;
/** Her body turns toward the viewer within this many radians of facing the user's spot. */
export const TURN_LIMIT = 0.6;
export const TURN_RATE = 1.5;
/** The wave lasts this long, in seconds. */
export const WAVE_SECONDS = 2.2;
/** Expressions ease at this rate; visemes follow the mouth's rate (FaceRig's talk). */
export const EXPRESSION_RATE = 8;
export const VISEME_RATE = 22;
export const BLINK_RATE = 35;
/** The 2D portrait renderer (§7.4). */
export const VIEW_FOV = 24;
export const VIEW_EYE = 0.93;
/** Sidebar frame rates: [idle, active]. The voice overlay is uncapped. */
export const AVATAR_VIEW_FPS: Readonly<{ sidebar: readonly [number, number]; voice: undefined }> = Object.freeze({ sidebar: [12, 30] as const, voice: undefined });

/** The VRM expression presets she uses. */
export const EXPRESSIONS = ["happy", "relaxed", "surprised", "aa", "ih", "ou", "ee", "oh", "blink"] as const;
export type ExpressionName = (typeof EXPRESSIONS)[number];
export type ExpressionWeights = Record<ExpressionName, number>;

/** A bone rotation in radians; missing axes are 0. */
export interface BoneRotation {
  x?: number;
  y?: number;
  z?: number;
}
export type BonePose = Partial<Record<VRMHumanBoneName, BoneRotation>>;

// ---- Pure parts --------------------------------------------------------------------------

/** The scale that brings a measured height into range: 1 when it already is. */
export function bodyScale(height: number): number {
  if (!(height > 0) || !Number.isFinite(height)) return 1;
  return height < HEIGHT_RANGE[0] || height > HEIGHT_RANGE[1] ? FALLBACK_HEIGHT / height : 1;
}

/**
 * The yaw her body turns to: toward the viewer, but at most TURN_LIMIT away from
 * facing the user's spot (the rig origin).
 */
export function bodyYawTarget(spot: FloorPoint, viewer: FloorPoint, origin: FloorPoint = { x: 0, z: 0 }): number {
  const base = faceYaw(spot, origin);
  const off = wrapAngle(faceYaw(spot, viewer) - base);
  return wrapAngle(base + Math.max(-TURN_LIMIT, Math.min(TURN_LIMIT, off)));
}

/**
 * The resting pose for a frame: arms down from the T-pose with a little
 * breathing, the chest's breath, and FaceRig's tilt, pitch and sway on the
 * spine, neck and head. Her left is +X (she faces +Z), so the left arm comes
 * down with a negative Z rotation. Tilt and sway flip sign to match the 2D rig,
 * where a positive tilt leans her head to the viewer's right.
 */
export function restPose(face: FaceState, t: number): BonePose {
  const breathe = 0.012 * face.breath;
  return {
    leftUpperArm: { z: -1.22 + breathe },
    rightUpperArm: { z: 1.22 - breathe },
    leftLowerArm: { y: -0.25 },
    rightLowerArm: { y: 0.25 },
    leftHand: { z: 0.05 },
    rightHand: { z: -0.05 },
    spine: { z: -face.sway * 0.6 },
    chest: { x: 0.012 * Math.sin(1.6 * t) },
    neck: { x: face.pitch * 0.4, z: -face.tilt * 0.4 },
    head: { x: face.pitch * 0.6, z: -face.tilt * 0.6 },
  };
}

/** The wave's envelope over its 2.2 s: up in .3 s, down over the last .45 s. */
export function waveEnvelope(elapsed: number): number {
  if (!(elapsed >= 0) || elapsed >= WAVE_SECONDS) return 0;
  const up = Math.min(1, elapsed / 0.3);
  const down = Math.min(1, (WAVE_SECONDS - elapsed) / 0.45);
  const e = Math.min(up, down);
  return e * e * (3 - 2 * e);
}

/**
 * The right arm while waving, blended over the rest pose by the envelope: the
 * elbow down and forward, the forearm up so her hand swings beside her face,
 * inside the 2D head-and-shoulders frame as well as in VR.
 */
export function wavePose(elapsed: number, rest: BonePose): BonePose {
  const e = waveEnvelope(elapsed);
  if (e <= 0) return rest;
  const swing = Math.sin(elapsed * 2 * Math.PI * 2.2);
  const mix = (a: number, b: number) => a + (b - a) * e;
  const ru = rest.rightUpperArm ?? {};
  const rl = rest.rightLowerArm ?? {};
  const rh = rest.rightHand ?? {};
  return {
    ...rest,
    rightUpperArm: { x: ru.x ?? 0, y: mix(ru.y ?? 0, 1.3), z: mix(ru.z ?? 0, 0.5) },
    rightLowerArm: { x: rl.x ?? 0, y: mix(rl.y ?? 0, 0), z: mix(rl.z ?? 0, -2.35 + 0.3 * swing) },
    rightHand: { x: rh.x ?? 0, y: rh.y ?? 0, z: mix(rh.z ?? 0, 0.15 * swing) },
  };
}

/**
 * Expression targets for a frame: the mood's resting expression, the words'
 * colour (last 160 characters), FaceRig's smile and wow, the visemes for the
 * voice level, and FaceRig's blink. Happy is reduced while she talks; blink is
 * reduced while she smiles.
 */
export function expressionTargets(mood: Mood, level: number, t: number, text: string, face: FaceState): ExpressionWeights {
  const base = moodExpression(mood);
  const said = typeof text === "string" ? text : "";
  const words = textMood(said.length > TEXT_TAIL_CHARS ? said.slice(-TEXT_TAIL_CHARS) : said);
  const v = visemesFor(mood === "speaking" ? clamp01(level) : 0, t);
  const talk = Math.min(1, v.aa + 0.8 * v.oh + 0.5 * v.ee);
  const happy = clamp01(Math.max(base.happy, words.happy, face.smile)) * (1 - 0.5 * talk);
  return {
    happy,
    relaxed: base.relaxed * (1 - clamp01(face.smile)),
    surprised: clamp01(Math.max(base.surprised, words.surprised, 0.6 * face.wow)),
    aa: v.aa,
    ih: v.ih,
    ou: v.ou,
    ee: v.ee,
    oh: v.oh,
    blink: (face.blink > 0.5 ? 1 : 0) * (1 - 0.7 * happy),
  };
}

/** Eases every expression toward its target; visemes and blink run faster. */
export function easeExpressions(cur: ExpressionWeights, target: ExpressionWeights, dt: number): ExpressionWeights {
  const out = { ...cur };
  for (const name of EXPRESSIONS) {
    const k = name === "blink" ? BLINK_RATE : name === "happy" || name === "relaxed" || name === "surprised" ? EXPRESSION_RATE : VISEME_RATE;
    out[name] = approach(cur[name], target[name], dt, k);
  }
  return out;
}

function zeroWeights(): ExpressionWeights {
  return { happy: 0, relaxed: 0, surprised: 0, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, blink: 0 };
}

// ---- Loading -----------------------------------------------------------------------------

/**
 * Parses a .vrm file. Rejects with NOT_VRM_MESSAGE when the file is not a glTF
 * with a VRM in it. The result is prepared per §7.4 (unneeded vertices removed,
 * skeletons combined, VRM 0 turned to face +Z, nothing frustum-culled).
 */
export async function parseVrm(data: ArrayBuffer): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  let gltf: Awaited<ReturnType<GLTFLoader["parseAsync"]>>;
  try {
    gltf = await loader.parseAsync(data, "");
  } catch {
    throw new Error(NOT_VRM_MESSAGE);
  }
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) {
    VRMUtils.deepDispose(gltf.scene);
    throw new Error(NOT_VRM_MESSAGE);
  }
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => {
    o.frustumCulled = false;
  });
  return vrm;
}

/** For "Load .vrm avatar": resolves when the file is a usable VRM, else rejects with the reason. */
export async function validateVrm(data: ArrayBuffer): Promise<void> {
  const vrm = await parseVrm(data);
  VRMUtils.deepDispose(vrm.scene);
}

/** Her standing height in metres: the scene's bounds, else the head bone, else 1.6. */
export function measureHeight(vrm: VRM): number {
  vrm.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const h = box.isEmpty() ? NaN : box.max.y - Math.min(0, box.min.y);
  if (h > 0 && Number.isFinite(h)) return h;
  const head = vrm.humanoid.getNormalizedBoneNode("head");
  if (head) {
    const p = head.getWorldPosition(new THREE.Vector3());
    if (p.y > 0) return p.y * 1.1;
  }
  return FALLBACK_HEIGHT;
}

// ---- The body ----------------------------------------------------------------------------

export interface AvatarBody {
  /** Add to the rig. Its position is her spot on the floor. */
  readonly group: THREE.Group;
  /** An invisible cylinder (radius .28, her height) for pointing. */
  readonly hitTarget: THREE.Mesh;
  /** Where the orb's 0.35-scale spark goes, beside her head (see portrait.ts). */
  readonly sparkAnchor: THREE.Object3D;
  /** Her height in metres after scaling. */
  readonly height: number;
  readonly vrm: VRM;
  /**
   * Every frame. `viewer` is the viewer's head in the group's parent space (the
   * rig, or the 2D view's scene); without it she faces the origin at eye height.
   */
  update(dt: number, mood: Mood, level: number, text: string, viewer?: THREE.Vector3Like): void;
  setSpot(spot: AvatarSpot, immediate?: boolean): void;
  /** The 2.2 s right-hand wave. */
  wave(): void;
  /** The wave's envelope now, 0 (not waving) to 1 (arm fully up). */
  waveAmount(): number;
  /** A celebration: a smile and a hop. */
  cheer(): void;
  dispose(): void;
}

export interface AvatarBodyOptions {
  spot?: AvatarSpot;
  random?: RandomSource;
}

function applyPose(vrm: VRM, pose: BonePose): void {
  for (const name of Object.keys(pose) as VRMHumanBoneName[]) {
    const node = vrm.humanoid.getNormalizedBoneNode(name);
    const r = pose[name];
    if (node && r) node.rotation.set(r.x ?? 0, r.y ?? 0, r.z ?? 0);
  }
}

export function createAvatarBody(vrm: VRM, opts: AvatarBodyOptions = {}): AvatarBody {
  const face = new FaceRig(opts.random);
  const group = new THREE.Group();
  group.name = "avatar";
  const turn = new THREE.Group();
  const lift = new THREE.Group();
  const scaler = new THREE.Group();
  group.add(turn);
  turn.add(lift);
  lift.add(scaler);
  scaler.add(vrm.scene);

  const scale = bodyScale(measureHeight(vrm));
  scaler.scale.setScalar(scale);
  scaler.updateMatrixWorld(true);
  const height = measureHeight(vrm);

  const hitGeo = new THREE.CylinderGeometry(HIT_RADIUS, HIT_RADIUS, height, 16, 1);
  const hitMat = new THREE.MeshBasicMaterial();
  const hitTarget = new THREE.Mesh(hitGeo, hitMat);
  hitTarget.visible = false;
  hitTarget.name = "avatar-hit";
  hitTarget.position.y = height / 2;
  group.add(hitTarget);

  // The spark beside her head, at the head bone's height when there is one.
  const head = vrm.humanoid.getNormalizedBoneNode("head");
  const headY = head ? head.getWorldPosition(new THREE.Vector3()).y - group.getWorldPosition(new THREE.Vector3()).y : height * 0.9;
  const sparkAnchor = new THREE.Object3D();
  sparkAnchor.name = "spark-anchor";
  sparkAnchor.position.set(SPARK_OFFSET.x, headY + 0.04, SPARK_OFFSET.z);
  turn.add(sparkAnchor);

  // Her eyes follow this point, kept at the viewer's head.
  const lookTarget = new THREE.Object3D();
  lookTarget.name = "avatar-look";
  group.add(lookTarget);
  if (vrm.lookAt) {
    vrm.lookAt.target = lookTarget;
    vrm.lookAt.autoUpdate = true;
  }

  let spot: FloorPoint = cleanSpot(opts.spot) ?? { x: 0, z: 0 };
  let target: FloorPoint = { ...spot };
  let t = 0;
  let waveAt = -1;
  let weights = zeroWeights();
  group.position.set(spot.x, 0, spot.z);
  turn.rotation.y = bodyYawTarget(spot, { x: 0, z: 0 });
  const viewerDefault = new THREE.Vector3(0, FALLBACK_HEIGHT, 0);

  return {
    group,
    hitTarget,
    sparkAnchor,
    height,
    vrm,
    update(dt, mood, level, text, viewer) {
      const step = dt > 0 && Number.isFinite(dt) ? dt : 0;
      t += step;
      const v = viewer ?? viewerDefault;

      spot = glideStep(spot, target, step);
      group.position.set(spot.x, 0, spot.z);
      turn.rotation.y = easeAngle(turn.rotation.y, bodyYawTarget(spot, { x: v.x, z: v.z }), step, TURN_RATE);
      lookTarget.position.set(v.x - spot.x, v.y, v.z - spot.z);

      const f = face.update(step, mood, level, text);
      lift.position.y = 0.03 * f.hop;
      let pose = restPose(f, t);
      if (waveAt >= 0) {
        const elapsed = t - waveAt;
        if (elapsed >= WAVE_SECONDS) waveAt = -1;
        else pose = wavePose(elapsed, pose);
      }
      applyPose(vrm, pose);

      weights = easeExpressions(weights, expressionTargets(mood, level, t, text, f), step);
      const em = vrm.expressionManager;
      if (em) for (const name of EXPRESSIONS) em.setValue(name, weights[name]);

      vrm.update(step);
    },
    setSpot(s, immediate = false) {
      const c = cleanSpot(s);
      if (!c) return;
      target = c;
      if (immediate) {
        spot = { ...c };
        group.position.set(spot.x, 0, spot.z);
      }
    },
    wave() {
      waveAt = t;
    },
    waveAmount() {
      return waveAt >= 0 ? waveEnvelope(t - waveAt) : 0;
    },
    cheer() {
      face.cheer();
    },
    dispose() {
      group.removeFromParent();
      if (vrm.lookAt) vrm.lookAt.target = null;
      hitGeo.dispose();
      hitMat.dispose();
      VRMUtils.deepDispose(vrm.scene);
    },
  };
}

/**
 * Her stored body, ready to place, or null when none is stored or it no longer
 * parses (then she falls back to the hologram).
 */
export async function loadStoredBody(
  opts: AvatarBodyOptions & { idb?: IDBFactoryLike } = {},
): Promise<{ name: string; body: AvatarBody } | null> {
  const record = await loadAvatar(opts.idb);
  if (!record) return null;
  try {
    const vrm = await parseVrm(record.data);
    return { name: record.name, body: createAvatarBody(vrm, opts) };
  } catch {
    return null;
  }
}

// ---- The 2D portrait renderer ----------------------------------------------------------------

export interface AvatarViewOptions {
  /** The .vrm file (from loadAvatar()). */
  data: ArrayBuffer;
  getMood: () => Mood;
  getLevel: () => number;
  getText?: () => string;
  /** A fixed cap or [idle, active]; uncapped when omitted (the voice overlay). */
  fps?: number | readonly [number, number];
  /** True while the view is on screen. Defaults to "attached and laid out". */
  isVisible?: () => boolean;
}

export interface AvatarView {
  /** `div.avatar-view`, holding the canvas. Mount it into a slot or container. */
  readonly el: HTMLElement;
  /** Resolves once she is loaded and drawn; rejects with the reason when the file fails. */
  readonly ready: Promise<void>;
  wave(): void;
  cheer(): void;
  /** Stops the loop, frees the VRM and the GL context, removes the element. */
  dispose(): void;
}

/** While she waves, the 2D camera eases back by up to this share, so her hand stays in frame. */
export const WAVE_PULLBACK = 0.35;

/**
 * The camera for a body of height `h`: at 0.93 h, far enough back for head and
 * shoulders. `wave` (0-1, the wave's envelope) pulls it back along its view line.
 */
export function viewCamera(h: number, wave = 0): { y: number; z: number; lookY: number } {
  const span = 0.36 * h; // the top of the head down to the shoulders, with a margin
  const z0 = span / (2 * Math.tan((VIEW_FOV * Math.PI) / 360));
  const k = 1 + WAVE_PULLBACK * Math.max(0, Math.min(1, wave));
  const lookY = 0.9 * h;
  return { y: lookY + (VIEW_EYE * h - lookY) * k, z: z0 * k, lookY };
}

/**
 * Her head and shoulders on their own canvas (§7.4), mirroring mountOrbView:
 * its own renderer, a frame-rate cap, no work while hidden, in VR or off screen,
 * and a dispose that frees the GL context. When `container` is given the view
 * is appended to it.
 */
export function mountAvatarView(container: HTMLElement | null, opts: AvatarViewOptions): AvatarView {
  const doc = document;
  const el = doc.createElement("div");
  el.className = "avatar-view";
  Object.assign(el.style, { position: "relative", width: "100%", height: "100%" });

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { width: "100%", height: "100%", display: "block" });
  el.append(canvas);
  container?.append(el);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x443322, 1.6));
  const key = new THREE.DirectionalLight(0xffe2c0, 1.4);
  key.position.set(0.8, 2.4, 2);
  scene.add(key);
  const camera = new THREE.PerspectiveCamera(VIEW_FOV, 1, 0.05, 20);
  const eye = new THREE.Vector3();

  let body: AvatarBody | null = null;
  let disposed = false;
  const visible = opts.isVisible ?? (() => el.isConnected && el.offsetParent !== null);

  let bodyHeight = FALLBACK_HEIGHT;
  function frameCamera(h: number, wave = 0): void {
    const c = viewCamera(h, wave);
    camera.position.set(0, c.y, c.z);
    camera.lookAt(0, c.lookY, 0);
    eye.copy(camera.position);
  }
  frameCamera(FALLBACK_HEIGHT);

  function resize(): void {
    const w = Math.max(1, el.clientWidth);
    const hgt = Math.max(1, el.clientHeight);
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  ro?.observe(el);

  let raf = 0;
  let last = -1;
  let lastDraw = -Infinity;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (!body || pauseReason(doc, visible()) !== null) {
      last = -1;
      return;
    }
    const mood = opts.getMood();
    const cap = fpsFor(opts.fps, mood === "idle" ? "idle" : "speaking");
    if (cap > 0 && now - lastDraw < 1000 / cap - 1) return;
    lastDraw = now;
    const dt = last < 0 ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    body.update(dt, mood, opts.getLevel(), opts.getText?.() ?? "", eye);
    frameCamera(bodyHeight, body.waveAmount());
    renderer.render(scene, camera);
  };

  const ready = parseVrm(opts.data).then((vrm) => {
    if (disposed) {
      VRMUtils.deepDispose(vrm.scene);
      return;
    }
    body = createAvatarBody(vrm);
    scene.add(body.group);
    bodyHeight = body.height;
    frameCamera(bodyHeight);
    body.update(0, opts.getMood(), 0, "", eye);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  });
  // The caller reads failures from `ready`; never leave an unhandled rejection.
  ready.catch(() => undefined);

  return {
    el,
    ready,
    wave() {
      body?.wave();
    },
    cheer() {
      body?.cheer();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      body?.dispose();
      body = null;
      renderer.dispose();
      renderer.forceContextLoss();
      el.remove();
    },
  };
}
