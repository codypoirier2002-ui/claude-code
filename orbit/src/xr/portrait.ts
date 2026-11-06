// Callie's hologram portrait for VR when there is no VRM body (§8.11): the six
// character layers as stacked planes on a body pivot, with a fading, shimmering,
// hair-swaying shader; a warm glow behind her; a beam of light from a pulsing
// floor ring. FaceRig drives the layers, tilt, breath and hop, exactly as in 2D.
// The placement helpers at the top (facing, gliding, the spark beside her head)
// are shared with the VRM body in avatar.ts.

import * as THREE from "three";
import type { Mood, RandomSource } from "../core/avatarMotion";
import { FaceRig, type FaceState } from "../core/faceRig";
import { CHARACTER_LAYERS, layerOpacities, layerSrc, type CharacterLayer } from "../ui/character";
import type { AvatarSpot, OrbMood } from "./bridge";

// ---- Shared placement (rig space: the user stands at the origin, −Z ahead) ----------

/** A point on the floor, or a head position seen from above. */
export interface FloorPoint {
  x: number;
  z: number;
}

/** She glides to a new spot with lerp(1 − e^(−3dt)) (§8.5). */
export const GLIDE_RATE = 3;
/** The orb shrinks to this scale as her "spark" (§8.2). */
export const SPARK_SCALE = 0.35;
/** Her invisible hit cylinder's radius, in metres (§7.4). */
export const HIT_RADIUS = 0.28;

/** Wraps an angle into (−π, π]. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = (a + Math.PI) % twoPi;
  if (r < 0) r += twoPi;
  r -= Math.PI;
  return r === -Math.PI ? Math.PI : r;
}

/**
 * The yaw (rotation about +Y) that turns something standing at `from`, whose
 * front is +Z, to face `to`.
 */
export function faceYaw(from: FloorPoint, to: FloorPoint): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (dx * dx + dz * dz < 1e-10) return 0;
  return Math.atan2(dx, dz);
}

/** Eases an angle toward a target the short way round, at rate `k` per second. */
export function easeAngle(cur: number, target: number, dt: number, k: number): number {
  return wrapAngle(cur + wrapAngle(target - cur) * (1 - Math.exp(-k * dt)));
}

/** One glide step toward `target` (§8.5). Returns a new point. */
export function glideStep(cur: FloorPoint, target: FloorPoint, dt: number, k = GLIDE_RATE): FloorPoint {
  const f = 1 - Math.exp(-k * Math.max(0, dt));
  return { x: cur.x + (target.x - cur.x) * f, z: cur.z + (target.z - cur.z) * f };
}

/** A spot that is a pair of finite numbers, or null. */
export function cleanSpot(s: unknown): AvatarSpot | null {
  if (typeof s !== "object" || s === null) return null;
  const { x, z } = s as Record<string, unknown>;
  return typeof x === "number" && typeof z === "number" && Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
}

// ---- Portrait layout and motion (§8.11) ---------------------------------------------

export const PLANE_W = 0.62;
export const PLANE_H = 0.8267;
/** The body pivot's height: 85% down the image, like the 2D rig's origin. */
export const PIVOT_Y = 1.01;
/** The image centre's height. */
export const IMAGE_CENTRE_Y = 1.3;
/** The glow plane behind her, metres across. */
export const GLOW_SIZE = 1.1;
/** The beam: an open cylinder from the floor ring up to her. */
export const BEAM = Object.freeze({ radiusTop: 0.17, radiusBottom: 0.21, height: 1.05 });
/** The floor ring. */
export const RING = Object.freeze({ inner: 0.2, outer: 0.23, color: "#ffc27a" });
/** She turns to the viewer's head at this rate (yaw only). */
export const TURN_RATE = 2.5;
/** The glow eases toward its mood level at this rate. */
export const GLOW_RATE = 6;
/**
 * Where the spark sits, in her turning frame (she faces +Z, so +X is her left
 * and the viewer's right): beside her head at eye height, toward the panel when
 * she stands at her default spot on the user's left.
 */
export const SPARK_OFFSET: Readonly<{ x: number; y: number; z: number }> = Object.freeze({ x: 0.36, y: 1.5, z: 0.04 });

