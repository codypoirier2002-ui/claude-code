// Panorama scenes (§8.7): the equirectangular shader that runs on the clock
// sky's radius-60 sphere, the off-main-thread loader, and the switcher whose
// ticket counter drops stale loads. The maths the shader does is mirrored in
// the exported pure functions so it can be unit-tested without WebGL.

import * as THREE from "three";
import type { Environment } from "../core/environments";

const TAU = Math.PI * 2;
/** Anisotropic filtering, at most (§8.7). */
export const PANORAMA_MAX_ANISOTROPY = 8;

/** u = fract(atan(x, −z)/2π + .5 + yaw): the image centre straight ahead (−Z), the wrap seam behind. */
export function panoramaU(x: number, z: number, yaw = 0): number {
  const u = Math.atan2(x, -z) / TAU + 0.5 + yaw;
  return u - Math.floor(u);
}

/** v = clamp(horizon + asin(y)/π, .001, .999), 0 at the bottom of the image (it is uploaded flipped). */
export function panoramaV(y: number, horizon: number): number {
  const v = horizon + Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI;
  return Math.max(0.001, Math.min(0.999, v));
}

/** The panorama coordinates for a view direction (need not be normalised). */
export function panoramaUv(dir: { x: number; y: number; z: number }, horizon: number, yaw = 0): { u: number; v: number } {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  return { u: panoramaU(dir.x / len, dir.z / len, yaw), v: panoramaV(dir.y / len, horizon) };
}

/**
 * How much of the mirrored lookup at 1 − u to blend in near the wrap:
 * t = clamp(1 − min(u, 1 − u)/seam, 0, 1), weight .5t². Zero when seam is 0.
 */
export function seamWeight(u: number, seam: number): number {
  if (!(seam > 0)) return 0;
  const t = Math.max(0, Math.min(1, 1 - Math.min(u, 1 - u) / seam));
  return 0.5 * t * t;
}

/**
 * The screen-space angle derivative the shader samples with: whichever of
 * atan(x, −z) and atan(−x, z) changes less across the pixel. One of the two
 * jumps by 2π at its own branch cut; the other is smooth there, so this removes
 * the one-pixel mip-level seam line.
 */
export function pickAngleGradient(
  a: { dx: number; dy: number },
  b: { dx: number; dy: number },
): { dx: number; dy: number } {
  return a.dx * a.dx + a.dy * a.dy <= b.dx * b.dx + b.dy * b.dy ? a : b;
}

const PANO_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// The texture has no colour space and the output is raw sRGB (§15.8).
const PANO_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uHorizon;
uniform float uSeam;
uniform float uYaw;
varying vec3 vDir;
const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;
void main() {
  vec3 d = normalize(vDir);
  float a1 = atan(d.x, -d.z);
  float a2 = atan(-d.x, d.z);
  float u = fract(a1 / TAU + 0.5 + uYaw);
  float v = clamp(uHorizon + asin(clamp(d.y, -1.0, 1.0)) / PI, 0.001, 0.999);
  // The smaller of the two angle derivatives: one of them jumps by 2π at its cut.
  vec2 g1 = vec2(dFdx(a1), dFdy(a1));
  vec2 g2 = vec2(dFdx(a2), dFdy(a2));
  vec2 ga = dot(g1, g1) <= dot(g2, g2) ? g1 : g2;
  vec2 gx = vec2(ga.x / TAU, dFdx(v));
  vec2 gy = vec2(ga.y / TAU, dFdy(v));
  vec3 c = textureGrad(uMap, vec2(u, v), gx, gy).rgb;
  if (uSeam > 0.0) {
    // Blend in the mirrored lookup near the wrap.
    float t = clamp(1.0 - min(u, 1.0 - u) / uSeam, 0.0, 1.0);
    vec3 c2 = textureGrad(uMap, vec2(1.0 - u, v), vec2(-gx.x, gx.y), vec2(-gy.x, gy.y)).rgb;
    c = mix(c, c2, 0.5 * t * t);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

/** The panorama shader for the sky sphere. */
export function createPanoramaMaterial(map: THREE.Texture, env: Pick<Environment, "horizon" | "seam">, yaw = 0): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uHorizon: { value: env.horizon },
      uSeam: { value: env.seam },
      uYaw: { value: yaw },
    },
    vertexShader: PANO_VERT,
    fragmentShader: PANO_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
  });
}

/** Repeat across the wrap, clamp at the poles, mipmapped trilinear, no colour space (§8.7). */
export function configurePanoramaTexture(tex: THREE.Texture, anisotropy: number): THREE.Texture {
  tex.flipY = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = Math.max(1, Math.min(PANORAMA_MAX_ANISOTROPY, anisotropy));
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Loads a panorama through ImageBitmapLoader, so decoding happens off the main
 * thread. The bitmap is flipped while decoding (`imageOrientation: "flipY"`),
 * so the texture keeps `flipY = false`; disposing the texture closes the bitmap.
 */
export function loadPanoramaTexture(url: string, anisotropy: number): Promise<THREE.Texture> {
  const loader = new THREE.ImageBitmapLoader();
  loader.setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" });
  return loader.loadAsync(url).then((bitmap: ImageBitmap) => {
    const tex = configurePanoramaTexture(new THREE.Texture(bitmap), anisotropy);
    tex.addEventListener("dispose", () => bitmap.close());
    return tex;
  });
}

/** A ticket counter: only the latest ticket is current, so stale async work can be dropped. */
export function createTicketCounter(): { next(): number; isCurrent(ticket: number): boolean } {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (ticket) => ticket === latest,
  };
}

export interface PanoramaSwitcherDeps<T> {
  /** Fetch and decode one panorama (`env.image`). */
  load(env: Environment): Promise<T>;
  /** Put a loaded panorama up (and its lights and particles). */
  showPanorama(env: Environment, loaded: T): void;
  /** The clock sky, stars and floor (and the clock lights and particles). */
  showClock(): void;
  /** A load that finished after a newer request, or that is being replaced: free it. */
  discard(loaded: T): void;
  /** A load failed; the clock sky is already back up. */
  failed(env: Environment): void;
}

export interface PanoramaSwitcher {
  /** Show this scene. Repeated calls for the scene already shown (or loading) do nothing. */
  set(env: Environment): Promise<void>;
  /** The id of the scene being shown or loaded, or null before the first set(). */
  current(): string | null;
}

/**
 * Scene switching with a ticket counter: every set() takes a ticket, and a load
 * whose ticket is no longer current is discarded instead of shown. A failed load
 * falls back to the clock sky and reports it.
 */
export function createPanoramaSwitcher<T>(deps: PanoramaSwitcherDeps<T>): PanoramaSwitcher {
  const tickets = createTicketCounter();
  let wanted: string | null = null;
  let shown: T | null = null;

  function replace(next: T | null): void {
    const old = shown;
    shown = next;
    if (old !== null && old !== next) deps.discard(old);
  }

  return {
    current: () => wanted,
    async set(env: Environment): Promise<void> {
      if (env.id === wanted) return;
      wanted = env.id;
      const ticket = tickets.next();
      if (!env.image) {
        deps.showClock();
        replace(null);
        return;
      }
      let loaded: T;
      try {
        loaded = await deps.load(env);
      } catch {
        if (!tickets.isCurrent(ticket)) return;
        wanted = null;
        deps.showClock();
        replace(null);
        deps.failed(env);
        return;
      }
      if (!tickets.isCurrent(ticket)) {
        deps.discard(loaded);
        return;
      }
      deps.showPanorama(env, loaded);
      replace(loaded);
    },
  };
}