/** First renderOrder of the six layers (10–15). */
export const LAYER_RENDER_ORDER = 10;

/** The glow's brightness for a mood (§8.11); the ring and beam follow it. */
export function glowFor(mood: OrbMood | Mood, level: number, t: number): number {
  switch (mood) {
    case "speaking":
      return 0.55 + 0.5 * Math.max(0, Math.min(1, level));
    case "listening":
      return 0.65;
    case "thinking":
      return 0.5 + 0.12 * Math.sin(4 * t);
    default:
      return 0.45;
  }
}

/**
 * The body pivot's motion from FaceRig, the 2D rig transform (§7.3) carried into
 * metres: the same percentages of the image height, the same angles. CSS +Y is
 * down and CSS rotation is clockwise, so both flip here.
 */
export function bodyPose(f: FaceState): { y: number; rotZ: number; scale: number } {
  const down = (f.breath * 0.35 + f.pitch * 6 - f.hop * 3) / 100;
  const deg = ((f.tilt * 180) / Math.PI) * 0.6 + f.sway * 20;
  return {
    y: PIVOT_Y - down * PLANE_H,
    rotZ: -(deg * Math.PI) / 180,
    scale: 1 + f.breath * 0.004 + f.hop * 0.01,
  };
}

/** Her float: .012 sin 1.1t. */
export function floatY(t: number): number {
  return 0.012 * Math.sin(1.1 * t);
}

// ---- Shaders --------------------------------------------------------------------------

const LAYER_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** ss(a, b, x) is smoothstep that also runs downhill when a > b. */
const SS = /* glsl */ `
float ss(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}`;

const LAYER_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
uniform float uTime;
varying vec2 vUv;
${SS}
void main() {
  vec2 uv = vUv;
  // Hair sway: only the sides and the ends, never the face. Every layer warps
  // identically, so the expression patches stay aligned with the base.
  vec2 f = (uv - vec2(0.52, 0.6)) / 0.2;
  float hair = ss(1.0, 1.6, length(f)) * ss(0.08, 0.2, abs(uv.x - 0.52)) * ss(0.85, 0.55, uv.y);
  float ends = clamp((0.8 - uv.y) * 1.6, 0.0, 1.0);
  uv.x += sin(1.3 * uTime + 7.0 * uv.y) * 0.0045 * hair * ends;
  uv.y += sin(0.9 * uTime + 5.0 * uv.x) * 0.002 * hair * ends;
  vec4 c = texture2D(uMap, uv);
  // Fade out the bottom, with a faint scanline shimmer near it. The art is cut
  // straight at the sides of her sweater, so the side edges fade too.
  float a = c.a * uOpacity * ss(0.02, 0.3, vUv.y) * ss(0.0, 0.05, vUv.x) * ss(1.0, 0.95, vUv.x);
  float shimmer = 0.94 + 0.06 * sin(420.0 * vUv.y - 3.0 * uTime);
  c.rgb *= mix(shimmer, 1.0, ss(0.12, 0.32, vUv.y));
  if (a < 0.002) discard;
  gl_FragColor = vec4(c.rgb, a);
  #include <colorspace_fragment>
}`;

const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uGlow;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(max(1.0 - d, 0.0), 2.2) * 0.42 * uGlow;
  gl_FragColor = vec4(uColor, a); // additive blending adds uColor * a
  #include <colorspace_fragment>
}`;

const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPosW;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPosW = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uGlow;
uniform float uTime;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPosW;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 view = normalize(cameraPosition - vPosW);
  float facing = abs(dot(normalize(vNormalW), view));
  float rim = pow(1.0 - facing, 2.0);
  // Rising motes: a grid of cells around the column, each with one soft dot.
  vec2 g = vec2(vUv.x * 28.0, vUv.y * 9.0 - uTime * 0.55);
  vec2 cell = floor(g);
  vec2 inCell = fract(g) - 0.5;
  float on = step(0.62, hash(cell));
  vec2 jitter = vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5;
  float mote = on * smoothstep(0.22, 0.0, length(inCell - jitter * 0.5));
  float fade = pow(1.0 - vUv.y, 1.4) * smoothstep(0.0, 0.06, vUv.y);
  float a = (0.10 + 0.55 * rim + 0.5 * mote) * fade * uGlow;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

const POOL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uGlow;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(max(1.0 - d, 0.0), 1.6) * 0.5 * uGlow;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

const PLAIN_VERT = LAYER_VERT;

// ---- The portrait ---------------------------------------------------------------------

export interface Portrait {
  /** Add to the rig. Its position is her spot on the floor. */
  readonly group: THREE.Group;
  /** An invisible cylinder (radius .28) for pointing; add it to the raycast list. */
  readonly hitTarget: THREE.Mesh;
  /**
   * Where the orb's 0.35-scale spark goes: beside her head, turning with her.
   * The orb lives in orb.ts; read this anchor's world position each frame.
   */
  readonly sparkAnchor: THREE.Object3D;
  /**
   * Every frame. dt in seconds (already clamped). `viewer` is the viewer's head
   * in the group's parent space (the rig); she turns to it, yaw only. Without
   * it she faces the rig origin.
   */
  update(dt: number, mood: Mood, level: number, text: string, viewer?: FloorPoint): void;
  /** Her new spot. She glides there unless `immediate`. */
  setSpot(spot: AvatarSpot, immediate?: boolean): void;
  /** Smile and hop (a celebration, or her answer to a wave, §8.5). */
  cheer(): void;
  /** The textures' anisotropy (the renderer's, up to 4). */
  setAnisotropy(n: number): void;
  dispose(): void;
}

export interface PortraitOptions {
  spot?: AvatarSpot;
  /** FaceRig's random source (tests). */
  random?: RandomSource;
  /** Loads one layer texture; TextureLoader by default (tests pass a stub). */
  loadTexture?: (src: string) => THREE.Texture;
}

function defaultLoader(src: string): THREE.Texture {
  return new THREE.TextureLoader().load(src);
}

export function createPortrait(opts: PortraitOptions = {}): Portrait {
  const load = opts.loadTexture ?? defaultLoader;
  const face = new FaceRig(opts.random);
  const warm = new THREE.Color("#ffb547");
  const ringColor = new THREE.Color(RING.color);
  const time = { value: 0 };
  const glowU = { value: glowFor("idle", 0, 0) };
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // group (spot) > turn (yaw) > float > pivot (tilt, breath, hop) > layers
  const group = new THREE.Group();
  group.name = "portrait";
  const turn = new THREE.Group();
  const float = new THREE.Group();
  const pivot = new THREE.Group();
  pivot.position.y = PIVOT_Y;
  group.add(turn);
  turn.add(float);
  float.add(pivot);

  // ---- The six layers ----
  const layerGeo = keep(new THREE.PlaneGeometry(PLANE_W, PLANE_H));
  const textures: THREE.Texture[] = [];
  const opacity = {} as Record<CharacterLayer, { value: number }>;
  CHARACTER_LAYERS.forEach((layer, i) => {
    const tex = keep(load(layerSrc(layer)));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    textures.push(tex);
    opacity[layer] = { value: layer === "base" ? 1 : 0 };
    const mat = keep(
      new THREE.ShaderMaterial({
        uniforms: { uMap: { value: tex }, uOpacity: opacity[layer], uTime: time },
        vertexShader: LAYER_VERT,
        fragmentShader: LAYER_FRAG,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    const mesh = new THREE.Mesh(layerGeo, mat);
    mesh.name = `portrait-${layer}`;
    mesh.renderOrder = LAYER_RENDER_ORDER + i;
    mesh.position.y = IMAGE_CENTRE_Y - PIVOT_Y;
    mesh.frustumCulled = false;
    pivot.add(mesh);
  });

  // ---- The glow behind her ----
  const glow = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(GLOW_SIZE, GLOW_SIZE)),
    keep(
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: warm }, uGlow: glowU },
        vertexShader: PLAIN_VERT,
        fragmentShader: GLOW_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    ),
  );
  glow.name = "portrait-glow";
  glow.position.set(0, IMAGE_CENTRE_Y, -0.06);
  glow.renderOrder = LAYER_RENDER_ORDER - 2;
  float.add(glow);

  // ---- The beam and the floor ring (they do not turn: both are round) ----
  const beam = new THREE.Mesh(
    keep(new THREE.CylinderGeometry(BEAM.radiusTop, BEAM.radiusBottom, BEAM.height, 48, 1, true)),
    keep(
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: ringColor }, uGlow: glowU, uTime: time },
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    ),
  );
  beam.name = "portrait-beam";
  beam.position.y = BEAM.height / 2;
  beam.renderOrder = LAYER_RENDER_ORDER - 3;
  group.add(beam);

  const ringMat = keep(
    new THREE.MeshBasicMaterial({
      color: ringColor,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  const ring = new THREE.Mesh(keep(new THREE.RingGeometry(RING.inner, RING.outer, 64)), ringMat);
  ring.name = "portrait-ring";
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.004;
  ring.renderOrder = LAYER_RENDER_ORDER - 4;
  group.add(ring);

  const pool = new THREE.Mesh(
    keep(new THREE.CircleGeometry(RING.inner, 48)),
    keep(
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: ringColor }, uGlow: glowU },
        vertexShader: PLAIN_VERT,
        fragmentShader: POOL_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    ),
  );
  pool.name = "portrait-pool";
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.003;
  pool.renderOrder = LAYER_RENDER_ORDER - 5;
  group.add(pool);

  // ---- Hit target and spark anchor ----
  const hitHeight = IMAGE_CENTRE_Y + PLANE_H / 2;
  const hitTarget = new THREE.Mesh(keep(new THREE.CylinderGeometry(HIT_RADIUS, HIT_RADIUS, hitHeight, 16, 1)), keep(new THREE.MeshBasicMaterial()));
  hitTarget.visible = false;
  hitTarget.name = "avatar-hit";
  hitTarget.position.y = hitHeight / 2;
  group.add(hitTarget);

  const sparkAnchor = new THREE.Object3D();
  sparkAnchor.name = "spark-anchor";
  sparkAnchor.position.set(SPARK_OFFSET.x, SPARK_OFFSET.y, SPARK_OFFSET.z);
  turn.add(sparkAnchor);

  // ---- State ----
  let spot: FloorPoint = cleanSpot(opts.spot) ?? { x: 0, z: -1 };
  let target: FloorPoint = { ...spot };
  let t = 0;
  let glowLevel = glowU.value;
  group.position.set(spot.x, 0, spot.z);
  turn.rotation.y = faceYaw(spot, { x: 0, z: 0 });

  return {
    group,
    hitTarget,
    sparkAnchor,
    update(dt, mood, level, text, viewer) {
      const step = dt > 0 && Number.isFinite(dt) ? dt : 0;
      t += step;
      time.value = t;

      const f = face.update(step, mood, level, text);
      const o = layerOpacities(f);
      for (const layer of CHARACTER_LAYERS) if (layer !== "base") opacity[layer].value = o[layer];

      spot = glideStep(spot, target, step);
      group.position.set(spot.x, 0, spot.z);
      turn.rotation.y = easeAngle(turn.rotation.y, faceYaw(spot, viewer ?? { x: 0, z: 0 }), step, TURN_RATE);

      float.position.y = floatY(t);
      const pose = bodyPose(f);
      pivot.position.y = pose.y;
      pivot.rotation.z = pose.rotZ;
      pivot.scale.setScalar(pose.scale);

      glowLevel += (glowFor(mood, level, t) - glowLevel) * (1 - Math.exp(-GLOW_RATE * step));
      glowU.value = glowLevel;
      // The ring pulses, brighter as the glow rises.
      ringMat.opacity = Math.min(1, glowLevel * (1.05 + 0.3 * Math.sin(2.4 * t)));
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
    cheer() {
      face.cheer();
    },
    setAnisotropy(n) {
      for (const tex of textures) {
        const next = Math.max(1, n);
        if (tex.anisotropy === next) continue;
        tex.anisotropy = next;
        // A texture still loading has no image yet; it uploads with this anisotropy when it arrives.
        if (tex.image) tex.needsUpdate = true;
      }
    },
    dispose() {
      group.removeFromParent();
      for (const d of disposables.splice(0)) d.dispose();
    },
  };
}
